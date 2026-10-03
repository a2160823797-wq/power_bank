import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = stripTypeScriptTypes(
  await readFile(new URL('../lib/ntc-protocol.ts', import.meta.url), 'utf8'),
  { mode: 'strip' },
);
const {
  crc8,
  encodeSetTemperature,
  NtcFrameParser,
  NtcSerialSession,
  NtcTimeoutError,
  statusText,
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const savedDeviceSource = stripTypeScriptTypes(
  await readFile(new URL('../lib/serial-device.ts', import.meta.url), 'utf8'),
  { mode: 'strip' },
);
const { getSavedSerialPort, rememberSerialPort } = await import(
  `data:text/javascript;base64,${Buffer.from(savedDeviceSource).toString('base64')}`
);

function replyFrame(temperature, resistanceOhms = 10000, code = 102, status = 0) {
  const frame = new Uint8Array(12);
  const view = new DataView(frame.buffer);
  frame.set([0xaa, 0x81]);
  view.setInt16(2, temperature, true);
  view.setUint32(4, resistanceOhms, true);
  view.setUint16(8, code, true);
  frame[10] = status;
  frame[11] = crc8(frame.subarray(0, 11));
  return frame;
}

function outerFrame(channel, payload, validCrc = true) {
  const frame = Uint8Array.from([0xaa, channel, 0x08, payload.length & 0xff, payload.length >> 8, ...payload, 0]);
  let checksum = 0xff;
  for (const value of frame.subarray(2, -1)) {
    checksum ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 0x80 ? ((checksum << 1) ^ 0x07) & 0xff : (checksum << 1) & 0xff;
    }
  }
  frame[frame.length - 1] = validCrc ? checksum : checksum ^ 1;
  return frame;
}

class MockPort {
  controller;
  options;
  writes = [];
  readReleases = 0;
  writeReleases = 0;
  closeCount = 0;
  onWrite = () => {};

  constructor(onWrite = () => {}) {
    this.onWrite = onWrite;
    const input = new ReadableStream({
      start: (controller) => { this.controller = controller; },
    });
    const output = new WritableStream({
      write: async (bytes) => {
        this.writes.push(bytes.slice());
        await this.onWrite(bytes, this);
      },
    });
    this.readable = {
      getReader: () => {
        const reader = input.getReader();
        return {
          read: () => reader.read(),
          cancel: () => reader.cancel(),
          releaseLock: () => { this.readReleases += 1; reader.releaseLock(); },
        };
      },
    };
    this.writable = {
      getWriter: () => {
        const writer = output.getWriter();
        return {
          write: (bytes) => writer.write(bytes),
          abort: (error) => writer.abort(error),
          releaseLock: () => { this.writeReleases += 1; writer.releaseLock(); },
        };
      },
    };
  }

  async open(options) { this.options = options; }
  async close() { this.closeCount += 1; }
  getInfo() { return {}; }
  push(bytes) { this.controller.enqueue(Uint8Array.from(bytes)); }
  unplug() { this.controller.error(new Error('USB 已拔出')); }
  finish() { this.controller.close(); }
}

