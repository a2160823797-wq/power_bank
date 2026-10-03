import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async (path) =>
  ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { SharedSerialTransport } = await import(
  moduleUrl(await compile('../lib/shared-serial.ts'))
);
const configUrl = moduleUrl(await compile('../lib/iap-config.ts'));
const iapUrl = moduleUrl(
  (await compile('../lib/iap-protocol.ts')).replace(
    /(['"])\.\/iap-config\1/,
    JSON.stringify(configUrl),
  ),
);
const { BatterySerialSession, batteryFrame } = await import(
  moduleUrl(
    (await compile('../lib/battery-protocol.ts')).replace(
      /(['"])\.\/iap-protocol\1/,
      JSON.stringify(iapUrl),
    ),
  )
);
const { NtcSerialSession, crc8 } = await import(
  moduleUrl(await compile('../lib/ntc-protocol.ts'))
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const options = {
  baudRate: 1500000,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  bufferSize: 65536,
};

class MockPort {
  readable = null;
  writable = null;
  opened = false;
  openCount = 0;
  closeCount = 0;
  readLocks = 0;
  writeLocks = 0;
  readReleases = 0;
  writeReleases = 0;
  readCancels = 0;
  readingLocked = false;
  writingLocked = false;
  activeWrites = 0;
  writes = [];
  closeFailures = 0;
  openError = null;
  beforeOpen = async () => {};
  onWrite = async () => {};
  controller;

  async open(receivedOptions) {
    this.openCount += 1;
    assert.deepEqual(receivedOptions, options);
    assert.equal(this.opened, false);
    await this.beforeOpen();
    if (this.openError) throw this.openError;
    this.opened = true;
    const stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.readable = {
      getReader: () => {
        this.readLocks += 1;
        this.readingLocked = true;
        const reader = stream.getReader();
        return {
          read: () => reader.read(),
          cancel: async () => {
            this.readCancels += 1;
            await reader.cancel();
          },
          releaseLock: () => {
            this.readReleases += 1;
            reader.releaseLock();
            this.readingLocked = false;
          },
        };
      },
    };
    this.writable = {
      getWriter: () => {
        assert.equal(this.writingLocked, false);
        this.writeLocks += 1;
        this.writingLocked = true;
        return {
          write: async (bytes) => {
            assert.equal(
              this.activeWrites,
              0,
              'native frame writes must not overlap',
            );
            this.activeWrites += 1;
            this.writes.push(bytes.slice());
            try {
              await this.onWrite(bytes);
            } finally {
              this.activeWrites -= 1;
            }
          },
          releaseLock: () => {
            assert.equal(this.activeWrites, 0);
            this.writeReleases += 1;
            this.writingLocked = false;
          },
        };
      },
    };
  }

  async close() {
    this.closeCount += 1;
    assert.equal(this.activeWrites, 0);
    assert.equal(this.readingLocked, false);
    assert.equal(this.writingLocked, false);
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('关闭设备失败');
    }
    this.opened = false;
    this.readable = null;
    this.writable = null;
  }

  getInfo() {
    return { usbVendorId: 0x0483, usbProductId: 0x5740 };
  }
  receive(bytes) {
    this.controller.enqueue(Uint8Array.from(bytes));
  }
}

async function channels(transport, count = 2) {
  const result = Array.from({ length: count }, () => transport.createChannel());
  await Promise.all(result.map((channel) => channel.open(options)));
  return result;
}

test('all channels share one physical open, reader lock and writer lock', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  await Promise.all([transport.open(), transport.open()]);
  const [first, second] = await channels(transport);
  assert.deepEqual(first.getInfo(), port.getInfo());
  const firstReader = first.readable.getReader();
  const secondReader = second.readable.getReader();
  const firstWriter = first.writable.getWriter();
  const secondWriter = second.writable.getWriter();
  await Promise.all([
    firstWriter.write(Uint8Array.of(1)),
    secondWriter.write(Uint8Array.of(2)),
  ]);
  assert.equal(port.openCount, 1);
  assert.equal(port.readLocks, 1);
  assert.equal(port.writeLocks, 1);
  firstWriter.releaseLock();
  secondWriter.releaseLock();
  await first.close();
  firstReader.releaseLock();
  assert.equal(port.closeCount, 0);
  assert.equal(transport.isOpen, true);
  await second.close();
  secondReader.releaseLock();
  assert.equal(port.closeCount, 0);
  await transport.close();
  assert.equal(port.closeCount, 1);
  assert.equal(port.readReleases, 1);
  assert.equal(port.writeReleases, 1);
});

test('fanout preserves arbitrary split and coalesced chunks with separate buffers', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.readable.getReader();
  const b = second.readable.getReader();
  port.receive([0xaa]);
  port.receive([0x81, 25, 0, 0xaa, 0xbb]);
  port.receive([8, 2, 0]);
  for (const expected of [[0xaa], [0x81, 25, 0, 0xaa, 0xbb], [8, 2, 0]]) {
    const left = await a.read();
    const right = await b.read();
    assert.deepEqual([...left.value], expected);
    assert.deepEqual([...right.value], expected);
    left.value.fill(0);
    assert.deepEqual([...right.value], expected);
  }
  await transport.close();
  a.releaseLock();
  b.releaseLock();
});

test('an unopened channel does not retain earlier physical data', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  const channel = transport.createChannel();
  await assert.rejects(channel.open(options), /设备连接已关闭/);
  await transport.open();
  port.receive([1, 2]);
  await tick();
  await channel.open(options);
  const reader = channel.readable.getReader();
  const next = reader.read();
  port.receive([3, 4]);
  assert.deepEqual([...(await next).value], [3, 4]);
  await transport.close();
  reader.releaseLock();
});

test('closing or cancelling one channel leaves another reader and physical port active', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.readable.getReader();
  const b = second.readable.getReader();
  const pending = a.read();
  await a.cancel();
  assert.deepEqual(await pending, { done: true });
  await first.close();
  await first.close();
  a.releaseLock();
  const next = b.read();
  port.receive([7]);
  assert.deepEqual([...(await next).value], [7]);
  assert.equal(port.readCancels, 0);
  assert.equal(port.closeCount, 0);
  await transport.close();
  b.releaseLock();
});

