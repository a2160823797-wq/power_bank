import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 和 IAP 回归测试一样，直接运行真实 TypeScript 模块。
const compile = async (path) =>
  ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const configUrl = moduleUrl(await compile('../lib/iap-config.ts'));
const iapUrl = moduleUrl(
  (await compile('../lib/iap-protocol.ts')).replace(
    /(['"])\.\/iap-config\1/,
    JSON.stringify(configUrl),
  ),
);
const {
  BatterySerialSession,
  BatteryIdentityTimeoutError,
  BatteryFrameParser,
  batteryFrame,
  createBatteryState,
} = await import(
  moduleUrl(
    (await compile('../lib/battery-protocol.ts')).replace(
      /(['"])\.\/iap-protocol\1/,
      JSON.stringify(iapUrl),
    ),
  )
);
const { crc8 } = await import(iapUrl);

const tick = () => new Promise((resolve) => setImmediate(resolve));
const data = (values) => Uint8Array.from(values);
const frame = (command, values) => batteryFrame(command, data(values));
const u16 = (value) => [value & 255, (value >> 8) & 255];
const u32 = (value) => [
  value & 255,
  (value >>> 8) & 255,
  (value >>> 16) & 255,
  (value >>> 24) & 255,
];
const timestamp = Date.UTC(2026, 9, 2, 12, 34, 56) / 1000;
const historyRecord = ({
  id = 1,
  type = 0,
  cell = 1,
  state = 2,
  value = 4450,
  time = timestamp,
} = {}) => [1, ...u32(id), type, cell, state, ...u32(value), ...u32(time)];

class MockPort {
  options = null;
  queued = [];
  pending = null;
  writes = [];
  closed = false;
  readsReleased = 0;
  writesReleased = 0;
  closeCount = 0;
  openCount = 0;
  failClose = false;
  onWrite = async () => {};
  onOpen = async () => {};
  readable = {
    getReader: () => ({
      read: () => {
        if (this.queued.length)
          return Promise.resolve({ done: false, value: this.queued.shift() });
        if (this.closed) return Promise.resolve({ done: true });
        return new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
        });
      },
      cancel: async () => this.finish(),
      releaseLock: () => {
        this.readsReleased += 1;
      },
    }),
  };
  writable = {
    getWriter: () => ({
      write: async (bytes) => {
        assert.equal(this.closed, false, 'closed port must never be written');
        this.writes.push(bytes.slice());
        await this.onWrite(bytes);
      },
      releaseLock: () => {
        this.writesReleased += 1;
      },
    }),
  };
  async open(options) {
    this.openCount += 1;
    this.options = options;
    await this.onOpen();
  }
  async close() {
    this.closeCount += 1;
    if (this.failClose) throw new Error('close failed');
    assert.ok(this.readsReleased || !this.writesReleased);
    this.finish();
  }
  getInfo() {
    return {};
  }
  push(bytes) {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve({ done: false, value: data(bytes) });
    } else this.queued.push(data(bytes));
  }
  finish(error) {
    this.closed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      if (error) pending.reject(error);
      else pending.resolve({ done: true });
    }
  }
}

async function fixture(t, port = new MockPort()) {
  const updates = [];
  const errors = [];
  let disconnects = 0;
  const session = new BatterySerialSession(port, {
    onData: (state) => updates.push(state),
    onError: (message) => errors.push(message),
    onDisconnect: () => {
      assert.equal(port.closeCount, 1);
      disconnects += 1;
    },
  });
  await session.open();
  t.after(() => session.close());
  return {
    port,
    session,
    updates,
    errors,
    get state() {
      return updates.at(-1);
    },
    get disconnects() {
      return disconnects;
    },
    async send(command, payload) {
      port.push(frame(command, payload));
      await tick();
    },
  };
}

