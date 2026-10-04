import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// 加载真实会话、扫描、混流传输与协议实现，不用替身冒充识别流程。
const urls = new Map();
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name);
  let source = ts.transpileModule(
    await readFile(new URL(`../lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  for (const match of source.matchAll(/from (['"])(\.\/[^'"]+)\1/g)) {
    source = source.replace(match[0], `from ${JSON.stringify(await moduleUrl(match[2].slice(2)))}`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  urls.set(name, url);
  return url;
}
const { batteryFrame } = await import(await moduleUrl('battery-protocol'));
const { crc8, NtcTimeoutError, NtcIdentityTimeoutError } = await import(await moduleUrl('ntc-protocol'));
const { IapSerialSession, crc8: iapCrc8, crc16, crc32 } = await import(await moduleUrl('iap-protocol'));
const { DEFAULT_CONFIG } = await import(await moduleUrl('iap-config'));
const { DeviceSerialSession } = await import(await moduleUrl('device-session'));
const { discoverDevice, connectSelectedDevice, DeviceSelectionError, DevicePortReleaseError } =
  await import(await moduleUrl('device-connection'));

function batteryIdentity(model = 'SC2016', code = 'BATTERY-001') {
  const modelBytes = Buffer.from(model);
  const codeBytes = Buffer.from(code);
  return batteryFrame(0x08, Uint8Array.from([
    modelBytes.length, ...modelBytes, codeBytes.length, ...codeBytes,
  ]));
}

function ntcIdentity(request) {
  const frame = Uint8Array.from([
    0xaa, 0x82, 0x4e, 0x54, 0x43, 0x31, 1, 0, request[2], request[3], 0, 0,
  ]);
  frame[11] = crc8(frame.subarray(0, 11));
  return frame;
}

function temperatureAck(temperature = 25) {
  const frame = new Uint8Array(12);
  frame.set([0xaa, 0x81]);
  const view = new DataView(frame.buffer);
  view.setInt16(2, temperature, true);
  view.setUint32(4, 10000, true);
  view.setUint16(8, 102, true);
  frame[11] = crc8(frame.subarray(0, 11));
  return frame;
}

function deviceReply(request) {
  if (request[0] !== 0xaa) return null;
  if (request[1] === 0xbb) {
    if (request[2] === 0x08) return batteryIdentity();
    if (request[2] === 0x02 && request[5] === 1)
      return batteryFrame(0x02, Uint8Array.from([1, 0x88, 0x13]));
    return null;
  }
  if (request[1] === 0x02) return ntcIdentity(request);
  if (request[1] === 0x01)
    return temperatureAck(new DataView(request.buffer, request.byteOffset).getInt16(2, true));
  return null;
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

  constructor(onRequest = deviceReply) { this.onRequest = onRequest; }

  async open(options) {
    this.openCount += 1;
    if (this.openError) throw this.openError;
    assert.equal(this.opened, false, 'physical port must be released before reopening');
    assert.equal(options.baudRate, 1500000);
    await this.beforeOpen();
    this.opened = true;
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    this.writable = new WritableStream({
      write: async (bytes) => {
        this.writes.push(bytes.slice());
        const reply = await this.onRequest(bytes, this);
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
    await Promise.resolve(this.onClose());
  }

  getInfo() { return {}; }
  unplug() { this.controller.error(new Error('USB 已拔出')); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function assertReadOnly(kind, ...ports) {
  for (const port of ports) {
    for (const frame of port.writes) {
      if (kind === 'battery') assert.deepEqual(frame, batteryFrame(0x08));
      else {
        assert.equal(frame.length, 5);
        assert.deepEqual([...frame.subarray(0, 2)], [0xaa, 0x02]);
        assert.equal(frame[4], crc8(frame.subarray(0, 4)));
      }
    }
  }
}

test('one physical connection supports both identities and temperature settings', async () => {
  const port = new MockPort();
  const { session } = await connectSelectedDevice(port, 'battery');
  assert.equal(session.isOpen, true);
  await session.identify('ntc', 100);
  const reply = await session.setTemperature(-20, 100);
  assert.equal(reply.temperature, -20);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  await session.close();
  assert.equal(port.closeCount, 1);
});

test('battery updates and NTC ACKs can be fragmented and glued on the same reader', async () => {
  const received = [];
  const voltage = batteryFrame(0x02, Uint8Array.from([1, 0x88, 0x13]));
  const port = new MockPort((request) => {
    if (request[1] !== 0x01) return deviceReply(request);
    const mixed = Uint8Array.from([...voltage, ...temperatureAck(25), ...voltage]);
    return [mixed.slice(0, 3), mixed.slice(3, 11), mixed.slice(11, 20), mixed.slice(20)];
  });
  const { session } = await connectSelectedDevice(port, 'ntc', undefined, {
    onData: (_session, state) => received.push(state),
  });
  const [reply] = await Promise.all([session.setTemperature(25, 100), session.requestSnapshot()]);
  assert.equal(reply.temperature, 25);
  assert.equal(received.at(-1).totalVoltageMv, 5000);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  await session.close();
});

test('an NTC ACK nested in a battery payload cannot complete a temperature request', async () => {
  const port = new MockPort((request) => request[1] === 0x01
    ? batteryFrame(0x40, temperatureAck(25))
    : deviceReply(request));
  const { session } = await connectSelectedDevice(port, 'ntc');
  await assert.rejects(session.setTemperature(25, 30), NtcTimeoutError);
  await session.close();
});

test('invalid CRC on temperature ACK does not succeed and does not close the shared connection', async () => {
  const port = new MockPort((request) => {
    if (request[1] !== 0x01) return deviceReply(request);
    const reply = temperatureAck(25);
    reply[11] ^= 1;
    return reply;
  });
  const { session } = await connectSelectedDevice(port, 'battery');
  await assert.rejects(session.setTemperature(25, 30), NtcTimeoutError);
  assert.equal(session.isOpen, true);
  assert.equal(port.closeCount, 0);
  await session.identify('battery', 100);
  await session.close();
});

for (const kind of ['battery', 'ntc']) {
  test(`${kind} scanning skips unsupported and occupied ports and rechecks a unique candidate`, async () => {
    const unknown = new MockPort(() => null);
    const occupied = new MockPort();
    occupied.openError = new Error('端口已被其他程序占用');
    const target = new MockPort();
    const result = await discoverDevice([unknown, occupied, target], null, kind);
    assert.equal(result.port, target);
    assert.equal(unknown.opened, false);
    assert.equal(occupied.closeCount, 0);
    assert.equal(target.openCount, 2);
    assert.equal(target.closeCount, 1);
    assertReadOnly(kind, unknown, occupied, target);
    await result.session.close();
  });

  test(`${kind} remembered authorized device is used without touching another candidate`, async () => {
    const other = new MockPort();
    const saved = new MockPort();
    const result = await discoverDevice([other, saved], saved, kind);
    assert.equal(result.port, saved);
    assert.equal(saved.openCount, 1);
    assert.equal(other.openCount, 0);
    assertReadOnly(kind, saved);
    await result.session.close();
  });

  test(`${kind} multiple matches are closed and require explicit device selection`, async () => {
    const first = new MockPort();
    const second = new MockPort();
    await assert.rejects(discoverDevice([first, second], null, kind), DeviceSelectionError);
    assert.equal(first.opened, false);
    assert.equal(second.opened, false);
    assertReadOnly(kind, first, second);
  });

  test(`${kind} probe canceled while opening releases the physical port before rejecting`, async () => {
    const controller = new AbortController();
    const port = new MockPort();
    port.beforeOpen = async () => controller.abort();
    await assert.rejects(connectSelectedDevice(port, kind, controller.signal), { name: 'AbortError' });
    assert.equal(port.opened, false);
    assert.equal(port.closeCount, 1);
    assert.equal(port.writes.length, 0);
  });

  test(`${kind} unique candidate is rejected if it no longer identifies after reopening`, async () => {
    const port = new MockPort((request, current) => current.openCount === 1 ? deviceReply(request) : null);
    assert.equal(await discoverDevice([port], null, kind), null);
    assert.equal(port.openCount, 2);
    assert.equal(port.closeCount, 2);
    assert.equal(port.opened, false);
    assertReadOnly(kind, port);
  });

  test(`${kind} probe canceled while waiting for identity releases the port`, async () => {
    const controller = new AbortController();
    const port = new MockPort(() => { controller.abort(); return null; });
    await assert.rejects(connectSelectedDevice(port, kind, controller.signal), { name: 'AbortError' });
    assert.equal(port.closeCount, 1);
    assert.equal(port.opened, false);
  });

  test(`${kind} identity immediately followed by EOF is never accepted`, async () => {
    const port = new MockPort((request, current) => {
      current.controller.enqueue(deviceReply(request));
      current.controller.close();
      return null;
    });
    await assert.rejects(connectSelectedDevice(port, kind));
    assert.equal(port.opened, false);
  });
}

test('ports outside the authorized list are never probed', async () => {
  const port = new MockPort();
  assert.equal(await discoverDevice([], port, 'battery'), null);
  assert.equal(port.openCount, 0);
});

test('NTC identity must match the fresh query nonce', async () => {
  const port = new MockPort((request) => {
    const reply = ntcIdentity(request);
    reply[8] ^= 1;
    reply[11] = crc8(reply.subarray(0, 11));
    return reply;
  });
  const session = new DeviceSerialSession(port);
  await session.open();
  await assert.rejects(session.identify('ntc', 30), NtcIdentityTimeoutError);
  assertReadOnly('ntc', port);
  await session.close();
});

test('close failure during scan retains the session and supports a later release retry', async () => {
  const port = new MockPort();
  port.closeFailures = 1;
  let failure;
  await assert.rejects(discoverDevice([port], null, 'battery'), (error) => {
    failure = error;
    return error instanceof DevicePortReleaseError;
  });
  assert.equal(port.opened, true);
  assert.equal(failure.session.isOpen, false);
  await failure.session.close();
  assert.equal(port.opened, false);
  assert.equal(port.closeCount, 2);
});

test('physical disconnect rejects pending temperature request and notifies once for both protocols', async () => {
  let disconnected = 0;
  const port = new MockPort((request, current) => {
    if (request[1] === 0x01) { current.unplug(); return null; }
    return deviceReply(request);
  });
  const { session } = await connectSelectedDevice(port, 'battery', undefined, {
    onDisconnect: () => { disconnected += 1; },
  });
  await assert.rejects(session.setTemperature(25, 100), /USB/);
  await tick();
  assert.equal(disconnected, 1);
  assert.equal(session.isOpen, false);
  await session.close();
  assert.equal(port.opened, false);
});

test('upgrade owns one exclusive logical channel and resumes both protocols without physical reopen', async () => {
  const received = [];
  const port = new MockPort((request) => request[0] === 0x55
    ? Uint8Array.from([0x06, 0x18, 0x43])
    : deviceReply(request));
  const { session } = await connectSelectedDevice(port, 'battery', undefined, {
    onData: (_session, state) => received.push(state),
  });
  const result = await session.withUpgrade(async (channel) => {
    assert.equal(port.openCount, 1);
    assert.equal(port.closeCount, 0);
    await assert.rejects(session.setTemperature(25, 100), /连接/);
    await channel.open({ baudRate: 1500000 });
    const reader = channel.readable.getReader();
    const writer = channel.writable.getWriter();
    const count = received.length;
    await writer.write(Uint8Array.from([0x55]));
    const { value } = await reader.read();
    assert.deepEqual([...value], [0x06, 0x18, 0x43]);
    assert.equal(received.length, count, 'IAP data must not be delivered to monitoring');
    await reader.cancel();
    reader.releaseLock();
    writer.releaseLock();
    await channel.close();
    return 'updated';
  });
  assert.equal(result, 'updated');
  assert.equal(session.isOpen, true);
  assert.equal(received.at(-1).totalVoltageMv, 5000);
  await session.setTemperature(25, 100);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  await session.close();
});

test('upgrade failure preserves its cause and restores monitoring on the same open port', async () => {
  const port = new MockPort();
  const { session } = await connectSelectedDevice(port, 'ntc');
  const failure = new Error('升级被取消');
  await assert.rejects(session.withUpgrade(async (channel) => {
    await channel.open({ baudRate: 1500000 });
    throw failure;
  }), (error) => error === failure);
  assert.equal(session.isOpen, true);
  await session.setTemperature(25, 100);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  await session.close();
});

test('entering upgrade cancels a pending temperature ACK before giving IAP its channel', async () => {
  const port = new MockPort((request) => request[1] === 0x01 ? null : deviceReply(request));
  const { session } = await connectSelectedDevice(port, 'battery');
  const temperatureResult = session.setTemperature(25, 1000).catch((error) => error);
  await tick();
  await session.withUpgrade(async (channel) => { await channel.open({ baudRate: 1500000 }); });
  assert.equal((await temperatureResult).name, 'AbortError');
  assert.equal(session.isOpen, true);
  assert.equal(port.openCount, 1);
  await session.close();
});

test('disconnecting during upgrade closes the physical port and never resumes monitoring', async () => {
  const port = new MockPort();
  const { session } = await connectSelectedDevice(port, 'battery');
  await assert.rejects(session.withUpgrade(async (channel) => {
    await channel.open({ baudRate: 1500000 });
    const reader = channel.readable.getReader();
    const waiting = reader.read();
    await session.close();
    assert.equal((await waiting).done, true);
    reader.releaseLock();
  }), /断开/);
  assert.equal(session.isOpen, false);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 1);
});

test('physical failure during upgrade preserves the operation error and cannot resume stale channels', async () => {
  let disconnected = 0;
  const port = new MockPort();
  const { session } = await connectSelectedDevice(port, 'battery', undefined, {
    onDisconnect: () => { disconnected += 1; },
  });
  const failure = new Error('升级过程中设备已重启');
  await assert.rejects(session.withUpgrade(async (channel) => {
    await channel.open({ baudRate: 1500000 });
    port.unplug();
    await tick();
    throw failure;
  }), (error) => error === failure);
  assert.equal(disconnected, 1);
  assert.equal(session.isOpen, false);
  assert.equal(port.openCount, 1);
  await session.close();
  assert.equal(port.closeCount, 1);
});

test('universal IAP accepts fragmented command and YMODEM acknowledgements on the exclusive channel and restores monitoring', async () => {
  const firmware = Uint8Array.from(
    { length: 1500 },
    (_unused, index) => index & 0xff,
  );
  const vectors = new DataView(firmware.buffer);
  vectors.setUint32(0, 0x20001000, true);
  vectors.setUint32(4, 0x4801, true);
  const commands = [];
  const received = [];
  let upgradeMode = false;
  let phase = 'header';
  let offset = 0;
  let block = 1;
  let eots = 0;
  const fragments = (bytes) => [...bytes].map((byte) => Uint8Array.of(byte));
  const port = new MockPort((packet) => {
    if (packet[0] === 0xaa && packet[1] !== 0x55) {
      assert.equal(
        upgradeMode,
        false,
        'monitoring must not transmit during IAP',
      );
      return deviceReply(packet);
    }
    if (packet[0] === 0xaa) {
      const command = packet[2];
      assert.equal(packet[3] | (packet[4] << 8), packet.length - 6);
      assert.equal(packet.at(-1), iapCrc8(packet.subarray(2, -1)));
      commands.push(command);
      if (command === 2) {
        assert.equal(packet[5], 2);
        upgradeMode = true;
      } else if (command === 3) {
        assert.equal(upgradeMode, true);
        const transferInfo = new DataView(
          packet.buffer,
          packet.byteOffset + 5,
          8,
        );
        assert.equal(transferInfo.getUint32(0, true), firmware.length);
        assert.equal(transferInfo.getUint32(4, true), crc32(firmware));
      } else assert.equal(command, 0);
      const body = Uint8Array.from([command, 1, 0, 1]);
      const reply = Uint8Array.from([
        0xaa,
        0x55,
        ...body,
        iapCrc8(body),
        ...(command === 2 || command === 3 ? [0x43] : []),
      ]);
      return fragments(reply);
    }
    assert.equal(upgradeMode, true);
    if (packet[0] === 0x04) {
      assert.equal(offset, firmware.length);
      eots += 1;
      if (eots === 1) return fragments([0x15]);
      phase = 'end';
      return fragments([0x06, 0x43]);
    }
    assert.equal(packet[2], ~packet[1] & 0xff);
    const payload = packet.subarray(3, -2);
    assert.equal((packet.at(-2) << 8) | packet.at(-1), crc16(payload));
    if (phase === 'header') {
      assert.equal(packet[0], 0x01);
      assert.equal(packet[1], 0);
      assert.equal(payload.length, 128);
      const metadata = new TextDecoder().decode(payload).split('\0');
      assert.equal(metadata[0], 'firmware.bin');
      assert.equal(metadata[1], String(firmware.length));
      phase = 'data';
      return fragments([0x06, 0x43]);
    }
    if (phase === 'data') {
      assert.equal(packet[0], 0x02);
      assert.equal(packet[1], block);
      assert.equal(payload.length, 1024);
      const sent = Math.min(1024, firmware.length - offset);
      assert.deepEqual(
        payload.subarray(0, sent),
        firmware.subarray(offset, offset + sent),
      );
      assert.ok(payload.subarray(sent).every((byte) => byte === 0x1a));
      offset += sent;
      block += 1;
      return fragments([0x06]);
    }
    assert.equal(phase, 'end');
    assert.equal(packet[0], 0x01);
    assert.equal(packet[1], 0);
    assert.deepEqual(payload, new Uint8Array(128));
    phase = 'done';
    upgradeMode = false;
    return fragments([0x06]);
  });
  const { session } = await connectSelectedDevice(port, 'battery', undefined, {
    onData: (_session, state) => received.push(state),
  });
  const progress = [];
  const stages = [];
  await session.withUpgrade(async (channel) => {
    const count = received.length;
    const iap = new IapSerialSession(channel, () => {}, {
      ...DEFAULT_CONFIG,
      responseTimeoutMs: 100,
      handshakeTimeoutMs: 100,
    });
    try {
      await iap.open();
      await iap.upgrade(
        'firmware.bin',
        firmware,
        (percent) => progress.push(percent),
        (stage) => stages.push(stage),
      );
      assert.equal(
        received.length,
        count,
        'IAP must not populate battery data',
      );
    } finally {
      await iap.close();
    }
  });
  assert.deepEqual(commands, [0, 2, 3]);
  assert.deepEqual(stages, ['handshake', 'writing', 'verifying']);
  assert.equal(phase, 'done');
  assert.equal(progress.at(-1), 100);
  assert.equal(session.isOpen, true);
  assert.equal(received.at(-1).totalVoltageMv, 5000);
  await session.setTemperature(25, 100);
  assert.equal(port.openCount, 1);
  assert.equal(port.closeCount, 0);
  await session.close();
});