test('whole frames from concurrent channel writers are serialized and copied', async () => {
  const port = new MockPort();
  const gate = deferred();
  const started = deferred();
  port.onWrite = async (bytes) => {
    if (bytes[1] === 0xbb) {
      started.resolve();
      await gate.promise;
    }
  };
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.writable.getWriter();
  const b = second.writable.getWriter();
  const frame = Uint8Array.of(0xaa, 0xbb, 8, 0, 0, 1);
  const left = a.write(frame);
  const right = b.write(Uint8Array.of(0xaa, 1, 25, 0, 7));
  frame.fill(0);
  await started.promise;
  assert.equal(port.writes.length, 1);
  gate.resolve();
  await Promise.all([left, right]);
  assert.deepEqual([...port.writes[0]], [0xaa, 0xbb, 8, 0, 0, 1]);
  assert.deepEqual([...port.writes[1]], [0xaa, 1, 25, 0, 7]);
  a.releaseLock();
  b.releaseLock();
  await transport.close();
});

test('releasing a channel writer does not discard its already accepted frame', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [channel] = await channels(transport, 1);
  const writer = channel.writable.getWriter();
  const pending = writer.write(Uint8Array.of(5));
  writer.releaseLock();
  await pending;
  assert.deepEqual([...port.writes[0]], [5]);
  await assert.rejects(writer.write(Uint8Array.of(6)), /写入锁已释放/);
  await transport.close();
});

test('physical close waits for the current frame and discards queued frames', async () => {
  const port = new MockPort();
  const gate = deferred();
  const started = deferred();
  port.onWrite = async () => {
    started.resolve();
    await gate.promise;
  };
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.writable.getWriter();
  const b = second.writable.getWriter();
  const left = a.write(Uint8Array.of(1));
  const right = b.write(Uint8Array.of(2));
  const rightFailure = assert.rejects(right, /设备连接已关闭/);
  await started.promise;
  const closing = transport.close();
  await tick();
  assert.equal(port.closeCount, 0);
  assert.equal(transport.isOpen, false);
  gate.resolve();
  await Promise.all([left, rightFailure, closing]);
  assert.equal(port.writes.length, 1);
  assert.equal(port.closeCount, 1);
  a.releaseLock();
  b.releaseLock();
});

test('channel close waits only its writes without closing the physical port', async () => {
  const port = new MockPort();
  const gate = deferred();
  const started = deferred();
  port.onWrite = async () => {
    started.resolve();
    await gate.promise;
  };
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [channel] = await channels(transport, 1);
  const writer = channel.writable.getWriter();
  const pending = writer.write(Uint8Array.of(1));
  await started.promise;
  let closed = false;
  const closing = channel.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([pending, closing]);
  assert.equal(port.closeCount, 0);
  writer.releaseLock();
  await transport.close();
});