test('fixed AA BB GET_DATA frame uses reference CRC8 and serial configuration', async (t) => {
  assert.deepEqual([...frame(2, [0])], [0xaa, 0xbb, 0x02, 0x01, 0, 0, 0x96]);
  const f = await fixture(t);
  assert.deepEqual(f.port.options, {
    baudRate: 1500000,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    bufferSize: 65536,
  });
  assert.deepEqual(f.state, createBatteryState());
});

test('fragmentation, consecutive frames, CRC errors, IAP bytes and noise resynchronize', () => {
  const received = [];
  const parser = new BatteryFrameParser((cmd, payload) =>
    received.push([cmd, [...payload]]),
  );
  const first = frame(0x82, [0, ...u16(-123)]);
  const broken = frame(2, [1, ...u16(7000)]);
  broken[broken.length - 1] ^= 1;
  const stream = data([
    1,
    2,
    0xaa,
    0xaa,
    0x55,
    0x02,
    1,
    0,
    0,
    0x96,
    ...first,
    ...broken,
    ...frame(2, [1, 0, 0]),
    ...frame(2, [2, ...u16(3700)]),
  ]);
  for (const byte of stream) parser.push(data([byte]));
  assert.deepEqual(received, [
    [2, [0, ...u16(-123)]],
    [2, [1, 0, 0]],
    [2, [2, ...u16(3700)]],
  ]);
});

test('impossible payload lengths resynchronize without waiting for a forged length', () => {
  const received = [];
  const parser = new BatteryFrameParser((cmd, payload) =>
    received.push([cmd, [...payload]]),
  );
  parser.push(
    data([0xaa, 0xbb, 0x08, 0x00, 0x02, 5, 1, 2, ...frame(2, [1, 0, 0])]),
  );
  parser.push(data([0xaa, 0xbb, 0x02, 0xff, 0xff, ...frame(2, [2, 0, 0])]));
  assert.deepEqual(received, [
    [2, [1, 0, 0]],
    [2, [2, 0, 0]],
  ]);
});

test('valid binary record containing an entire nested frame survives arbitrary fragmentation', () => {
  const outer = data(
    Buffer.from('AABB0A100001AABB0202000D023600000000F4BE6A31', 'hex'),
  );
  for (const chunkSize of [1, 2, 7, outer.length]) {
    const received = [];
    let invalid = 0;
    const parser = new BatteryFrameParser(
      (cmd, payload) => received.push([cmd, [...payload]]),
      () => {
        invalid += 1;
      },
    );
    for (let offset = 0; offset < outer.length; offset += chunkSize)
      parser.push(outer.slice(offset, offset + chunkSize));
    assert.deepEqual(received, [[0x0a, Array.from(outer.slice(5, -1))]]);
    assert.equal(invalid, 0);
  }
});

test('oversized ASCII field lengths recover at the next frame without scanning binary payloads', () => {
  const prefixes = [
    [0xaa, 0xbb, 2, 0x80, 0, 15],
    [0xaa, 0xbb, 2, 0x80, 0, 16, 0x32, 0x30],
    [0xaa, 0xbb, 8, 0x80, 0, 6, 0x41, 0x42],
    [0xaa, 0xbb, 8, 0x80, 0, 1, 0x41, 125, 0x42],
  ];
  for (const prefix of prefixes) {
    const received = [];
    const parser = new BatteryFrameParser((command, payload) =>
      received.push([command, [...payload]]),
    );
    parser.push(data([...prefix, ...frame(2, [0, 250, 0])]));
    assert.deepEqual(received, [[2, [0, 250, 0]]]);
  }
});

test('length-prefixed ASCII permits 255-byte fields but rejects embedded NUL without truncation', async (t) => {
  const f = await fixture(t);
  const model = Buffer.from('M'.repeat(255));
  const code = Buffer.from('C'.repeat(255));
  await f.send(8, [255, ...model, 255, ...code]);
  assert.equal(f.state.batteryModel, 'M'.repeat(255));
  assert.equal(f.state.batteryCode, 'C'.repeat(255));
  await f.send(8, [3, 0x41, 0, 0x42, 1, 0x43]);
  await f.send(8, [1, 0x41, 3, 0x42, 0, 0x43]);
  await f.send(2, [15, 0x41, 0, 0x42]);
  assert.equal(f.state.batteryModel, 'M'.repeat(255));
  assert.equal(f.state.batteryCode, 'C'.repeat(255));
  assert.equal(f.state.manufacturer, null);
});