function makeSession(port, onDisconnect) {
  const logs = [];
  const session = new NtcSerialSession(port, (direction, message) => logs.push({ direction, message }), onDisconnect);
  return { session, logs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('CRC-8/SMBUS known vector and signed little-endian command encoding', () => {
  assert.equal(crc8(new TextEncoder().encode('123456789')), 0xf4);
  assert.deepEqual([...encodeSetTemperature(25).subarray(0, 4)], [0xaa, 1, 0x19, 0]);
  assert.deepEqual([...encodeSetTemperature(-20).subarray(0, 4)], [0xaa, 1, 0xec, 0xff]);
  assert.equal(encodeSetTemperature(-20)[4], crc8(Uint8Array.from([0xaa, 1, 0xec, 0xff])));
  for (const temperature of [-26, 126, 1.5, NaN, Infinity]) {
    assert.throws(() => encodeSetTemperature(temperature), RangeError);
  }
});

test('parser preserves int16 temperature and uint32 resistance over 65535 ohms', () => {
  const [reply] = new NtcFrameParser().push(replyFrame(-25, 89710, 919));
  assert.equal(reply.temperature, -25);
  assert.equal(reply.resistanceOhms, 89710);
  assert.equal(reply.code, 919);
  assert.equal(reply.status, 0);
  assert.equal(reply.crc, 'PASS');
  assert.ok(reply.receivedAt > 0);
});

test('parser accepts every split boundary and single-byte fragments', () => {
  const frame = replyFrame(25);
  for (let split = 1; split < frame.length; split += 1) {
    const parser = new NtcFrameParser();
    assert.deepEqual(parser.push(frame.subarray(0, split)), []);
    assert.equal(parser.push(frame.subarray(split))[0].temperature, 25);
  }
  const parser = new NtcFrameParser();
  const results = [...frame].flatMap((byte) => parser.push(Uint8Array.of(byte)));
  assert.equal(results.length, 1);
});

test('parser resynchronizes noise, wrong commands, CRC failure and glued frames', () => {
  const errors = [];
  const parser = new NtcFrameParser((message) => errors.push(message));
  const bad = replyFrame(26);
  bad[11] ^= 1;
  const frames = Uint8Array.from([1, 2, 0xaa, 0x01, 3, 0xaa, ...bad, ...replyFrame(25), ...replyFrame(-25, 89710, 919)]);
  assert.deepEqual(parser.push(frames).map((reply) => reply.temperature), [25, -25]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /CRC/);
});

test('invalid parameter replies cannot become successful ACKs', () => {
  const errors = [];
  const parser = new NtcFrameParser((message) => errors.push(message));
  for (const frame of [
    replyFrame(25, 10000, 1024),
    replyFrame(25, 10000, 102, 5),
    replyFrame(25, 0),
    replyFrame(25, 4294967295),
    replyFrame(-26, 89710),
  ]) assert.deepEqual(parser.push(frame), []);
  assert.equal(errors.length, 5);
  assert.equal(parser.push(replyFrame(125, 534, 5)).length, 1);
});

test('all defined non-OK statuses remain valid replies', () => {
  const parser = new NtcFrameParser();
  for (const status of [1, 2, 3, 4]) {
    const [reply] = parser.push(replyFrame(25, 0, 0, status));
    assert.equal(reply.status, status);
    assert.notEqual(statusText(status), 'OK');
  }
});

test('battery and IAP payloads cannot spoof an NTC ACK, including split and invalid-CRC outer frames', () => {
  for (const channel of [0xbb, 0x55]) {
    for (const validCrc of [true, false]) {
      const parser = new NtcFrameParser();
      const frame = outerFrame(channel, replyFrame(25), validCrc);
      assert.deepEqual(parser.push(frame.subarray(0, 9)), []);
      assert.deepEqual(parser.push(frame.subarray(9)), []);
      assert.equal(parser.push(replyFrame(26))[0].temperature, 26);
    }
  }
});

test('session opens at 1500000 8N1 and handles fragmented feedback', async () => {
  const port = new MockPort((_, device) => {
    const frame = replyFrame(-25, 89710, 919);
    device.push(frame.subarray(0, 3));
    device.push(frame.subarray(3));
  });
  const { session, logs } = makeSession(port);
  await session.open();
  assert.equal(port.options.baudRate, 1500000);
  assert.equal(port.options.dataBits, 8);
  assert.equal(port.options.stopBits, 1);
  assert.equal(port.options.parity, 'none');
  const reply = await session.setTemperature(-25, 100);
  assert.equal(reply.resistanceOhms, 89710);
  assert.deepEqual(port.writes[0], encodeSetTemperature(-25));
  assert.ok(logs.some((entry) => entry.direction === 'TX'));
  assert.ok(logs.some((entry) => entry.direction === 'RX'));
  await session.close();
  assert.equal(port.readReleases, 1);
  assert.equal(port.writeReleases, 1);
  assert.equal(port.closeCount, 1);
});

test('starting a request preserves an in-progress battery frame boundary', async () => {
  const battery = outerFrame(0xbb, replyFrame(25));
  const port = new MockPort((_, device) => {
    device.push(battery.subarray(5));
  });
  const { session } = makeSession(port);
  await session.open();
  port.push(battery.subarray(0, 5));
  await tick();
  await assert.rejects(session.setTemperature(25, 10), NtcTimeoutError);
  await session.close();
});

test('CRC-invalid feedback never resolves a request; valid matching ACK does', async () => {
  const port = new MockPort((_, device) => {
    const bad = replyFrame(25);
    bad[11] ^= 1;
    device.push(bad);
    device.push(replyFrame(26));
    device.push(replyFrame(25));
  });
  const { session, logs } = makeSession(port);
  await session.open();
  assert.equal((await session.setTemperature(25, 100)).temperature, 25);
  assert.ok(logs.some((entry) => /CRC 校验失败/.test(entry.message)));
  assert.ok(logs.some((entry) => /无匹配请求/.test(entry.message)));
  await session.close();
});

test('CRC-only and parameter-invalid replies cause timeout, not a fabricated record', async () => {
  const port = new MockPort((_, device) => {
    const bad = replyFrame(25);
    bad[11] ^= 1;
    device.push(bad);
    device.push(replyFrame(25, 0));
  });
  const { session } = makeSession(port);
  await session.open();
  await assert.rejects(session.setTemperature(25, 10), NtcTimeoutError);
  await session.close();
});

test('session returns device failure instead of treating it as successful execution', async () => {
  const port = new MockPort((_, device) => device.push(replyFrame(25, 10000, 102, 3)));
  const { session } = makeSession(port);
  await session.open();
  assert.equal((await session.setTemperature(25, 100)).status, 3);
  await session.close();
});

test('concurrent commands are rejected; timeout releases request for retry', async () => {
  const port = new MockPort();
  const { session } = makeSession(port);
  await session.open();
  const first = assert.rejects(session.setTemperature(25, 10), NtcTimeoutError);
  await assert.rejects(session.setTemperature(26, 100), /尚未结束/);
  assert.equal(port.writes.length, 1);
  await first;
  port.onWrite = (_, device) => device.push(replyFrame(26));
  assert.equal((await session.setTemperature(26, 100)).temperature, 26);
  await session.close();
});

test('abort cancels ACK wait immediately and pre-aborted signals never transmit', async () => {
  const port = new MockPort();
  const { session } = makeSession(port);
  await session.open();
  const controller = new AbortController();
  const result = assert.rejects(session.setTemperature(25, 60000, controller.signal), { name: 'AbortError' });
  controller.abort();
  await result;
  const writeCount = port.writes.length;
  await assert.rejects(session.setTemperature(26, 100, controller.signal), { name: 'AbortError' });
  assert.equal(port.writes.length, writeCount);
  await session.close();
});

test('abort remains immediate while an asynchronous serial write is blocked', async () => {
  let releaseWrite;
  const port = new MockPort(() => new Promise((resolve) => { releaseWrite = resolve; }));
  const { session } = makeSession(port);
  await session.open();
  const controller = new AbortController();
  const result = assert.rejects(session.setTemperature(25, 60000, controller.signal), { name: 'AbortError' });
  await tick();
  controller.abort();
  await result;
  await assert.rejects(session.setTemperature(26, 100), /尚未结束/);
  releaseWrite();
  await tick();
  await session.close();
  assert.equal(port.writeReleases, 1);
});

test('hot unplug rejects waiting command, notifies once, and releases locks', async () => {
  const port = new MockPort();
  const disconnects = [];
  const { session } = makeSession(port, (error) => disconnects.push(error));
  await session.open();
  const result = assert.rejects(session.setTemperature(25, 60000), /USB 已拔出/);
  port.unplug();
  await result;
  await session.close();
  assert.equal(disconnects.length, 1);
  assert.equal(port.readReleases, 1);
  assert.equal(port.writeReleases, 1);
  assert.equal(port.closeCount, 1);
  await assert.rejects(session.setTemperature(25, 100), /未连接/);
});

test('normal stream termination also closes a disconnected port', async () => {
  const port = new MockPort();
  const disconnects = [];
  const { session } = makeSession(port, (error) => disconnects.push(error));
  await session.open();
  port.finish();
  await tick();
  await session.close();
  assert.equal(disconnects.length, 1);
  assert.equal(port.readReleases, 1);
  assert.equal(port.closeCount, 1);
});

test('explicit close rejects ACK wait, is idempotent, and does not report unplug', async () => {
  const port = new MockPort();
  const disconnects = [];
  const { session } = makeSession(port, (error) => disconnects.push(error));
  await session.open();
  const result = assert.rejects(session.setTemperature(25, 60000), /串口已断开/);
  await Promise.all([session.close(), session.close()]);
  await result;
  await session.close();
  assert.equal(disconnects.length, 0);
  assert.equal(port.readReleases, 1);
  assert.equal(port.closeCount, 1);
});

test('write failure clears timeout and does not leak a rejected ACK promise', async () => {
  const port = new MockPort(() => { throw new Error('写入失败'); });
  const { session } = makeSession(port);
  await session.open();
  await assert.rejects(session.setTemperature(25, 60000), /写入失败/);
  await session.close();
  assert.equal(port.writeReleases, 1);
});

test('invalid timeout or temperature does not write to the port', async () => {
  const port = new MockPort();
  const { session } = makeSession(port);
  await session.open();
  for (const timeout of [0, -1, NaN, Infinity, 0x80000000]) {
    await assert.rejects(session.setTemperature(25, timeout), RangeError);
  }
  await assert.rejects(session.setTemperature(-26, 100), RangeError);
  assert.equal(port.writes.length, 0);
  await session.close();
});

test('closing while port.open is pending cleans up after open completes', async () => {
  let releaseOpen;
  const port = new MockPort();
  port.open = () => new Promise((resolve) => { releaseOpen = resolve; });
  const { session } = makeSession(port);
  const opening = assert.rejects(session.open(), /连接已取消/);
  const closing = session.close();
  releaseOpen();
  await Promise.all([opening, closing]);
  assert.equal(port.closeCount, 1);
  assert.equal(port.readReleases, 0);
  await assert.rejects(session.setTemperature(25, 100), /未连接/);
});

test('a rejected port.open does not close a port this session never acquired', async () => {
  const port = new MockPort();
  port.open = async () => { throw new Error('端口已被其他会话占用'); };
  const { session } = makeSession(port);
  await assert.rejects(session.open(), /其他会话占用/);
  await session.close();
  assert.equal(port.closeCount, 0);
});

test('port.close errors propagate and retain ownership until a successful retry', async () => {
  const port = new MockPort();
  const { session, logs } = makeSession(port);
  await session.open();
  port.close = async () => {
    port.closeCount += 1;
    if (port.closeCount === 1) throw new Error('设备仍被锁定');
  };
  await assert.rejects(session.close(), /设备仍被锁定/);
  await assert.rejects(session.open(), /正在切换状态/);
  await assert.rejects(session.setTemperature(25, 100), /未连接/);
  assert.ok(logs.some((entry) => /设备仍被锁定/.test(entry.message)));
  await session.close();
  await session.close();
  assert.equal(port.closeCount, 2);
  assert.equal(port.readReleases, 1);
});

test('failed initialization plus failed cleanup remains retryable without an open/close deadlock', async () => {
  const port = new MockPort();
  port.writable = null;
  port.close = async () => {
    port.closeCount += 1;
    if (port.closeCount === 1) throw new Error('关闭失败，请重试');
  };
  const { session } = makeSession(port);
  await assert.rejects(session.open(), /关闭失败/);
  await session.close();
  assert.equal(port.closeCount, 2);
});

function savedDeviceStorage(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const data = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  });
  return data;
}

