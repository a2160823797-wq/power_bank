import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 加载真实扫描、共享串口及协议实现，模拟器只负责设备侧响应。
const urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let source = ts.transpileModule(
    await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    },
  ).outputText;
  for (const match of source.matchAll(/from (['"])(\.\/[^'"]+)\1/g)) {
    source = source.replace(
      match[0],
      `from ${JSON.stringify(await moduleUrl(match[2].slice(2)))}`,
    );
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}

const {
  discoverUpgradePort,
  verifyUpgradePort,
  UpgradePortReleaseError,
} = await import(await moduleUrl('upgrade-connection'));
const { DeviceSelectionError } = await import(await moduleUrl('device-connection'));
const { DeviceSerialSession } = await import(await moduleUrl('device-session'));
const { crc8 } = await import(await moduleUrl('iap-protocol'));
const { batteryFrame } = await import(await moduleUrl('battery-protocol'));
const { crc8: ntcCrc8 } = await import(await moduleUrl('ntc-protocol'));

function iapReply(command = 0, accepted = 1) {
  const body = Uint8Array.from([command, 1, 0, accepted]);
  return Uint8Array.from([0xaa, 0x55, ...body, crc8(body)]);
}

function iapOnly(request) {
  if (request[0] === 0xaa && request[1] === 0x55 && request[2] === 0)
    return iapReply();
  return null;
}

function sharedDeviceReply(request) {
  if (request[0] !== 0xaa) return null;
  if (request[1] === 0x55) return iapOnly(request);
  if (request[1] === 0xbb && request[2] === 8) {
    const model = Buffer.from('SC2016');
    const code = Buffer.from('BATTERY-001');
    return batteryFrame(
      8,
      Uint8Array.from([model.length, ...model, code.length, ...code]),
    );
  }
  if (request[1] === 1) {
    const reply = new Uint8Array(12);
    reply.set([0xaa, 0x81]);
    const view = new DataView(reply.buffer);
    const temperature = new DataView(request.buffer, request.byteOffset).getInt16(2, true);
    view.setInt16(2, temperature, true);
    view.setUint32(4, 10000, true);
    view.setUint16(8, 102, true);
    reply[11] = ntcCrc8(reply.subarray(0, 11));
    return reply;
  }
  return null;
}

class MockPort {
  readable = null;
  writable = null;
  controller;
  opened = false;
  openCount = 0;
  closeCount = 0;
  openError = null;
  closeFailures = 0;
  writes = [];

  constructor(onRequest = iapOnly) {
    this.onRequest = onRequest;
  }

  async open(options) {
    this.openCount += 1;
    if (this.openError) throw this.openError;
    assert.equal(this.opened, false, 'a physical port cannot be opened twice');
    assert.equal(options.baudRate, 1500000);
    this.opened = true;
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
    this.writable = new WritableStream({
      write: async (bytes) => {
        this.writes.push(bytes.slice());
        const reply = await Promise.resolve(this.onRequest(bytes, this));
        if (Array.isArray(reply)) {
          for (const part of reply) this.controller.enqueue(part);
        } else if (reply) this.controller.enqueue(reply);
      },
    });
  }

  async close() {
    this.closeCount += 1;
    assert.equal(this.readable.locked, false, 'physical read lock must be released');
    assert.equal(this.writable.locked, false, 'physical write lock must be released');
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('端口仍被锁定');
    }
    this.opened = false;
    this.readable = null;
    this.writable = null;
  }

  getInfo() {
    return {};
  }
}

function assertReadOnly(...ports) {
  const command = Uint8Array.from([0, 0, 0]);
  const expected = Uint8Array.from([0xaa, 0x55, ...command, crc8(command)]);
  for (const port of ports) {
    for (const frame of port.writes) assert.deepEqual(frame, expected);
  }
}

test('scanning discovers an IAP-only device without requiring battery or NTC identity', async () => {
  const unrelated = new MockPort(() => null);
  const target = new MockPort();
  assert.equal(await discoverUpgradePort([unrelated, target]), target);
  assert.equal(unrelated.opened, false);
  assert.equal(target.opened, false);
  assert.equal(unrelated.closeCount, 1);
  assert.equal(target.closeCount, 1);
  assertReadOnly(unrelated, target);
});

for (const { name, reply } of [
  { name: 'invalid CRC', reply: () => {
    const frame = iapReply();
    frame[frame.length - 1] ^= 1;
    return frame;
  } },
  { name: 'different command', reply: () => iapReply(2) },
  { name: 'rejected online ACK', reply: () => iapReply(0, 0) },
]) {
  test(`scanning rejects ${name} and never enters upgrade mode`, async () => {
    const port = new MockPort(reply);
    assert.equal(await discoverUpgradePort([port]), null);
    assert.equal(port.opened, false);
    assert.equal(port.closeCount, 1);
    assertReadOnly(port);
  });
}

test('scanning skips an occupied port without closing another program connection', async () => {
  const occupied = new MockPort();
  occupied.openError = new Error('端口已被其他程序占用');
  const target = new MockPort();
  assert.equal(await discoverUpgradePort([occupied, target]), target);
  assert.equal(occupied.closeCount, 0);
  assert.equal(target.opened, false);
  assertReadOnly(occupied, target);
});

test('multiple matching devices are released and require explicit selection', async () => {
  const first = new MockPort();
  const second = new MockPort();
  await assert.rejects(discoverUpgradePort([first, second]), DeviceSelectionError);
  assert.equal(first.opened, false);
  assert.equal(second.opened, false);
  assert.equal(first.closeCount, 1);
  assert.equal(second.closeCount, 1);
  assertReadOnly(first, second);
});

test('a verified preferred device is used without probing another matching device', async () => {
  const other = new MockPort();
  const preferred = new MockPort();
  assert.equal(await discoverUpgradePort([other, preferred], preferred), preferred);
  assert.equal(other.openCount, 0);
  assert.equal(preferred.opened, false);
  assertReadOnly(preferred);
});

test('an unavailable preferred device falls back to the unique compatible port', async () => {
  const preferred = new MockPort(() => null);
  const target = new MockPort();
  assert.equal(await discoverUpgradePort([preferred, target], preferred), target);
  assert.equal(preferred.openCount, 1);
  assert.equal(preferred.opened, false);
  assert.equal(target.opened, false);
  assertReadOnly(preferred, target);
});

test('a preferred port outside the authorized list is never probed', async () => {
  const preferred = new MockPort();
  assert.equal(await discoverUpgradePort([], preferred), null);
  assert.equal(preferred.openCount, 0);
});

test('IAP verification accepts fragmented replies after unrelated command bytes', async () => {
  const port = new MockPort(() => [
    iapReply(2),
    ...[...iapReply()].map((byte) => Uint8Array.of(byte)),
  ]);
  await verifyUpgradePort(port);
  assert.equal(port.opened, false);
  assertReadOnly(port);
});

test('scanning and selected verification reuse the physical monitoring connection', async (t) => {
  const received = [];
  const port = new MockPort(sharedDeviceReply);
  const session = new DeviceSerialSession(port, {
    onData: (_session, state) => received.push(state),
  });
  t.after(() => session.close());
  await session.open();
  await session.identify('battery', 100);
  assert.equal(await discoverUpgradePort([port], port, session), port);
  await verifyUpgradePort(port, session);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  assert.equal(session.isOpen, true);
  const temperature = await session.setTemperature(25, 100);
  assert.equal(temperature.temperature, 25);
  port.controller.enqueue(batteryFrame(2, Uint8Array.from([1, 0x88, 0x13])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.at(-1).totalVoltageMv, 5000);
  assertReadOnly({ writes: port.writes.filter((frame) => frame[1] === 0x55) });
});

test('manual verification rejects an unsupported selected port before any upgrade command', async () => {
  const port = new MockPort(() => iapReply(0, 0));
  await assert.rejects(verifyUpgradePort(port));
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 1);
  assertReadOnly(port);
});

test('a close failure stops scanning and keeps the IAP session for release retry', async () => {
  const first = new MockPort();
  first.closeFailures = 1;
  const next = new MockPort();
  let failure;
  await assert.rejects(discoverUpgradePort([first, next]), (error) => {
    failure = error;
    return error instanceof UpgradePortReleaseError;
  });
  assert.equal(first.opened, true);
  assert.equal(next.openCount, 0);
  await failure.session.close();
  assert.equal(first.opened, false);
  assert.equal(first.closeCount, 2);
  assertReadOnly(first);
});

test('manual verification preserves a close failure for release retry', async () => {
  const port = new MockPort();
  port.closeFailures = 1;
  let failure;
  await assert.rejects(verifyUpgradePort(port), (error) => {
    failure = error;
    return error instanceof UpgradePortReleaseError;
  });
  await failure.session.close();
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 2);
  assertReadOnly(port);
});

// 从真实 Provider 提取升级入口，在受控浏览器环境中运行原函数。
const providerSource = await readFile(
  new URL('../lib/device-connection-context.tsx', import.meta.url),
  'utf8',
);
const providerAst = ts.createSourceFile(
  'device-connection-context.tsx',
  providerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let upgradeNode;
function findUpgrade(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'withUpgrade')
    upgradeNode = node;
  ts.forEachChild(node, findUpgrade);
}
findUpgrade(providerAst);
assert.ok(upgradeNode, 'the provider must contain its real withUpgrade entry point');
const providerFactorySource = ts.transpileModule(
    `export function createUpgrade(environment) {
    const {
      busyRef, sessionRef, upgradeSelectionRef, upgradeProbeRef,
      markBusy, navigator, getSavedSerialPort, rememberSerialPort,
      LAST_UPGRADE_PORT_KEY, discoverUpgradePort, verifyUpgradePort,
      UpgradePortReleaseError, DeviceSelectionError,
    } = environment;
    ${upgradeNode.getText(providerAst)}
    return withUpgrade;
    }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
const { createUpgrade: providerFactory } = await import(
  `data:text/javascript;base64,${Buffer.from(providerFactorySource).toString('base64')}`
);

function createUpgradeProvider(ports, { selectedPort = null, session = null, preferred = null } = {}) {
  const state = {
    busyRef: { current: false },
    sessionRef: { current: session },
    upgradeSelectionRef: { current: false },
    upgradeProbeRef: { current: null },
    requests: 0,
    remembered: [],
  };
  const upgrade = providerFactory({
    ...state,
    navigator: {
      serial: {
        getPorts: async () => ports,
        requestPort: async () => {
          state.requests += 1;
          if (!selectedPort) throw new DOMException('未选择端口', 'NotFoundError');
          return selectedPort;
        },
      },
    },
    markBusy(value) {
      state.busyRef.current = value;
    },
    getSavedSerialPort: async () => preferred,
    rememberSerialPort(key, port) {
      state.remembered.push({ key, port });
    },
    LAST_UPGRADE_PORT_KEY: 'powerbank.upgrade-last-serial-port',
    discoverUpgradePort,
    verifyUpgradePort,
    UpgradePortReleaseError,
    DeviceSelectionError,
  });
  return { upgrade, state };
}

test('provider upgrades the unique authorized device without opening the browser picker', async () => {
  const target = new MockPort();
  const { upgrade, state } = createUpgradeProvider([target]);
  const result = await upgrade(async (port) => {
    assert.equal(port, target);
    assert.equal(target.closeCount, 1, 'read-only discovery must finish before upgrading');
    assert.equal(state.busyRef.current, true);
    return 'upgraded';
  });
  assert.equal(result, 'upgraded');
  assert.equal(state.requests, 0);
  assert.equal(state.busyRef.current, false);
  assert.equal(state.remembered.at(-1).port, target);
  assertReadOnly(target);
});

test('provider requests first authorization once and verifies before starting the operation', async () => {
  const target = new MockPort();
  const { upgrade, state } = createUpgradeProvider([], { selectedPort: target });
  await upgrade(async (port) => {
    assert.equal(port, target);
    assert.equal(target.writes.length, 1);
    assert.equal(target.opened, false);
  });
  assert.equal(state.requests, 1);
  assert.equal(state.busyRef.current, false);
  assertReadOnly(target);
});

test('provider asks for manual selection on the next click after multiple matches', async () => {
  const first = new MockPort();
  const second = new MockPort();
  const { upgrade, state } = createUpgradeProvider([first, second], { selectedPort: second });
  let operations = 0;
  const operation = async (port) => {
    operations += 1;
    assert.equal(port, second);
  };
  await assert.rejects(upgrade(operation), /多台升级设备/);
  assert.equal(operations, 0);
  assert.equal(state.requests, 0);
  assert.equal(state.upgradeSelectionRef.current, true);
  await upgrade(operation);
  assert.equal(operations, 1);
  assert.equal(state.requests, 1);
  assert.equal(state.upgradeSelectionRef.current, false);
  assert.equal(state.busyRef.current, false);
  assertReadOnly(first, second);
});

test('provider asks for manual authorization on the next click after finding no match', async () => {
  const unrelated = new MockPort(() => null);
  const selected = new MockPort();
  const { upgrade, state } = createUpgradeProvider([unrelated], { selectedPort: selected });
  let operations = 0;
  const operation = async (port) => {
    operations += 1;
    assert.equal(port, selected);
  };
  await assert.rejects(upgrade(operation), /未找到升级设备/);
  assert.equal(operations, 0);
  assert.equal(state.requests, 0);
  await upgrade(operation);
  assert.equal(operations, 1);
  assert.equal(state.requests, 1);
  assert.equal(state.busyRef.current, false);
  assertReadOnly(unrelated, selected);
});

test('provider never runs the operation when a manually selected device rejects identification', async () => {
  const wrong = new MockPort(() => iapReply(0, 0));
  const { upgrade, state } = createUpgradeProvider([], { selectedPort: wrong });
  let operations = 0;
  await assert.rejects(upgrade(async () => { operations += 1; }), /在线确认失败/);
  assert.equal(operations, 0);
  assert.equal(state.requests, 1);
  assert.equal(state.remembered.length, 0);
  assert.equal(state.busyRef.current, false);
  assertReadOnly(wrong);
});

test('provider grants an exclusive logical channel for the current monitoring port without physical reopen', async (t) => {
  const port = new MockPort(sharedDeviceReply);
  const session = new DeviceSerialSession(port);
  t.after(() => session.close());
  await session.open();
  await session.identify('battery', 100);
  const { upgrade, state } = createUpgradeProvider([port], { session });
  await upgrade(async (channel) => {
    assert.notEqual(channel, port);
    assert.equal(port.openCount, 1);
    assert.equal(port.closeCount, 0);
    assert.equal(session.isOpen, false);
    await channel.open({ baudRate: 1500000 });
    await channel.close();
  });
  assert.equal(state.requests, 0);
  assert.equal(state.busyRef.current, false);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  assert.equal(session.isOpen, true);
  await session.setTemperature(25, 100);
  assertReadOnly({ writes: port.writes.filter((frame) => frame[1] === 0x55) });
});

test('provider retains a failed probe release and retries it before the next scan', async () => {
  const target = new MockPort();
  target.closeFailures = 1;
  const unrelated = new MockPort(() => null);
  const { upgrade, state } = createUpgradeProvider([target, unrelated]);
  let operations = 0;
  const operation = async (port) => {
    operations += 1;
    assert.equal(port, target);
  };
  await assert.rejects(upgrade(operation), UpgradePortReleaseError);
  assert.equal(operations, 0);
  assert.equal(unrelated.openCount, 0);
  assert.ok(state.upgradeProbeRef.current);
  assert.equal(state.busyRef.current, false);
  await upgrade(operation);
  assert.equal(operations, 1);
  assert.equal(target.closeCount, 3);
  assert.equal(state.upgradeProbeRef.current, null);
  assert.equal(state.busyRef.current, false);
  assertReadOnly(target, unrelated);
});