test('signed negative temperature and genuine zero voltage are preserved', async (t) => {
  const f = await fixture(t);
  await f.send(0x82, [0, ...u16(-123)]);
  await f.send(2, [1, 0, 0]);
  await f.send(2, [3, 0, 0]);
  assert.equal(f.state.temperatureC, -12.3);
  assert.equal(f.state.totalVoltageMv, 0);
  assert.deepEqual(f.state.cellVoltagesMv, [null, 0]);
  assert.equal(f.state.cellCount, null);
  const count = f.updates.length;
  await f.send(2, [0, 1]);
  await f.send(2, [13, 0]);
  assert.equal(f.updates.length, count);
});

test('16 cell voltages replace legacy values and reject truncated or invalid counts', async (t) => {
  const f = await fixture(t);
  const values = Array.from({ length: 16 }, (_, i) => 3500 + i);
  await f.send(2, [0x12, 16, ...values.flatMap(u16)]);
  assert.equal(f.state.cellCount, 16);
  assert.deepEqual(f.state.cellVoltagesMv, values);
  await f.send(2, [0x12, 2, ...u16(3600)]);
  await f.send(2, [0x12, 17, ...values.flatMap(u16)]);
  assert.deepEqual(f.state.cellVoltagesMv, values);
  await f.send(2, [13, 1]);
  await f.send(2, [3, ...u16(0)]);
  assert.deepEqual(f.state.cellVoltagesMv, [3500]);
});

test('model, 255-byte encoding, manufacturer and production date remain untruncated', async (t) => {
  const f = await fixture(t);
  const model = Buffer.from('CELL-MODEL');
  const code = Buffer.from('A'.repeat(255));
  await f.send(0x88, [model.length, ...model, code.length, ...code]);
  assert.equal(f.state.batteryModel, 'CELL-MODEL');
  assert.equal(f.state.batteryCode, 'A'.repeat(255));
  await f.send(2, [15, ...Buffer.from('CELL CO')]);
  await f.send(2, [16, ...Buffer.from('20261002')]);
  assert.equal(f.state.manufacturer, 'CELL CO');
  assert.equal(f.state.productionDate, '20261002');
  await f.send(8, [2, 65, 66, 3, 65, 66]);
  assert.equal(f.state.batteryCode.length, 255);
});

test('RTC integer and calendar agree in Beijing time; zero remains unknown', async (t) => {
  const f = await fixture(t);
  await f.send(3, u32(timestamp));
  assert.equal(f.state.rtcUnixSeconds, timestamp - 28800);
  await f.send(0x83, [...u16(2026), 10, 2, 5, 12, 34, 56]);
  assert.equal(f.state.rtcUnixSeconds, timestamp - 28800);
  const count = f.updates.length;
  await f.send(3, [...u16(2026), 2, 30, 1, 0, 0, 0]);
  assert.equal(f.updates.length, count);
  await f.send(3, [0, 0, 0, 0]);
  assert.equal(f.state.rtcUnixSeconds, null);
});