const rememberedPort = (info) => ({ getInfo: () => info });
const automaticSerial = (ports) => ({
  async getPorts() {
    return ports;
  },
  async requestPort() {
    assert.fail('automatic connection must not show the device picker');
  },
});

test('a remembered device reconnects using only its uniquely matching authorized port', async (t) => {
  savedDeviceStorage(t);
  const port = rememberedPort({ usbVendorId: 0x10c4, usbProductId: 0xea60 });
  rememberSerialPort('ntc', port);
  const serial = automaticSerial([
    rememberedPort({ usbVendorId: 0x1a86, usbProductId: 0x7523 }),
    port,
  ]);
  assert.equal(await getSavedSerialPort(serial, 'ntc'), port);
});

test('unseen or damaged device records do not enumerate or request ports', async (t) => {
  const data = savedDeviceStorage(t);
  const serial = automaticSerial([]);
  serial.getPorts = async () =>
    assert.fail('no saved device must not enumerate ports');
  for (const value of [undefined, '', '{broken', 'null', '25']) {
    if (value === undefined) data.delete('ntc');
    else data.set('ntc', value);
    assert.equal(await getSavedSerialPort(serial, 'ntc'), null);
  }
});

test('a missing or no-longer-authorized device stays disconnected without a picker', async (t) => {
  savedDeviceStorage(t);
  rememberSerialPort(
    'ntc',
    rememberedPort({ usbVendorId: 1, usbProductId: 2 }),
  );
  assert.equal(await getSavedSerialPort(automaticSerial([]), 'ntc'), null);
  assert.equal(
    await getSavedSerialPort(
      automaticSerial([rememberedPort({ usbVendorId: 1, usbProductId: 3 })]),
      'ntc',
    ),
    null,
  );
});

