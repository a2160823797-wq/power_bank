import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let source = ts.transpileModule(
    await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  for (const match of source.matchAll(/from (['"])(\.\/[^'"]+)\1/g))
    source = source.replace(match[0], `from ${JSON.stringify(await moduleUrl(match[2].slice(2)))}`);
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}

const connectionModule = await import(await moduleUrl('upgrade-connection'));
const { IapSerialSession, IapResetDisconnectError, BootState, crc8, crc16, crc32 } =
  await import(await moduleUrl('iap-protocol'));
const { DeviceSelectionError } = await import(await moduleUrl('device-connection'));
const { DeviceSerialSession } = await import(await moduleUrl('device-session'));
const { crc8: ntcCrc8 } = await import(await moduleUrl('ntc-protocol'));
const firmware = Uint8Array.from({ length: 1536 }, (_, index) => index & 255);

function reply(command, payload) {
  const body = Uint8Array.from([command, payload.length, 0, ...payload]);
  return Uint8Array.from([0xaa, 0x55, ...body, crc8(body)]);
}

class ReceiverPort {
  readable = null;
  writable = null;
  opened = false;
  openCount = 0;
  closeCount = 0;
  state = BootState.App;
  size = firmware.length;
  crc = crc32(firmware);
  resetDisconnect = false;
  resetStaysApp = false;
  dataDisconnect = false;
  closeFailures = 0;
  openError = null;
  resetOpenFailures = 0;
  onReset = () => {};
  dataPackets = 0;
  resetRequests = 0;
  recoveredOpen = null;
  awaitingResetOpen = false;
  received = [];
  eots = 0;

  getInfo() { return { usbVendorId: 0x1a86, usbProductId: 0x55d3 }; }

  async open(options) {
    this.openCount++;
    if (this.openError) throw this.openError;
    if (this.state === BootState.AppRequestUpgrade && this.resetOpenFailures > 0) {
      this.resetOpenFailures--;
      throw new DOMException('Failed to open serial port.', 'NetworkError');
    }
    assert.equal(this.opened, false, 'physical port opened twice');
    assert.equal(options.baudRate, 1500000);
    this.opened = true;
    if (this.awaitingResetOpen) { this.recoveredOpen = this.openCount; this.awaitingResetOpen = false; }
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    this.writable = new WritableStream({ write: (bytes) => this.receive(bytes) });
  }

  async close() {
    this.closeCount++;
    assert.equal(this.readable.locked, false, 'read lock leaked');
    assert.equal(this.writable.locked, false, 'write lock leaked');
    if (this.closeFailures > 0) {
      this.closeFailures--;
      throw new Error('模拟关闭失败');
    }
    this.opened = false;
    this.readable = null;
    this.writable = null;
  }

  push(bytes) { this.controller.enqueue(Uint8Array.from(bytes)); }

  receive(bytes) {
    if (bytes[0] === 0xaa && bytes[1] === 1) {
      const payload = new Uint8Array(12);
      payload.set([0xaa, 0x81]);
      const view = new DataView(payload.buffer);
      view.setInt16(2, new DataView(bytes.buffer, bytes.byteOffset).getInt16(2, true), true);
      view.setUint32(4, 10000, true);
      view.setUint16(8, 102, true);
      payload[11] = ntcCrc8(payload.subarray(0, 11));
      return this.push(payload);
    }
    if (bytes[0] === 0xaa && bytes[1] === 0x55) {
      const command = bytes[2];
      if (command === 0) return this.push(reply(command, [1]));
      if (command === 1) {
        const payload = new Uint8Array(20);
        const view = new DataView(payload.buffer);
        view.setUint32(0, 0xaa55bbdd, true);
        view.setUint32(4, this.state, true);
        view.setUint32(8, this.size, true);
        view.setUint32(12, this.crc, true);
        view.setUint32(16, crc32(payload.subarray(0, 16)), true);
        this.push(reply(command, payload));
        if (this.state === BootState.AppUpdateReady) this.state = BootState.App;
        return;
      }
      if (command === 2) {
        this.state = bytes[5];
        if (this.state === BootState.AppRequestUpgrade && this.resetDisconnect) {
          this.resetDisconnect = false;
          this.resetRequests++;
          this.awaitingResetOpen = true;
          this.onReset();
          if (this.resetStaysApp) this.state = BootState.App;
          this.controller.error(new DOMException('The device has been lost.', 'NetworkError'));
          return;
        }
        this.push(reply(command, [1]));
        if (this.state === BootState.AppUpdate) {
          this.received = [];
          this.eots = 0;
          this.push([0x43]);
        }
        return;
      }
      assert.equal(command, 3);
      const manifest = new DataView(bytes.buffer, bytes.byteOffset + 5, 8);
      this.size = manifest.getUint32(0, true);
      this.crc = manifest.getUint32(4, true);
      this.push(reply(command, [1]));
      return this.push([0x43]);
    }
    if (bytes[0] === 0x02) {
      this.dataPackets++;
      if (this.recoveredOpen !== null) assert.equal(this.openCount, this.recoveredOpen, 'recovered physical connection was reopened before transfer');
      if (this.dataDisconnect) {
        const error = new DOMException('The device has been lost.', 'NetworkError');
        this.controller.error(error);
        throw error;
      }
      assert.equal(bytes.length, 1029);
      assert.equal(bytes[1], Math.floor(this.received.length / 1024) + 1);
      assert.equal(bytes[1] ^ bytes[2], 255);
      assert.equal(crc16(bytes.subarray(3, 1027)), (bytes[1027] << 8) | bytes[1028]);
      this.received.push(...bytes.subarray(3, 3 + Math.min(1024, this.size - this.received.length)));
      return this.push([0x06]);
    }
    if (bytes[0] === 0x04) {
      assert.equal(this.received.length, this.size);
      assert.equal(crc32(Uint8Array.from(this.received)), this.crc);
      this.eots++;
      return this.push(this.eots === 1 ? [0x15] : [0x06, 0x43]);
    }
    assert.equal(bytes[0], 0x01);
    assert.equal(bytes[1], 0);
    assert.equal(bytes.length, 133);
    if (bytes[3] === 0) {
      this.state = BootState.AppUpdateReady;
      return this.push([0x06]);
    }
    this.push([0x06, 0x43]);
  }
}

const providerSource = await readFile(new URL('../lib/device-connection-context.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('provider.tsx', providerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let upgradeNode;
function findUpgrade(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'withUpgrade') upgradeNode = node;
  ts.forEachChild(node, findUpgrade);
}
findUpgrade(ast);
assert.ok(upgradeNode);
const bindings = [
  'controllers', 'batteryController', 'ntcController', 'upgradeProbeRef', 'lastUpgradePortRef',
  'navigator', 'localStorage', 'getSavedSerialPort', 'rememberSerialPort', 'LAST_UPGRADE_PORT_KEY',
  'verifyUpgradePort', 'discoverUpgradePort', 'withUpgradeSession', 'resumeUpgradeAfterReset',
  'UpgradePortReleaseError', 'DeviceSelectionError', 'IapResetDisconnectError',
];
const factoryCode = ts.transpileModule(
  `export function createUpgrade(env) { const { ${bindings.join(',')} } = env;
  ${upgradeNode.getText(ast)}; return withUpgrade; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
).outputText;
const { createUpgrade } = await import(`data:text/javascript;base64,${Buffer.from(factoryCode).toString('base64')}`);

function provider(ports, { saved = ports[0], cached = null, savedMarker = false } = {}) {
  function controller() {
    return {
      busyRef: { current: false }, sessionRef: { current: null },
      connectTaskRef: { current: null }, closeTaskRef: { current: null },
      markBusy(value) { this.busyRef.current = value; },
    };
  }
  const controllers = [controller(), controller()];
  const state = {
    remembered: [], requests: 0, saved,
    upgradeProbeRef: { current: null }, lastUpgradePortRef: { current: cached },
  };
  const upgrade = createUpgrade({
    ...connectionModule, ...state, controllers,
    batteryController: controllers[0], ntcController: controllers[1],
    navigator: { serial: {
      getPorts: async () => ports,
      requestPort: async () => { state.requests++; return ports[0]; },
    } },
    localStorage: { getItem: () => savedMarker ? '{}' : null },
    getSavedSerialPort: async () => state.saved,
    rememberSerialPort: (_key, port) => { state.saved = port; state.remembered.push(port); },
    LAST_UPGRADE_PORT_KEY: 'test-upgrade-port',
    DeviceSelectionError, IapResetDisconnectError,
  });
  return { upgrade, state, controllers };
}

async function transfer(session) {
  await session.upgrade('firmware.bin', firmware, () => {}, () => {});
}

test('replay log: Bootloader upgrade succeeds, next APP reset disconnect recovers and succeeds', async () => {
  const port = new ReceiverPort();
  port.state = BootState.AppRequestUpgrade;
  const { upgrade, state, controllers } = provider([port], { cached: port });
  await upgrade(transfer);
  assert.equal(port.state, BootState.App);
  assert.equal(port.openCount, 2);
  port.resetDisconnect = true;
  await upgrade(transfer);
  assert.equal(port.openCount, 5);
  assert.equal(port.closeCount, 5);
  assert.equal(port.opened, false);
  assert.equal(port.state, BootState.App);
  assert.equal(port.resetRequests, 1);
  assert.equal(port.dataPackets, 4);
  assert.equal(state.lastUpgradePortRef.current, port);
  assert.ok(controllers.every((item) => !item.busyRef.current));
});

test('reset recovery tolerates temporary NetworkError and keeps opened port through firmware transfer', async () => {
  const port = new ReceiverPort();
  port.resetDisconnect = true;
  port.resetOpenFailures = 2;
  await provider([port], { cached: port }).upgrade(transfer);
  assert.equal(port.openCount, 5);
  assert.equal(port.closeCount, 3);
  assert.equal(port.resetRequests, 1);
  assert.equal(port.dataPackets, 2);
  assert.equal(port.state, BootState.App);
});

test('write phase disconnect is reported without reconnect or resending firmware', async () => {
  const port = new ReceiverPort();
  port.state = BootState.AppRequestUpgrade;
  port.dataDisconnect = true;
  await assert.rejects(provider([port], { cached: port }).upgrade(transfer),
    (error) => error.name === 'NetworkError' && !(error instanceof IapResetDisconnectError));
  assert.equal(port.openCount, 2);
  assert.equal(port.closeCount, 2);
  assert.equal(port.dataPackets, 1);
});

test('reconnected APP state is rejected before any firmware is sent', async () => {
  const port = new ReceiverPort();
  port.resetDisconnect = true;
  port.resetStaysApp = true;
  await assert.rejects(provider([port], { cached: port }).upgrade(transfer), /未进入升级模式/);
  assert.equal(port.dataPackets, 0);
  assert.equal(port.resetRequests, 1);
  assert.equal(port.opened, false);
});

test('initial open failure is preserved and does not close an unowned port', async () => {
  const port = new ReceiverPort();
  const failure = new DOMException('Failed to open serial port.', 'NetworkError');
  port.openError = failure;
  await assert.rejects(connectionModule.withUpgradeSession(port, transfer), (error) => error === failure);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
});

test('recovery rejects permission errors immediately', async () => {
  const port = new ReceiverPort();
  const failure = new DOMException('Denied', 'SecurityError');
  port.openError = failure;
  await assert.rejects(connectionModule.resumeUpgradeAfterReset({ getPorts: async () => [port] }, port, transfer), (error) => error === failure);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
});

test('shared monitoring transport releases after APP reset and recovery caches the physical port', async () => {
  const port = new ReceiverPort();
  port.resetDisconnect = true;
  const { upgrade, state, controllers } = provider([port], { cached: port });
  const controller = controllers[1];
  controller.value = {
    async disconnect() {
      if (controller.closeTaskRef.current) return controller.closeTaskRef.current;
      const task = controller.sessionRef.current.close().then(() => {
        controller.sessionRef.current = null;
      });
      controller.closeTaskRef.current = task;
      try { await task; }
      finally { controller.closeTaskRef.current = null; }
    },
  };
  const monitor = new DeviceSerialSession(port, {
    onDisconnect: () => { void controller.value.disconnect().catch(() => {}); },
  }, 'ntc');
  await monitor.open();
  controller.sessionRef.current = monitor;
  await upgrade(transfer);
  assert.equal(port.openCount, 2);
  assert.equal(port.closeCount, 2);
  assert.equal(port.dataPackets, 2);
  assert.equal(port.state, BootState.App);
  assert.equal(state.lastUpgradePortRef.current, port);
  assert.equal(controller.sessionRef.current, null);
});

test('reset replaces the browser port object: reacquire current port instead of retrying the stale object', async () => {
  const stale = new ReceiverPort();
  const current = new ReceiverPort();
  current.state = BootState.AppRequestUpgrade;
  const ports = [stale];
  stale.resetDisconnect = true;
  stale.onReset = () => {
    stale.openError = new DOMException('Stale browser port', 'NetworkError');
    ports.splice(0, 1, current);
  };
  const { upgrade, state } = provider(ports, { cached: stale });
  await upgrade(transfer);
  assert.equal(stale.openCount, 2, 'must not reopen stale port after reset');
  assert.equal(stale.closeCount, 2);
  assert.equal(stale.dataPackets, 0);
  assert.equal(current.openCount, 1);
  assert.equal(current.closeCount, 1);
  assert.equal(current.state, BootState.App);
  assert.equal(current.dataPackets, 2);
  assert.equal(state.lastUpgradePortRef.current, current);
});

test('new enumeration may include unrelated devices; recovery opens only the matching device', async () => {
  const stale = new ReceiverPort();
  const current = new ReceiverPort();
  const unrelated = new ReceiverPort();
  current.state = BootState.AppRequestUpgrade;
  unrelated.getInfo = () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
  const ports = [stale];
  stale.resetDisconnect = true;
  stale.onReset = () => { ports.splice(0, 1, unrelated, current); };
  await provider(ports, { cached: stale }).upgrade(transfer);
  assert.equal(unrelated.openCount, 0);
  assert.equal(current.dataPackets, 2);
});

test('multiple matching devices after reset stop recovery before any candidate is opened', async () => {
  const stale = new ReceiverPort();
  const first = new ReceiverPort();
  const second = new ReceiverPort();
  const ports = [stale];
  stale.resetDisconnect = true;
  stale.onReset = () => { ports.splice(0, 1, first, second); };
  await assert.rejects(provider(ports, { cached: stale }).upgrade(transfer),
    (error) => error instanceof DeviceSelectionError);
  assert.equal(first.openCount, 0);
  assert.equal(second.openCount, 0);
  assert.equal(stale.dataPackets, 0);
});

test('permanent NetworkError is bounded and each attempt enumerates current ports again', async () => {
  const port = new ReceiverPort();
  const failure = new DOMException('Cannot open', 'NetworkError');
  port.openError = failure;
  let enumerations = 0;
  const serial = { async getPorts() { enumerations++; return [port]; } };
  await assert.rejects(connectionModule.resumeUpgradeAfterReset(serial, port, transfer), (error) => error === failure);
  assert.equal(enumerations, 5);
  assert.equal(port.openCount, 5);
  assert.equal(port.closeCount, 0);
});