test('history needs matching begin, distinct record IDs and end before complete', async (t) => {
  const f = await fixture(t);
  await f.send(0x0a, [0, ...u16(2)]);
  await f.send(0x0a, historyRecord());
  await f.send(0x8a, historyRecord());
  assert.equal(f.state.records.length, 1);
  assert.equal(f.state.historyStatus, 'receiving');
  await f.send(
    0x0a,
    historyRecord({ id: 2, type: 1, cell: 0, value: -120, time: 0 }),
  );
  await f.send(0x0a, [2, ...u16(2)]);
  assert.equal(f.state.historyStatus, 'complete');
  assert.deepEqual(f.state.records[1], {
    id: 2,
    type: 'overtemperature',
    cell: 0,
    state: 'charging',
    value: -120,
    timeUnixSeconds: null,
  });
  assert.equal(f.state.records[0].timeUnixSeconds, timestamp - 28800);
  await f.send(0x0a, historyRecord({ id: 3 }));
  assert.equal(f.state.historyStatus, 'incomplete');
  assert.equal(f.state.records.length, 3);
});

test('zero history only completes with matching begin/end, never missing response', async (t) => {
  const f = await fixture(t);
  assert.equal(f.state.historyStatus, 'unread');
  await f.session.requestHistory();
  assert.equal(f.state.historyStatus, 'receiving');
  assert.equal(f.state.lastReceivedAt, null);
  await f.send(0x0a, [2, 0, 0]);
  assert.equal(f.state.historyStatus, 'incomplete');
  await f.send(0x0a, [0, 0, 0]);
  await f.send(0x0a, [2, 0, 0]);
  assert.equal(f.state.historyStatus, 'complete');
  assert.equal(f.state.records.length, 0);
  const receivedAt = f.state.lastReceivedAt;
  await f.session.requestHistory();
  assert.equal(f.state.historyStatus, 'receiving');
  assert.equal(f.state.historyExpected, null);
  assert.equal(f.state.lastReceivedAt, receivedAt);
});

test('history count mismatch, malformed records and CRC corruption never claim completion', async (t) => {
  const f = await fixture(t);
  await f.send(0x0a, [0, 2, 0]);
  await f.send(0x0a, historyRecord());
  await f.send(0x0a, [2, 2, 0]);
  assert.equal(f.state.historyStatus, 'incomplete');
  await f.send(0x0a, [0, 1, 0]);
  await f.send(0x0a, historyRecord({ cell: 0 }));
  await f.send(0x0a, historyRecord({ value: -1 }));
  await f.send(0x0a, historyRecord({ type: 5 }));
  assert.equal(f.state.records.length, 0);
  await f.send(0x0a, historyRecord());
  await f.send(0x0a, [2, 1, 0]);
  assert.equal(f.state.historyStatus, 'incomplete');
  await f.send(0x0a, [0, 1, 0]);
  const damaged = frame(0x0a, historyRecord());
  damaged[damaged.length - 1] ^= 1;
  f.port.push(damaged);
  await f.send(0x0a, historyRecord());
  await f.send(0x0a, [2, 1, 0]);
  assert.equal(f.state.historyStatus, 'incomplete');
});

test('valid unrelated reference commands during history transfer are ignored without marking loss', async (t) => {
  const f = await fixture(t);
  await f.send(0x0a, [0, 1, 0]);
  await f.send(0x00, [1]);
  await f.send(0x01, [1, 65, 1, 66, ...u16(2026), 10, 2]);
  await f.send(0x05, [0, 2, ...u32(20000)]);
  await f.send(0x02, [8, 50]);
  await f.send(0x0a, historyRecord());
  await f.send(0x0a, [2, 1, 0]);
  assert.equal(f.state.historyStatus, 'complete');
});

test('snapshot and concurrent history requests queue whole frames without polling', async (t) => {
  const f = await fixture(t);
  await Promise.all([f.session.requestSnapshot(), f.session.requestHistory()]);
  assert.deepEqual(
    f.port.writes.map((bytes) => [bytes[2], Array.from(bytes.slice(5, -1))]),
    [
      ...[0, 1, 2, 3, 13, 15, 16, 0x12].map((value) => [2, [value]]),
      [8, []],
      [3, [1]],
      [10, [0]],
      [10, [0]],
    ],
  );
  await tick();
  assert.equal(f.port.writes.length, 12);
});