test('two identical authorized adapters cannot select an arbitrary device', async (t) => {
  savedDeviceStorage(t);
  const info = { usbVendorId: 1, usbProductId: 2 };
  rememberSerialPort('ntc', rememberedPort(info));
  assert.equal(
    await getSavedSerialPort(
      automaticSerial([rememberedPort(info), rememberedPort(info)]),
      'ntc',
    ),
    null,
  );
});

test('battery and NTC device records remain independent, including Bluetooth identities', async (t) => {
  savedDeviceStorage(t);
  const battery = rememberedPort({ usbVendorId: 1, usbProductId: 2 });
  const ntc = rememberedPort({ bluetoothServiceClassId: 'ntc-device' });
  rememberSerialPort('battery', battery);
  rememberSerialPort('ntc', ntc);
  const serial = automaticSerial([
    battery,
    rememberedPort({ bluetoothServiceClassId: 'other-device' }),
    ntc,
  ]);
  assert.equal(await getSavedSerialPort(serial, 'battery'), battery);
  assert.equal(await getSavedSerialPort(serial, 'ntc'), ntc);
});

test('blocked local storage preserves manual connection and suppresses automatic selection', async (t) => {
  savedDeviceStorage(t);
  localStorage.getItem = () => {
    throw new Error('storage disabled');
  };
  localStorage.setItem = () => {
    throw new Error('storage disabled');
  };
  const port = rememberedPort({ usbVendorId: 1, usbProductId: 2 });
  assert.doesNotThrow(() => rememberSerialPort('ntc', port));
  assert.equal(await getSavedSerialPort(automaticSerial([port]), 'ntc'), null);
});
