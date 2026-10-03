import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const protocolSource = stripTypeScriptTypes(
  await readFile(new URL('../lib/ntc-protocol.ts', import.meta.url), 'utf8'),
  { mode: 'strip' },
);
const protocolUrl = `data:text/javascript;base64,${Buffer.from(protocolSource).toString('base64')}`;
const { crc8, NtcIdentityTimeoutError } = await import(protocolUrl);
const connectionSource = stripTypeScriptTypes(
  await readFile(new URL('../lib/ntc-connection.ts', import.meta.url), 'utf8'),
  { mode: 'strip' },
).replace("'./ntc-protocol'", JSON.stringify(protocolUrl));
const {
  discoverNtcDevice,
  connectSelectedNtcDevice,
  NtcDeviceSelectionError,
  NtcPortReleaseError,
} = await import(`data:text/javascript;base64,${Buffer.from(connectionSource).toString('base64')}`);

function identityFrame(request, changes = {}) {
  const frame = Uint8Array.from([
    0xaa, 0x82, 0x4e, 0x54, 0x43, 0x31, 1, 0,
    request[2], request[3], 0, 0,
  ]);
  for (const [index, value] of Object.entries(changes)) frame[Number(index)] = value;
  frame[11] = crc8(frame.subarray(0, 11));
  return frame;
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

  constructor(onRequest = (request) => identityFrame(request)) {
    this.onRequest = onRequest;
  }

  async open(options) {
    this.openCount += 1;
    if (this.openError) throw this.openError;
    assert.equal(this.opened, false, 'a previously acquired port must be released before reopening');
    assert.equal(options.baudRate, 1500000);
    await this.beforeOpen();
    this.opened = true;
    this.readable = new ReadableStream({
      start: (controller) => { this.controller = controller; },
    });
    this.writable = new WritableStream({
      write: async (bytes) => {
        this.writes.push(bytes.slice());
        const frame = await Promise.resolve(this.onRequest(bytes, this));
        if (frame) this.controller.enqueue(frame);
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

  getInfo() { return {}; }
  unplug() { this.controller.error(new Error('USB 已拔出')); }
}

function assertReadOnly(...ports) {
  for (const port of ports) {
    for (const frame of port.writes) {
      assert.equal(frame.length, 5);
      assert.deepEqual([...frame.subarray(0, 2)], [0xaa, 0x02]);
      assert.equal(frame[4], crc8(frame.subarray(0, 4)));
    }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('scan skips unknown and occupied ports and leaves only the uniquely identified device open', async () => {
  const unknown = new MockPort((request) => identityFrame(request, { 2: 0x58 }));
  const occupied = new MockPort();
  occupied.openError = new Error('端口已被其他程序占用');
  const target = new MockPort();
  const connection = await discoverNtcDevice([unknown, occupied, target], null);
  assert.equal(connection.port, target);
  assert.equal(unknown.opened, false);
  assert.equal(unknown.closeCount, 1);
  assert.equal(occupied.closeCount, 0);
  assert.equal(target.openCount, 2);
  assert.equal(target.closeCount, 1);
  assert.equal(target.opened, true);
  assertReadOnly(unknown, occupied, target);
  await connection.session.close();
});

test('valid identity on the remembered authorized port avoids opening other devices', async () => {
  const other = new MockPort();
  const remembered = new MockPort();
  const connection = await discoverNtcDevice([other, remembered], remembered);
  assert.equal(connection.port, remembered);
  assert.equal(remembered.openCount, 1);
  assert.equal(other.openCount, 0);
  assertReadOnly(remembered);
  await connection.session.close();
});

test('a remembered adapter with a different device is released before scanning other ports', async () => {
  const remembered = new MockPort((request) => identityFrame(request, { 5: 0x32 }));
  const target = new MockPort();
  const connection = await discoverNtcDevice([target, remembered], remembered);
  assert.equal(connection.port, target);
  assert.equal(remembered.openCount, 1);
  assert.equal(remembered.opened, false);
  assert.equal(target.openCount, 2);
  await connection.session.close();
});

test('a preferred port outside the provided authorized list is never opened', async () => {
  const unauthorized = new MockPort();
  assert.equal(await discoverNtcDevice([], unauthorized), null);
  assert.equal(unauthorized.openCount, 0);
});

test('multiple matching devices are released and require explicit selection', async () => {
  const first = new MockPort();
  const second = new MockPort();
  const unscanned = new MockPort();
  await assert.rejects(
    discoverNtcDevice([first, second, unscanned], null),
    NtcDeviceSelectionError,
  );
  assert.equal(first.opened, false);
  assert.equal(second.opened, false);
  assert.equal(first.openCount, 1);
  assert.equal(second.openCount, 1);
  assert.equal(unscanned.openCount, 0);
  assertReadOnly(first, second);
});

test('CRC, signature, echoed nonce, version and device status must all identify the device', async () => {
  const invalidReplies = [
    (request) => { const frame = identityFrame(request); frame[11] ^= 1; return frame; },
    (request) => identityFrame(request, { 2: 0x58 }),
    (request) => identityFrame(request, { 8: request[2] ^ 1 }),
    (request) => identityFrame(request, { 6: 2 }),
    (request) => identityFrame(request, { 10: 1 }),
  ];
  await Promise.all(invalidReplies.map(async (reply) => {
    const port = new MockPort(reply);
    await assert.rejects(connectSelectedNtcDevice(port), NtcIdentityTimeoutError);
    assert.equal(port.opened, false);
    assert.equal(port.closeCount, 1);
    assertReadOnly(port);
  }));
});

test('a picker selection is checked with a read-only identity request before connecting', async () => {
  const port = new MockPort();
  const connection = await connectSelectedNtcDevice(port);
  assert.equal(connection.port, port);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  assertReadOnly(port);
  await connection.session.close();
});

test('the unique scanned candidate must identify again after reopening', async () => {
  const target = new MockPort((request, port) => port.openCount === 1
    ? identityFrame(request)
    : identityFrame(request, { 2: 0x58 }));
  assert.equal(await discoverNtcDevice([target], null), null);
  assert.equal(target.openCount, 2);
  assert.equal(target.closeCount, 2);
  assert.equal(target.opened, false);
});

test('an already canceled scan does not open any port', async () => {
  const port = new MockPort();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverNtcDevice([port], null, controller.signal), { name: 'AbortError' });
  assert.equal(port.openCount, 0);
});

test('cancel during port.open waits for ownership and releases it without querying or scanning further', async () => {
  let releaseOpen;
  const port = new MockPort();
  const next = new MockPort();
  port.beforeOpen = () => new Promise((resolve) => { releaseOpen = resolve; });
  const controller = new AbortController();
  const result = assert.rejects(
    discoverNtcDevice([port, next], null, controller.signal),
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

test('cancel during identification releases the acquired port and stops scanning', async () => {
  const controller = new AbortController();
  const port = new MockPort(() => { controller.abort(); return null; });
  const next = new MockPort();
  await assert.rejects(
    discoverNtcDevice([port, next], null, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 1);
  assert.equal(next.openCount, 0);
  assertReadOnly(port);
});

test('cancel after a successful probe closes that candidate and prevents the next open', async () => {
  const controller = new AbortController();
  const port = new MockPort();
  const next = new MockPort();
  port.onClose = () => controller.abort();
  await assert.rejects(
    discoverNtcDevice([port, next], null, controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(port.opened, false);
  assert.equal(next.openCount, 0);
});

test('failed probe cleanup stops discovery and retains a retryable session instead of losing ownership', async () => {
  const port = new MockPort((request) => identityFrame(request, { 2: 0x58 }));
  const next = new MockPort();
  port.closeFailures = 1;
  let releaseError;
  await assert.rejects(discoverNtcDevice([port, next], null), (error) => {
    assert.ok(error instanceof NtcPortReleaseError);
    assert.match(error.message, /端口仍被锁定/);
    releaseError = error;
    return true;
  });
  assert.equal(port.opened, true);
  assert.equal(next.openCount, 0);
  await releaseError.session.close();
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 2);
  const connection = await connectSelectedNtcDevice(next);
  await connection.session.close();
});

test('failed cleanup of a valid candidate also stops scanning and retains ownership', async () => {
  const port = new MockPort();
  const next = new MockPort();
  port.closeFailures = 1;
  let releaseError;
  await assert.rejects(discoverNtcDevice([port, next], null), (error) => {
    assert.ok(error instanceof NtcPortReleaseError);
    releaseError = error;
    return true;
  });
  assert.equal(next.openCount, 0);
  assert.equal(port.opened, true);
  await releaseError.session.close();
  assert.equal(port.opened, false);
});

test('a returned live session reports unplug using the same session identity', async () => {
  const port = new MockPort();
  const disconnects = [];
  const connection = await connectSelectedNtcDevice(port, undefined, (session, error) => {
    disconnects.push({ session, error });
  });
  port.unplug();
  await tick();
  await connection.session.close();
  assert.equal(disconnects.length, 1);
  assert.equal(disconnects[0].session, connection.session);
  assert.match(disconnects[0].error.message, /USB 已拔出/);
  assert.equal(port.opened, false);
});

test('a valid identity immediately followed by EOF cannot be accepted as a live connection', async () => {
  const port = new MockPort((request, device) => {
    device.controller.enqueue(identityFrame(request));
    device.controller.close();
    return null;
  });
  assert.equal(await discoverNtcDevice([port], null), null);
  assert.equal(port.opened, false);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 1);
});