test('concurrent close cancels pending read and command queue, releases once, suppresses late callbacks', async (t) => {
  const f = await fixture(t);
  const request = f.session.requestSnapshot();
  const updates = f.updates.length;
  await Promise.all([
    f.session.close(),
    f.session.close(),
    assert.rejects(request, /串口已关闭/),
  ]);
  f.port.push(frame(2, [1, 0, 0]));
  await tick();
  assert.equal(f.updates.length, updates);
  assert.equal(f.port.readsReleased, 1);
  assert.equal(f.port.writesReleased, 1);
  assert.equal(f.port.closeCount, 1);
  assert.equal(f.disconnects, 0);
  assert.deepEqual(f.errors, []);
  await assert.rejects(f.session.requestHistory(), /请先连接/);
});

test('close waits for active write and pending open without deadlock', async (t) => {
  const port = new MockPort();
  let releaseWrite;
  port.onWrite = () =>
    new Promise((resolve) => {
      releaseWrite = resolve;
    });
  const f = await fixture(t, port);
  const request = f.session.requestHistory();
  await tick();
  const closing = f.session.close();
  await tick();
  assert.equal(port.closeCount, 0);
  releaseWrite();
  await Promise.all([closing, request]);
  assert.equal(port.closeCount, 1);

  const openingPort = new MockPort();
  let releaseOpen;
  openingPort.onOpen = () =>
    new Promise((resolve) => {
      releaseOpen = resolve;
    });
  const session = new BatterySerialSession(openingPort, {
    onData: () => assert.fail('closed open must not publish'),
    onDisconnect: () => assert.fail(),
    onError: () => assert.fail(),
  });
  const opening = session.open();
  const closed = session.close();
  releaseOpen();
  await Promise.all([opening, closed]);
  assert.equal(openingPort.closeCount, 1);
  assert.equal(openingPort.readsReleased, 0);
});

test('read and write failures release resources and notify disconnect once', async (t) => {
  const read = await fixture(t);
  read.port.finish(new Error('read failed'));
  await tick();
  assert.deepEqual(read.errors, ['read failed']);
  assert.equal(read.disconnects, 1);
  assert.equal(read.port.readsReleased, 1);
  assert.equal(read.port.writesReleased, 1);

  const write = await fixture(t);
  write.port.onWrite = async () => {
    throw new Error('write failed');
  };
  await assert.rejects(write.session.requestHistory(), /write failed/);
  await tick();
  assert.deepEqual(write.errors, ['write failed']);
  assert.equal(write.disconnects, 1);
  assert.equal(write.port.closeCount, 1);
});

test('close failure remains visible and can be retried before switching serial modes', async (t) => {
  const f = await fixture(t);
  f.port.failClose = true;
  await assert.rejects(f.session.close(), /close failed/);
  assert.equal(f.port.closeCount, 1);
  f.port.failClose = false;
  await f.session.close();
  assert.equal(f.port.closeCount, 2);
  assert.equal(f.port.readsReleased, 1);
  assert.equal(f.port.writesReleased, 1);
});

test('errored native ReadableStream cancel rejection still releases port and notifies disconnect', async (t) => {
  let controller;
  const readable = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const writable = new WritableStream();
  let closed = 0;
  let disconnected = 0;
  const errors = [];
  const port = {
    readable,
    writable,
    async open() {},
    async close() {
      assert.equal(readable.locked, false);
      assert.equal(writable.locked, false);
      closed += 1;
    },
    getInfo() {
      return {};
    },
  };
  const session = new BatterySerialSession(port, {
    onData() {},
    onError(message) {
      errors.push(message);
    },
    onDisconnect() {
      assert.equal(closed, 1);
      disconnected += 1;
    },
  });
  await session.open();
  t.after(() => session.close());
  controller.error(new Error('USB cable disconnected'));
  await tick();
  assert.deepEqual(errors, ['USB cable disconnected']);
  assert.equal(disconnected, 1);
  assert.equal(closed, 1);
});