test('aborting a virtual writer cancels its queued frame without affecting other channels', async () => {
  const port = new MockPort();
  const gate = deferred();
  const started = deferred();
  port.onWrite = async (bytes) => {
    if (bytes[0] === 1) {
      started.resolve();
      await gate.promise;
    }
  };
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.writable.getWriter();
  const b = second.writable.getWriter();
  const left = a.write(Uint8Array.of(1));
  const right = b.write(Uint8Array.of(2));
  const rightFailure = assert.rejects(right, /停止温度请求/);
  await started.promise;
  const aborting = b.abort(new Error('停止温度请求'));
  gate.resolve();
  await Promise.all([left, rightFailure, aborting]);
  await a.write(Uint8Array.of(3));
  assert.deepEqual(
    port.writes.map((frame) => [...frame]),
    [[1], [3]],
  );
  assert.equal(transport.isOpen, true);
  a.releaseLock();
  b.releaseLock();
  await transport.close();
});

test('a failed physical close retains ownership and is retryable', async () => {
  const port = new MockPort();
  port.closeFailures = 1;
  const transport = new SharedSerialTransport(port);
  await transport.open();
  await channels(transport);
  await assert.rejects(transport.close(), /关闭设备失败/);
  assert.equal(transport.isOpen, false);
  assert.equal(port.opened, true);
  await assert.rejects(transport.open(), /设备连接已关闭/);
  await transport.close();
  assert.equal(port.closeCount, 2);
  assert.equal(port.opened, false);
  assert.equal(port.readReleases, 1);
  assert.equal(port.writeReleases, 1);
  await transport.close();
  assert.equal(port.closeCount, 2);
});

test('physical read failure rejects both pending readers and notifies once', async () => {
  const port = new MockPort();
  const errors = [];
  const transport = new SharedSerialTransport(port, (error) =>
    errors.push(error),
  );
  await transport.open();
  const [first, second] = await channels(transport);
  const a = first.readable.getReader();
  const b = second.readable.getReader();
  const left = assert.rejects(a.read(), /USB 已拔出/);
  const right = assert.rejects(b.read(), /USB 已拔出/);
  port.controller.error(new Error('USB 已拔出'));
  await Promise.all([left, right]);
  await transport.close();
  assert.equal(errors.length, 1);
  assert.equal(transport.isOpen, false);
  assert.equal(port.closeCount, 1);
  await assert.rejects(a.read(), /USB 已拔出/);
  a.releaseLock();
  b.releaseLock();
});

test('unexpected physical EOF is a disconnect, normal close is not', async () => {
  const port = new MockPort();
  const errors = [];
  const transport = new SharedSerialTransport(port, (error) =>
    errors.push(error),
  );
  await transport.open();
  const [channel] = await channels(transport, 1);
  const reader = channel.readable.getReader();
  const failed = assert.rejects(reader.read(), /设备连接已断开/);
  port.controller.close();
  await failed;
  await transport.close();
  reader.releaseLock();
  assert.equal(errors.length, 1);
  await transport.open();
  await transport.close();
  assert.equal(errors.length, 1);
});

test('closing during physical open waits for open and releases without locking streams', async () => {
  const port = new MockPort();
  const gate = deferred();
  port.beforeOpen = () => gate.promise;
  const transport = new SharedSerialTransport(port);
  const opening = transport.open();
  const failed = assert.rejects(opening, /设备连接已关闭/);
  const closing = transport.close();
  await tick();
  assert.equal(port.closeCount, 0);
  gate.resolve();
  await Promise.all([failed, closing]);
  assert.equal(port.openCount, 1);
  assert.equal(port.readLocks, 0);
  assert.equal(port.writeLocks, 0);
  assert.equal(port.closeCount, 1);
  assert.equal(transport.isOpen, false);
});

test('a native open rejection does not close an unowned port and can be retried', async () => {
  const port = new MockPort();
  port.openError = new Error('其他程序已占用');
  const transport = new SharedSerialTransport(port);
  await assert.rejects(transport.open(), /其他程序已占用/);
  await transport.close();
  assert.equal(port.closeCount, 0);
  port.openError = null;
  await transport.open();
  assert.equal(transport.isOpen, true);
  await transport.close();
});

