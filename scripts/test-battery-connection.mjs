import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 运行真实协议与连接模块，避免用测试替身代替串口识别逻辑
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
const protocolUrl = moduleUrl(
  (await compile('../lib/battery-protocol.ts')).replace(
    /(['"])\.\/iap-protocol\1/,
    JSON.stringify(iapUrl),
  ),
);
const { batteryFrame, BatteryIdentityTimeoutError } = await import(protocolUrl);
const {
  discoverBatteryDevice,
  connectSelectedBatteryDevice,
  BatteryDeviceSelectionError,
  BatteryPortReleaseError,
} = await import(
  moduleUrl(
    (await compile('../lib/battery-connection.ts')).replace(
      /(['"])\.\/battery-protocol\1/,
      JSON.stringify(protocolUrl),
    ),
  )
);

function identityFrame(model = 'SC2016', code = 'BATTERY-001') {
  const modelBytes = Buffer.from(model);
  const codeBytes = Buffer.from(code);
  return batteryFrame(
    0x08,
    Uint8Array.from([
      modelBytes.length,
      ...modelBytes,
      codeBytes.length,
      ...codeBytes,
    ]),
  );
}

class MockPort {
  readable = null;
  writable = null;
  controller;
  openCount = 0;
  closeCount = 0;
  opened = false;
  openError = null;
  closeFailures = 0;
  beforeOpen = async () => {};
  onClose = () => {};
  writes = [];
  onRequest;

  constructor(onRequest = () => identityFrame()) {
    this.onRequest = onRequest;
  }

  async open(options) {
    this.openCount += 1;
    if (this.openError) throw this.openError;
    assert.equal(this.opened, false, 'port must be released before reopening');
    assert.equal(options.baudRate, 1500000);
    await this.beforeOpen();
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
        if (reply) this.controller.enqueue(reply);
      },
    });
  }

  async close() {
    this.closeCount += 1;
    if (this.closeFailures > 0) {
      this.closeFailures -= 1;
      throw new Error('端口仍被锁定');
    }
    this.opened = false;
    this.readable = null;
    this.writable = null;
    await Promise.resolve(this.onClose());
  }

  getInfo() {
    return {};
  }
  unplug() {
    this.controller.error(new Error('USB 已拔出'));
  }
}

function assertReadOnly(...ports) {
  const query = batteryFrame(0x08, new Uint8Array());
  for (const port of ports) {
    for (const frame of port.writes) assert.deepEqual(frame, query);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('scan skips unsupported and occupied ports and keeps only the unique battery device open', async () => {
  const unsupported = new MockPort(() =>
    batteryFrame(0x02, Uint8Array.from([0, 25, 0])),
  );
  const occupied = new MockPort();
  occupied.openError = new Error('端口已被其他程序占用');
  const target = new MockPort();
  const connection = await discoverBatteryDevice(
    [unsupported, occupied, target],
    null,
  );
  assert.equal(connection.port, target);
  assert.equal(unsupported.opened, false);
  assert.equal(unsupported.closeCount, 1);
  assert.equal(occupied.closeCount, 0);
  assert.equal(target.openCount, 2);
  assert.equal(target.closeCount, 1);
  assert.equal(target.opened, true);
  assertReadOnly(unsupported, occupied, target);
  await connection.session.close();
});

test('a remembered authorized battery device connects without opening other ports', async () => {
  const other = new MockPort();
  const remembered = new MockPort();
  const connection = await discoverBatteryDevice(
    [other, remembered],
    remembered,
  );
  assert.equal(connection.port, remembered);
  assert.equal(remembered.openCount, 1);
  assert.equal(other.openCount, 0);
  assertReadOnly(remembered);
  await connection.session.close();
});

test('a remembered adapter that no longer replies as a battery device is released before scanning', async () => {
  const remembered = new MockPort(() =>
    Uint8Array.from([0xaa, 0x82, 0x4e, 0x54, 0x43]),
  );
  const target = new MockPort();
  const connection = await discoverBatteryDevice(
    [target, remembered],
    remembered,
  );
  assert.equal(connection.port, target);
  assert.equal(remembered.openCount, 1);
  assert.equal(remembered.opened, false);
  assert.equal(target.openCount, 2);
  await connection.session.close();
});

test('a preferred port outside the authorized list is never opened', async () => {
  const unauthorized = new MockPort();
  assert.equal(await discoverBatteryDevice([], unauthorized), null);
  assert.equal(unauthorized.openCount, 0);
});

test('multiple matching devices are released and require explicit selection', async () => {
  const first = new MockPort();
  const second = new MockPort();
  const unscanned = new MockPort();
  await assert.rejects(
    discoverBatteryDevice([first, second, unscanned], null),
    BatteryDeviceSelectionError,
  );
  assert.equal(first.opened, false);
  assert.equal(second.opened, false);
  assert.equal(first.openCount, 1);
  assert.equal(second.openCount, 1);
  assert.equal(unscanned.openCount, 0);
  assertReadOnly(first, second);
});

test('CRC and valid nonempty length-prefixed ASCII model and code are required', async () => {
  const replies = [
    () => {
      const reply = identityFrame();
      reply[reply.length - 1] ^= 1;
      return reply;
    },
    () => identityFrame('', 'BATTERY-001'),
    () => identityFrame('SC2016', ''),
    () => identityFrame('SC\0MODEL', 'BATTERY-001'),
    () => identityFrame('SC2016', 'BAT\0CODE'),
    () => batteryFrame(0x08, Uint8Array.from([2, 65, 66, 3, 65, 66])),
    () => batteryFrame(0x02, Uint8Array.from([0, 25, 0])),
  ];
  await Promise.all(
    replies.map(async (reply) => {
      const port = new MockPort(reply);
      await assert.rejects(
        connectSelectedBatteryDevice(port),
        BatteryIdentityTimeoutError,
      );
      assert.equal(port.opened, false);
      assert.equal(port.closeCount, 1);
      assertReadOnly(port);
    }),
  );
});

test('a picker selection is identified using the existing read-only model query', async () => {
  const port = new MockPort();
  const connection = await connectSelectedBatteryDevice(port);
  assert.equal(connection.port, port);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  assert.equal(connection.session.isOpen, true);
  assertReadOnly(port);
  await connection.session.close();
});

test('a selected occupied port preserves its original error after cleanup', async () => {
  const port = new MockPort();
  const error = new Error('端口已被其他程序占用');
  port.openError = error;
  await assert.rejects(
    connectSelectedBatteryDevice(port),
    (result) => result === error,
  );
  assert.equal(port.closeCount, 0);
  assert.equal(port.writes.length, 0);
});

test('the unique scanned candidate must identify again after reopening', async () => {
  const target = new MockPort((request, port) =>
    port.openCount === 1 ? identityFrame() : null,
  );
  assert.equal(await discoverBatteryDevice([target], null), null);
  assert.equal(target.openCount, 2);
  assert.equal(target.closeCount, 2);
  assert.equal(target.opened, false);
  assertReadOnly(target);
});

test('an already canceled scan does not open any port', async () => {
  const port = new MockPort();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverBatteryDevice([port], null, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(port.openCount, 0);
});

test('cancellation during open waits for acquisition and releases without querying more devices', async () => {
  let releaseOpen;
  const port = new MockPort();
  const next = new MockPort();
  port.beforeOpen = () =>
    new Promise((resolve) => {
      releaseOpen = resolve;
    });
  const controller = new AbortController();
  const result = assert.rejects(
    discoverBatteryDevice([port, next], null, controller.signal),
    { name: 'AbortError' },
  );
  await tick();
  controller.abort();
  releaseOpen();
  await result;
  assert.equal(port.writes.length, 0);
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 1);
  assert.equal(next.openCount, 0);
});

test('cancellation during identification releases ownership and stops discovery', async () => {
  const controller = new AbortController();
  const port = new MockPort(() => {
    controller.abort();
    return null;
  });
  const next = new MockPort();
  await assert.rejects(
    discoverBatteryDevice([port, next], null, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 1);
  assert.equal(next.openCount, 0);
  assertReadOnly(port);
});

test('cancellation after a successful probe prevents the next port from opening', async () => {
  const controller = new AbortController();
  const port = new MockPort();
  const next = new MockPort();
  port.onClose = () => controller.abort();
  await assert.rejects(
    discoverBatteryDevice([port, next], null, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(port.opened, false);
  assert.equal(next.openCount, 0);
});

test('failed probe cleanup stops discovery and preserves a retryable session', async () => {
  const port = new MockPort(() => null);
  const next = new MockPort();
  port.closeFailures = 1;
  let releaseError;
  await assert.rejects(discoverBatteryDevice([port, next], null), (error) => {
    assert.ok(error instanceof BatteryPortReleaseError);
    assert.match(error.message, /端口仍被锁定/);
    releaseError = error;
    return true;
  });
  assert.equal(port.opened, true);
  assert.equal(next.openCount, 0);
  await releaseError.session.close();
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 2);
});

test('failed cleanup of a valid candidate stops scanning and preserves ownership', async () => {
  const port = new MockPort();
  const next = new MockPort();
  port.closeFailures = 1;
  let releaseError;
  await assert.rejects(discoverBatteryDevice([port, next], null), (error) => {
    assert.ok(error instanceof BatteryPortReleaseError);
    releaseError = error;
    return true;
  });
  assert.equal(next.openCount, 0);
  assert.equal(port.opened, true);
  await releaseError.session.close();
  assert.equal(port.opened, false);
});

test('live data and disconnect callbacks retain the accepted session identity', async () => {
  const port = new MockPort();
  const updates = [];
  const errors = [];
  const disconnects = [];
  const connection = await discoverBatteryDevice([port], null, undefined, {
    onData: (session, state) => updates.push({ session, state }),
    onError: (session, message) => errors.push({ session, message }),
    onDisconnect: (session) => disconnects.push(session),
  });
  assert.equal(updates.at(-1).session, connection.session);
  assert.equal(updates.at(-1).state.batteryModel, 'SC2016');
  assert.equal(updates.at(-1).state.batteryCode, 'BATTERY-001');
  assert.ok(updates.some((update) => update.session !== connection.session));
  port.controller.enqueue(batteryFrame(0x02, Uint8Array.from([1, 0x10, 0x27])));
  await tick();
  assert.equal(updates.at(-1).session, connection.session);
  assert.equal(updates.at(-1).state.totalVoltageMv, 10000);
  port.unplug();
  await tick();
  assert.equal(errors.at(-1).session, connection.session);
  assert.match(errors.at(-1).message, /USB 已拔出/);
  assert.deepEqual(disconnects, [connection.session]);
  assert.equal(port.opened, false);
  await connection.session.close();
});

test('a valid identity immediately followed by EOF is never accepted as a live connection', async () => {
  const port = new MockPort((request, device) => {
    device.controller.enqueue(identityFrame());
    device.controller.close();
    return null;
  });
  assert.equal(await discoverBatteryDevice([port], null), null);
  assert.equal(port.opened, false);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 1);
});