test('new device session cannot inherit previous readings or complete history', async (t) => {
  const first = await fixture(t);
  await first.send(2, [1, ...u16(7400)]);
  await first.send(0x0a, [0, 0, 0]);
  await first.send(0x0a, [2, 0, 0]);
  await first.session.close();
  const second = await fixture(t);
  assert.deepEqual(second.state, createBatteryState());
});

const identityPayload = (model = 'PACK-16', code = 'BAT-001') => [
  model.length,
  ...Buffer.from(model),
  code.length,
  ...Buffer.from(code),
];

test('identity reads only model and code with existing command and keeps history unread', async (t) => {
  for (const command of [0x08, 0x88]) {
    const f = await fixture(t);
    let resolved = false;
    const identifying = f.session.identify(500).then((identity) => {
      resolved = true;
      return identity;
    });
    await tick();
    assert.equal(f.session.isOpen, true);
    assert.equal(resolved, false);
    assert.deepEqual(f.port.writes.map((bytes) => Array.from(bytes)), [[...frame(8, [])]]);
    assert.equal(f.state.historyStatus, 'unread');
    await f.send(command, identityPayload());
    assert.deepEqual(await identifying, { model: 'PACK-16', code: 'BAT-001' });
    assert.equal(f.state.batteryModel, 'PACK-16');
    assert.equal(f.state.batteryCode, 'BAT-001');
    assert.equal(f.state.historyStatus, 'unread');
    assert.equal(f.port.writes.length, 1);
  }
});

test('identity ignores old readings, unrelated data, invalid CRC and malformed text', async (t) => {
  const f = await fixture(t);
  await f.send(8, identityPayload('OLD', 'OLD-CODE'));
  let resolved = false;
  const identifying = f.session.identify(500).then((identity) => {
    resolved = true;
    return identity;
  });
  await tick();
  assert.equal(resolved, false);
  const broken = frame(8, identityPayload('BROKEN', 'CRC'));
  broken[broken.length - 1] ^= 1;
  f.port.push(broken);
  await f.send(2, [0, 250, 0]);
  await f.send(3, u32(timestamp));
  for (const payload of [
    [0, 1, 65],
    [1, 65, 0],
    [1, 0, 1, 65],
    [1, 65, 1, 0x7f],
    [1, 65, 2, 66],
    [1, 65, 1, 66, 67],
  ]) await f.send(8, payload);
  assert.equal(resolved, false);
  assert.equal(f.state.batteryModel, 'OLD');
  await f.send(0x88, identityPayload('NEW', 'NEW-CODE'));
  assert.deepEqual(await identifying, { model: 'NEW', code: 'NEW-CODE' });
});

test('identity timeout rejects with its type, leaves session usable and clears the waiter', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.session.identify(15), BatteryIdentityTimeoutError);
  assert.equal(f.session.isOpen, true);
  assert.equal(f.state.historyStatus, 'unread');
  const next = f.session.identify(500);
  await tick();
  await f.send(8, identityPayload());
  assert.deepEqual(await next, { model: 'PACK-16', code: 'BAT-001' });
  assert.equal(f.port.writes.length, 2);
  assert.deepEqual(f.errors, []);
});

test('identity validates timeouts, rejects concurrent requests and cancels before or after write', async (t) => {
  const f = await fixture(t);
  for (const timeout of [0, -1, Infinity, NaN, 0x80000000])
    await assert.rejects(f.session.identify(timeout), RangeError);
  const aborted = AbortSignal.abort();
  await assert.rejects(f.session.identify(500, aborted), { name: 'AbortError' });
  assert.equal(f.port.writes.length, 0);

  const controller = new AbortController();
  const identifying = f.session.identify(500, controller.signal);
  const rejected = assert.rejects(identifying, { name: 'AbortError' });
  await assert.rejects(f.session.identify(500), /上一条/);
  await tick();
  controller.abort();
  await rejected;
  assert.equal(f.session.isOpen, true);
  await f.send(8, identityPayload());
  f.port.onWrite = async () => {
    f.port.push(frame(8, identityPayload('SECOND', 'SECOND-CODE')));
  };
  const next = f.session.identify(500);
  assert.deepEqual(await next, { model: 'SECOND', code: 'SECOND-CODE' });
});