test('physical write failure stops all channels and releases native resources', async () => {
  const port = new MockPort();
  const errors = [];
  port.onWrite = async () => {
    throw new Error('设备写入失败');
  };
  const transport = new SharedSerialTransport(port, (error) =>
    errors.push(error),
  );
  await transport.open();
  const [first, second] = await channels(transport);
  const reader = second.readable.getReader();
  const writer = first.writable.getWriter();
  const pendingRead = assert.rejects(reader.read(), /设备写入失败/);
  await assert.rejects(writer.write(Uint8Array.of(1)), /设备写入失败/);
  await pendingRead;
  await transport.close();
  assert.equal(errors.length, 1);
  assert.equal(port.closeCount, 1);
  reader.releaseLock();
  writer.releaseLock();
});

test('reader and writer locks belong to each channel and can be reacquired', async () => {
  const port = new MockPort();
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const [channel] = await channels(transport, 1);
  const a = channel.readable.getReader();
  const b = channel.writable.getWriter();
  assert.throws(() => channel.readable.getReader(), /读取已被锁定/);
  assert.throws(() => channel.writable.getWriter(), /写入已被锁定/);
  a.releaseLock();
  b.releaseLock();
  const c = channel.readable.getReader();
  const d = channel.writable.getWriter();
  await channel.close();
  c.releaseLock();
  d.releaseLock();
  await channel.open(options);
  const reader = channel.readable.getReader();
  port.receive([4]);
  assert.deepEqual([...(await reader.read()).value], [4]);
  await transport.close();
  reader.releaseLock();
});

function ntcFrame(command, temperatureOrNonce) {
  const frame =
    command === 0x82
      ? Uint8Array.of(0xaa, 0x82, 0x4e, 0x54, 0x43, 0x31, 1, 0, 0, 0, 0, 0)
      : Uint8Array.of(0xaa, 0x81, 0, 0, 0x10, 0x27, 0, 0, 102, 0, 0, 0);
  new DataView(frame.buffer).setInt16(
    command === 0x82 ? 8 : 2,
    temperatureOrNonce,
    true,
  );
  frame[11] = crc8(frame.subarray(0, 11));
  return frame;
}

function identityFrame() {
  const model = Buffer.from('SC2016');
  const code = Buffer.from('BATTERY-001');
  return batteryFrame(
    0x08,
    Uint8Array.from([model.length, ...model, code.length, ...code]),
  );
}

test('real battery and NTC sessions parse mixed RX and write independently over one port', async () => {
  const port = new MockPort();
  const states = [];
  const failures = [];
  port.onWrite = async (bytes) => {
    let reply;
    if (bytes[1] === 0xbb && bytes[2] === 8) reply = identityFrame();
    if (bytes[1] === 2)
      reply = ntcFrame(
        0x82,
        new DataView(bytes.buffer, bytes.byteOffset).getUint16(2, true),
      );
    if (bytes[1] === 1) {
      const temperature = new DataView(bytes.buffer, bytes.byteOffset).getInt16(
        2,
        true,
      );
      const telemetry = batteryFrame(0x02, Uint8Array.of(0, 250, 0));
      reply = Uint8Array.from([
        ...telemetry,
        ...ntcFrame(0x81, temperature),
        ...identityFrame(),
      ]);
    }
    if (reply) {
      port.receive(reply.subarray(0, 1));
      port.receive(reply.subarray(1, 8));
      port.receive(reply.subarray(8));
    }
  };
  const transport = new SharedSerialTransport(port);
  await transport.open();
  const battery = new BatterySerialSession(transport.createChannel(), {
    onData: (state) => states.push(state),
    onDisconnect: () => {},
    onError: (message) => failures.push(message),
  });
  const ntc = new NtcSerialSession(
    transport.createChannel(),
    () => {},
    () => {},
  );
  await Promise.all([battery.open(), ntc.open()]);
  const [batteryIdentity, ntcIdentity] = await Promise.all([
    battery.identify(1000),
    ntc.identify(1000),
  ]);
  assert.equal(batteryIdentity.model, 'SC2016');
  assert.equal(ntcIdentity.major, 1);
  const result = await ntc.setTemperature(-20, 1000);
  assert.equal(result.temperature, -20);
  assert.equal(result.resistanceOhms, 10000);
  assert.equal(states.at(-1).temperatureC, 25);
  assert.deepEqual(failures, []);
  assert.equal(port.openCount, 1);
  assert.equal(port.readLocks, 1);
  assert.equal(port.writeLocks, 1);
  await ntc.close();
  assert.equal(port.closeCount, 0);
  assert.equal(battery.isOpen, true);
  await battery.identify(1000);
  await battery.close();
  await transport.close();
  assert.equal(port.closeCount, 1);
});