test('identity removes abort listeners on success, timeout and cancellation', async (t) => {
  const f = await fixture(t);
  for (const outcome of ['success', 'timeout', 'abort']) {
    const controller = new AbortController();
    const signal = controller.signal;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let listeners = 0;
    signal.addEventListener = (...args) => { listeners += 1; add(...args); };
    signal.removeEventListener = (...args) => { listeners -= 1; remove(...args); };
    const identifying = f.session.identify(outcome === 'timeout' ? 15 : 500, signal);
    const completed = outcome === 'success'
      ? identifying
      : assert.rejects(identifying, outcome === 'timeout'
          ? BatteryIdentityTimeoutError
          : { name: 'AbortError' });
    await tick();
    assert.equal(listeners, 1);
    if (outcome === 'success') await f.send(8, identityPayload());
    if (outcome === 'abort') controller.abort();
    await completed;
    assert.equal(listeners, 0);
  }
});

test('cancelled and timed-out identities in the command queue never write later', async (t) => {
  for (const outcome of ['abort', 'timeout']) {
    const port = new MockPort();
    let releaseWrite;
    port.onWrite = () => new Promise((resolve) => { releaseWrite = resolve; });
    const f = await fixture(t, port);
    const history = f.session.requestHistory();
    await tick();
    const controller = new AbortController();
    const identifying = f.session.identify(outcome === 'timeout' ? 15 : 500, controller.signal);
    const rejected = assert.rejects(identifying, outcome === 'timeout'
      ? BatteryIdentityTimeoutError
      : { name: 'AbortError' });
    if (outcome === 'abort') controller.abort();
    await rejected;
    releaseWrite();
    await history;
    await tick();
    assert.deepEqual(f.port.writes.map((bytes) => bytes[2]), [0x0a]);
    assert.equal(f.state.historyStatus, 'receiving');
  }
});

test('identity ignores model responses while its read command is still queued', async (t) => {
  const port = new MockPort();
  let releaseWrite;
  port.onWrite = (bytes) => bytes[2] === 0x0a
    ? new Promise((resolve) => { releaseWrite = resolve; })
    : Promise.resolve(port.push(frame(8, identityPayload('AFTER', 'COMMAND'))));
  const f = await fixture(t, port);
  const history = f.session.requestHistory();
  await tick();
  let resolved = false;
  const identifying = f.session.identify(500).then((identity) => {
    resolved = true;
    return identity;
  });
  await f.send(8, identityPayload('BEFORE', 'COMMAND'));
  assert.equal(resolved, false);
  releaseWrite();
  await history;
  assert.deepEqual(await identifying, { model: 'AFTER', code: 'COMMAND' });
});

test('identity close rejects its waiter, suppresses late replies and releases locks once', async (t) => {
  const f = await fixture(t);
  const identifying = f.session.identify(500);
  const rejected = assert.rejects(identifying, /串口已关闭/);
  await tick();
  const count = f.updates.length;
  const closing = f.session.close();
  assert.equal(f.session.isOpen, false);
  await Promise.all([closing, rejected]);
  f.port.push(frame(8, identityPayload()));
  await tick();
  assert.equal(f.updates.length, count);
  assert.equal(f.port.readsReleased, 1);
  assert.equal(f.port.writesReleased, 1);
  assert.equal(f.port.closeCount, 1);
  await assert.rejects(f.session.identify(500), /请先连接/);
});

test('EOF and read failure reject identity and close all serial resources', async (t) => {
  for (const error of [undefined, new Error('identity read failed')]) {
    const f = await fixture(t);
    const identifying = f.session.identify(500);
    const rejected = assert.rejects(identifying, error ? /identity read failed/ : /设备已断开/);
    await tick();
    f.port.finish(error);
    await rejected;
    await tick();
    assert.equal(f.session.isOpen, false);
    assert.equal(f.disconnects, 1);
    assert.equal(f.port.readsReleased, 1);
    assert.equal(f.port.writesReleased, 1);
    assert.equal(f.port.closeCount, 1);
  }
});

test('identity write failure cannot confirm a device even if a valid reply arrives during write', async (t) => {
  for (const withReply of [false, true]) {
    const port = new MockPort();
    port.onWrite = async () => {
      if (withReply) {
        port.push(frame(8, identityPayload()));
        await tick();
      }
      throw new Error('identity write failed');
    };
    const f = await fixture(t, port);
    await assert.rejects(f.session.identify(500), /identity write failed/);
    await tick();
    assert.equal(f.session.isOpen, false);
    assert.equal(f.disconnects, 1);
    assert.equal(f.port.closeCount, 1);
  }
});

function iapOuter(payload, broken = false) {
  const bytes = data([0xaa, 0x55, 0x80, ...u16(payload.length), ...payload, 0]);
  bytes[bytes.length - 1] = crc8(bytes.subarray(2, -1)) ^ (broken ? 1 : 0);
  return bytes;
}

function ntcOuter(command) {
  // 最短身份帧恰好占据 NTC 返回帧的后 10 字节；其外层 CRC 无效也必须整帧隔离。
  return data([0xaa, command, ...frame(8, identityPayload('A', 'B'))]);
}

test('IAP and NTC outer boundaries isolate nested battery identity even when foreign CRC is invalid', () => {
  const nested = frame(8, identityPayload('A', 'B'));
  const outerFrames = [
    iapOuter(nested),
    iapOuter(nested, true),
    iapOuter(data([...nested, ...nested])),
    ntcOuter(0x81),
    ntcOuter(0x82),
  ];
  for (const outer of outerFrames) {
    for (const size of [1, 2, 7, outer.length]) {
      const received = [];
      const parser = new BatteryFrameParser((command, payload) => received.push([command, [...payload]]));
      const stream = data([...outer, ...frame(0x88, identityPayload('REAL', 'CODE'))]);
      for (let offset = 0; offset < stream.length; offset += size)
        parser.push(stream.slice(offset, offset + size));
      assert.deepEqual(received, [[8, identityPayload('REAL', 'CODE')]]);
    }
  }
});

test('identity preserves partially received foreign and battery outer boundaries across its request', async (t) => {
  const nested = frame(8, identityPayload('A', 'B'));
  const record = frame(0x0a, [1, ...nested, 0, 0, 0, 0, 0]);
  const damagedRecord = record.slice();
  damagedRecord[damagedRecord.length - 1] ^= 1;
  for (const [outer, split] of [
    [iapOuter(nested), 5],
    [iapOuter(nested, true), 5],
    [ntcOuter(0x81), 2],
    [ntcOuter(0x82), 2],
    [record, 6],
    [damagedRecord, 6],
  ]) {
    const f = await fixture(t);
    f.port.push(outer.slice(0, split));
    await tick();
    let resolved = false;
    const identifying = f.session.identify(500).then((identity) => {
      resolved = true;
      return identity;
    });
    await tick();
    f.port.push(outer.slice(split));
    await tick();
    assert.equal(resolved, false);
    await f.send(8, identityPayload('REAL', 'CODE'));
    assert.deepEqual(await identifying, { model: 'REAL', code: 'CODE' });
  }
});

test('oversized IAP length resynchronizes without blocking legitimate battery identity', () => {
  const received = [];
  const parser = new BatteryFrameParser((command, payload) => received.push([command, [...payload]]));
  parser.push(data([0xaa, 0x55, 0x08, ...u16(129), ...frame(8, identityPayload())]));
  assert.deepEqual(received, [[8, identityPayload()]]);
});
