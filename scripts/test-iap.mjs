import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Run the actual TypeScript modules without emitting files or requiring another test dependency.
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
const {
  GENERIC_CONFIG,
  GENERIC_SETTINGS,
  X202_CONFIG,
  DEFAULT_CONFIG,
  CW32L910_CONFIG,
  resolveIapConfig,
} = await import(configUrl);
// Historical board configuration is retained only as a protocol regression fixture.
const CW32L910_SETTINGS = {
  ...GENERIC_SETTINGS,
  protocol: 'iap-ymodem',
  baudRate: '1500000',
  handshakeTimeoutMs: '9000',
  validation: 'cortex-m',
  maxAppSize: '0xBE00',
  appStart: '0x4000',
  ramStart: '0x20000000',
  ramSize: '0x1000',
};
const { IapSerialSession, crc8, crc16, crc32, validateFirmware } = await import(
  moduleUrl(
    (await compile('../lib/iap-protocol.ts')).replace(
      /(['"])\.\/iap-config\1/,
      JSON.stringify(configUrl),
    ),
  )
);

function firmware(size, stack = 0x20001000, reset = 0x4101) {
  const data = Uint8Array.from({ length: size }, (_, index) => index & 255);
  if (size >= 8) {
    const view = new DataView(data.buffer);
    view.setUint32(0, stack, true);
    view.setUint32(4, reset, true);
  }
  return data;
}

class MockPort {
  queue = [];
  pending = null;
  closed = false;
  writes = [];
  options = null;
  readable = {
    getReader: () => ({
      read: () => {
        if (this.queue.length)
          return Promise.resolve({ done: false, value: this.queue.shift() });
        if (this.closed) return Promise.resolve({ done: true });
        return new Promise((resolve) => {
          this.pending = resolve;
        });
      },
      cancel: async () => this.finish(),
      releaseLock() {},
    }),
  };
  writable = {
    getWriter: () => ({
      write: async (data) => {
        this.writes.push(data.slice());
        await Promise.resolve(this.onWrite(data));
      },
      releaseLock() {},
    }),
  };
  constructor(onWrite = () => {}, initial = [0x43]) {
    this.onWrite = onWrite;
    this.initial = initial;
  }
  async open(options) {
    this.options = options;
    if (this.initial.length) this.push(this.initial);
  }
  async close() {
    this.finish();
  }
  getInfo() {
    return {};
  }
  push(bytes) {
    // Fragment responses to exercise the serial inbox and command-frame reader.
    for (const byte of bytes) {
      const value = new Uint8Array([byte]);
      if (this.pending) {
        const pending = this.pending;
        this.pending = null;
        pending({ done: false, value });
      } else this.queue.push(value);
    }
  }
  finish() {
    this.closed = true;
    this.pending?.({ done: true });
    this.pending = null;
  }
}

function receiver(config, data, behavior = {}) {
  let upgradeMode = Boolean(behavior.startBootReady);
  let manifestAccepted = false;
  let phase = 'header';
  let offset = 0;
  let block = 1;
  let eots = 0;
  let retried = false;
  let retriedHeader = false;
  let retriedEnd = false;
  const commands = [];
  const port = new MockPort(
    (packet) => {
      if (packet[0] === 0xaa) {
        assert.equal(config.protocol, 'iap-ymodem');
        const command = packet[2];
        assert.equal(packet[0], 0xaa);
        assert.equal(packet[1], 0x55);
        assert.equal(packet[3] | (packet[4] << 8), packet.length - 6);
        assert.equal(packet.at(-1), crc8(packet.subarray(2, -1)));
        commands.push(command);
        assert.ok([0, 2, 3].includes(command), `unexpected IAP command ${command}`);
        if (command === 3) {
          assert.ok(
            upgradeMode,
            'transfer manifest must follow entry into upgrade mode',
          );
          assert.equal(packet.length, 14);
          const view = new DataView(packet.buffer, packet.byteOffset + 5, 8);
          assert.equal(view.getUint32(0, true), data.length);
          assert.equal(view.getUint32(4, true), crc32(data));
        }
        const accepted =
          (behavior.fallback && command === 2 && packet[5] === 2) ||
          (behavior.rejectManifest && command === 3)
            ? 0
            : 1;
        if (command === 2 && accepted) {
          assert.ok(packet[5] === 2 || packet[5] === 3);
          upgradeMode = true;
          manifestAccepted = false;
        }
        if (command === 3 && accepted) manifestAccepted = true;
        const body = new Uint8Array([command, 1, 0, accepted]);
        port.push([0x00, 0xaa, 0x55, ...body, crc8(body)]);
        if ((command === 2 && accepted) || command === 3) port.push([0x43]);
        return;
      }
      if (packet[0] === 0x04) {
        assert.equal(offset, data.length);
        eots++;
        if (eots === 1 && !behavior.singleEot) port.push([0x15]);
        else {
          port.push([0x06, 0x43]);
          phase = 'end';
        }
        return;
      }
      const payload = packet.subarray(3, -2);
      assert.equal(packet[2], ~packet[1] & 255);
      assert.equal((packet.at(-2) << 8) | packet.at(-1), crc16(payload));
      if (phase === 'header') {
        // IAP_Flash_Init refuses to erase or ACK a header without CMD 3.
        if (config.protocol === 'iap-ymodem' && !manifestAccepted) {
          port.push([0x18, 0x18]);
          return;
        }
        assert.equal(packet[0], 1);
        assert.equal(packet[1], 0);
        assert.equal(payload.length, 128);
        const metadata = new TextDecoder().decode(payload).split('\0');
        assert.equal(metadata[0], 'firmware.bin');
        assert.equal(metadata[1], String(data.length));
        if (behavior.retryHeader && !retriedHeader) {
          retriedHeader = true;
          port.push([0x15]);
          return;
        }
        port.push([0x06, 0x43]);
        phase = 'data';
      } else if (phase === 'end') {
        assert.equal(packet[0], 1);
        assert.equal(packet[1], 0);
        assert.deepEqual(payload, new Uint8Array(128));
        if (behavior.rejectFinal) {
          port.push([0x18, 0x18]);
          return;
        }
        if (behavior.noFinalAck) return;
        if (behavior.dropFinalAck && !retriedEnd) {
          retriedEnd = true;
          return;
        }
        if (behavior.retryEnd && !retriedEnd) {
          retriedEnd = true;
          port.push([0x15]);
          return;
        }
        port.push([0x06]);
        phase = 'done';
      } else {
        assert.equal(phase, 'data');
        assert.equal(packet[0], config.packetSize === 128 ? 1 : 2);
        assert.equal(packet[1], block & 255);
        assert.equal(payload.length, config.packetSize);
        const count = Math.min(config.packetSize, data.length - offset);
        assert.deepEqual(
          payload.subarray(0, count),
          data.subarray(offset, offset + count),
        );
        assert.ok(payload.subarray(count).every((value) => value === 0x1a));
        if (behavior.retryData && !retried) {
          retried = true;
          port.push([0x15]);
          return;
        }
        offset += count;
        block++;
        port.push([0x06]);
      }
    },
    config.protocol === 'ymodem' || behavior.startBootReady ? [0x43] : [],
  );
  return { port, commands, done: () => phase === 'done' };
}

test('CRC reference vectors', () => {
  const vector = new TextEncoder().encode('123456789');
  assert.equal(crc16(vector), 0x31c3);
  assert.equal(crc32(vector), 0xcbf43926);
});

test('generic BINs accept other architectures and sizes above the legacy limit', () => {
  assert.equal(validateFirmware(new Uint8Array([1])), null);
  assert.equal(validateFirmware(new Uint8Array(256 * 1024)), null);
  assert.match(validateFirmware(new Uint8Array()), /不能为空/);
  assert.match(
    validateFirmware(new Uint8Array(1025), {
      ...GENERIC_CONFIG,
      maxAppSize: 1024,
    }),
    /容量/,
  );
});

test('legacy and custom Cortex-M memory bounds, Thumb bit and unsigned addresses', () => {
  const legacy = resolveIapConfig(CW32L910_SETTINGS).config;
  assert.equal(validateFirmware(firmware(0xbe00), legacy), null);
  assert.match(validateFirmware(firmware(0xbe01), legacy), /容量/);
  assert.match(validateFirmware(firmware(256, 0x20000000), legacy), /栈顶/);
  assert.match(validateFirmware(firmware(256, 0x20001004), legacy), /栈顶/);
  assert.match(
    validateFirmware(firmware(256, 0x20001000, 0xfe01), legacy),
    /复位/,
  );
  assert.match(
    validateFirmware(firmware(256, 0x20001000, 0x4100), legacy),
    /复位/,
  );
  const custom = resolveIapConfig({
    ...CW32L910_SETTINGS,
    protocol: 'ymodem',
    appStart: '0x80004000',
    maxAppSize: '0x40000',
    ramSize: '0x5000',
  }).config;
  assert.equal(
    validateFirmware(firmware(65536, 0x20005000, 0x80004101), custom),
    null,
  );
  assert.match(
    validateFirmware(firmware(65536, 0x20005000, 0x08004101), custom),
    /复位/,
  );
});

test('invalid settings are rejected before opening a port', () => {
  for (const patch of [
    { baudRate: '' },
    { baudRate: '-1' },
    { baudRate: '1e6' },
    { maxAttempts: '0' },
    { maxAppSize: '0xGG' },
    { responseTimeoutMs: '1' },
    { packetSize: '512' },
    { validation: 'cortex-m' },
    { protocol: 'unknown' },
  ])
    assert.ok(
      resolveIapConfig({ ...GENERIC_SETTINGS, ...patch }).error,
      JSON.stringify(patch),
    );
  assert.ok(
    resolveIapConfig({ ...CW32L910_SETTINGS, appStart: '0xfffff000' }).error,
  );
  assert.ok(
    resolveIapConfig({ ...CW32L910_SETTINGS, ramSize: '0x1001' }).error,
  );
});

for (const scenario of [
  {
    name: 'generic 1K with initial buffered C and single EOT ACK',
    config: GENERIC_CONFIG,
    size: 49153,
    behavior: { singleEot: true },
  },
  {
    name: 'generic 128-byte packets and sequence rollover',
    config: { ...GENERIC_CONFIG, packetSize: 128 },
    size: 33025,
    behavior: {},
  },
  {
    name: 'NAK retries preserve header, data and final packet',
    config: GENERIC_CONFIG,
    size: 1025,
    behavior: { retryHeader: true, retryData: true, retryEnd: true },
  },
  {
    name: 'CW32L910 command frames and CRC32 compatibility',
    config: resolveIapConfig(CW32L910_SETTINGS).config,
    size: 2049,
    behavior: {},
  },
  {
    name: 'IAP + Ymodem fallback entry command',
    config: resolveIapConfig(CW32L910_SETTINGS).config,
    size: 2049,
    behavior: { fallback: true },
  },
])
  test(scenario.name, async () => {
    const data = firmware(scenario.size);
    const { port, commands, done } = receiver(
      scenario.config,
      data,
      scenario.behavior,
    );
    const stages = [],
      progress = [];
    const session = new IapSerialSession(port, () => {}, scenario.config);
    try {
      await session.open();
      await session.upgrade(
        'firmware.bin',
        data,
        (percent, sent) => progress.push([percent, sent]),
        (stage) => stages.push(stage),
      );
      assert.ok(done());
      assert.equal(port.options.baudRate, scenario.config.baudRate);
      assert.deepEqual(stages, ['handshake', 'writing', 'verifying']);
      assert.deepEqual(progress.at(-1), [100, data.length]);
      assert.deepEqual(
        commands,
        scenario.config.protocol === 'ymodem'
          ? []
          : scenario.behavior.fallback
            ? [0, 2, 2, 3]
            : [0, 2, 3],
      );
    } finally {
      await session.close();
    }
    assert.ok(port.closed);
  });

test('failed port open does not close a port the session never opened', async () => {
  const port = new MockPort();
  const failure = new Error('port is already open');
  let closeCalls = 0;
  port.open = async () => {
    throw failure;
  };
  port.close = async () => {
    closeCalls++;
  };
  const session = new IapSerialSession(port, () => {});
  await assert.rejects(session.open(), (error) => error === failure);
  await session.close();
  assert.equal(closeCalls, 0);
});

test('port close failure propagates and retry releases the physical port once', async () => {
  const port = new MockPort(() => {}, []);
  const getReader = port.readable.getReader;
  const failure = new Error('port close failed');
  let closeCalls = 0;
  let cancelCalls = 0;
  let releaseCalls = 0;
  port.readable.getReader = () => {
    const reader = getReader();
    return {
      read: reader.read,
      cancel: async () => {
        cancelCalls++;
        await reader.cancel();
      },
      releaseLock: () => {
        releaseCalls++;
        reader.releaseLock();
      },
    };
  };
  port.close = async () => {
    closeCalls++;
    if (closeCalls === 1) throw failure;
    port.finish();
  };
  const session = new IapSerialSession(port, () => {});
  await session.open();
  await assert.rejects(session.close(), (error) => error === failure);
  assert.equal(port.pending, null);
  await session.close();
  await session.close();
  assert.equal(closeCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(releaseCalls, 1);
});

test('timeout retries are bounded', async () => {
  const port = new MockPort();
  const session = new IapSerialSession(port, () => {}, {
    ...GENERIC_CONFIG,
    responseTimeoutMs: 5,
    maxAttempts: 2,
  });
  try {
    await session.open();
    await assert.rejects(
      session.upgrade(
        'firmware.bin',
        firmware(1024),
        () => {},
        () => {},
      ),
      /连续 2 次尝试失败/,
    );
    assert.equal(port.writes.length, 2);
    assert.deepEqual(port.writes[0], port.writes[1]);
  } finally {
    await session.close();
  }
});

test('cancel immediately wakes the handshake and sends CAN CAN', async () => {
  const port = new MockPort(() => {}, []);
  const session = new IapSerialSession(port, () => {}, GENERIC_CONFIG);
  try {
    await session.open();
    const transfer = session.upgrade(
      'firmware.bin',
      firmware(1024),
      () => {},
      () => {},
    );
    const rejected = assert.rejects(transfer, /升级已取消/);
    await session.cancel();
    await rejected;
    assert.deepEqual(port.writes, [new Uint8Array([0x18, 0x18])]);
  } finally {
    await session.close();
  }
});

for (const reason of ['disconnect', 'device cancel'])
  test(`${reason} stops without retries`, async () => {
    const port = new MockPort(() =>
      reason === 'disconnect' ? port.finish() : port.push([0x18, 0x18]),
    );
    const session = new IapSerialSession(port, () => {}, GENERIC_CONFIG);
    try {
      await session.open();
      await assert.rejects(
        session.upgrade(
          'firmware.bin',
          firmware(1024),
          () => {},
          () => {},
        ),
        reason === 'disconnect' ? /串口已断开/ : /设备取消/,
      );
      assert.equal(port.writes.length, 1);
    } finally {
      await session.close();
    }
  });

for (const { name, data, expected } of [
  { name: 'oversized APP', data: firmware(0xb401, 0x20002000, 0x48d9), expected: /容量/ },
  { name: 'invalid stack', data: firmware(1024, 0x20002004, 0x48d9), expected: /栈顶/ },
  { name: 'wrong APP address', data: firmware(1024, 0x20002000, 0x40d9), expected: /复位/ },
  { name: 'entry outside BIN', data: firmware(128, 0x20002000, 0x48d9), expected: /文件范围/ },
])
  test(`default X202 rejects ${name} before sending any serial bytes`, async () => {
    const port = new MockPort();
    const session = new IapSerialSession(port, () => {}, DEFAULT_CONFIG);
    try {
      await session.open();
      await assert.rejects(
        session.upgrade('firmware.bin', data, () => {}, () => {}),
        expected,
      );
      assert.equal(port.writes.length, 0);
    } finally {
      await session.close();
    }
  });

test('default X202 memory bounds and response timeout match the Bootloader', () => {
  assert.deepEqual(DEFAULT_CONFIG, X202_CONFIG);
  assert.equal(DEFAULT_CONFIG.protocol, 'iap-ymodem');
  assert.equal(DEFAULT_CONFIG.baudRate, 1500000);
  assert.equal(DEFAULT_CONFIG.packetSize, 128);
  assert.equal(DEFAULT_CONFIG.responseTimeoutMs, 5000);
  assert.ok(DEFAULT_CONFIG.responseTimeoutMs < 7000);
  assert.equal(DEFAULT_CONFIG.maxAppSize, 0xb400);
  assert.deepEqual(DEFAULT_CONFIG.vectorTable, {
    appStart: 0x4800,
    ramStart: 0x20000000,
    ramSize: 0x2000,
  });
  assert.equal(
    validateFirmware(firmware(0xb400, 0x20002000, 0x48d9), DEFAULT_CONFIG),
    null,
  );
  assert.match(
    validateFirmware(firmware(0xb401, 0x20002000, 0x48d9), DEFAULT_CONFIG),
    /容量/,
  );
  assert.match(
    validateFirmware(firmware(1024, 0x20002004, 0x48d9), X202_CONFIG),
    /栈顶/,
  );
  assert.match(
    validateFirmware(firmware(1024, 0x20001f30, 0x40d9), X202_CONFIG),
    /复位/,
  );
  assert.match(
    validateFirmware(firmware(128, 0x20001f30, 0x48d9), X202_CONFIG),
    /文件范围/,
  );
});

for (const { name, behavior } of [
  { name: 'default APP entry', behavior: {} },
  {
    name: 'Bootloader entry with fallback',
    behavior: { fallback: true, startBootReady: true },
  },
  { name: 'lost final ACK', behavior: { dropFinalAck: true } },
])
  test(`X202 ${name}: manifest, data, CRC and completion`, async () => {
    const config = { ...DEFAULT_CONFIG, responseTimeoutMs: 20 };
    const data = firmware(39448, 0x20001f30, 0x48d9);
    const { port, commands, done } = receiver(config, data, behavior);
    const session = new IapSerialSession(port, () => {}, config);
    try {
      await session.open();
      await session.upgrade(
        'firmware.bin',
        data,
        () => {},
        () => {},
      );
      assert.ok(done());
      assert.deepEqual(commands, behavior.fallback ? [0, 2, 2, 3] : [0, 2, 3]);
      if (behavior.dropFinalAck)
        assert.equal(
          port.writes.filter(
            (packet) =>
              packet.length === 133 && packet[1] === 0 && packet[3] === 0,
          ).length,
          2,
        );
    } finally {
      await session.close();
    }
  });

test('X202 missing final ACK retries are bounded and never report success', async () => {
  const config = { ...DEFAULT_CONFIG, responseTimeoutMs: 20, maxAttempts: 2 };
  const data = firmware(1024, 0x20002000, 0x48d9);
  const { port, commands, done } = receiver(config, data, { noFinalAck: true });
  const logs = [];
  const session = new IapSerialSession(port, (message) => logs.push(message), config);
  try {
    await session.open();
    await assert.rejects(
      session.upgrade('firmware.bin', data, () => {}, () => {}),
      /结束文件头 连续 2 次尝试失败/,
    );
    assert.deepEqual(commands, [0, 2, 3]);
    assert.equal(done(), false);
    const finalPackets = port.writes.filter(
      (packet) => packet.length === 133 && packet[1] === 0 && packet[3] === 0,
    );
    assert.equal(finalPackets.length, config.maxAttempts);
    assert.deepEqual(finalPackets[0], finalPackets[1]);
    assert.ok(logs.every((message) => !/固件传输完成|设备已确认接收/.test(message)));
  } finally {
    await session.close();
  }
});

for (const [name, config, behavior, expected] of [
  [
    'pure YMODEM without manifest',
    GENERIC_CONFIG,
    { startBootReady: true },
    /设备取消/,
  ],
  [
    'manifest rejected',
    X202_CONFIG,
    { rejectManifest: true },
    /拒绝了固件大小或 CRC32/,
  ],
  [
    'final device verification rejected',
    X202_CONFIG,
    { rejectFinal: true },
    /设备取消/,
  ],
])
  test(`X202 rejects ${name}`, async () => {
    const data = firmware(1024, 0x20001f30, 0x48d9);
    const { port, done } = receiver(X202_CONFIG, data, behavior);
    const session = new IapSerialSession(port, () => {}, config);
    try {
      await session.open();
      await assert.rejects(
        session.upgrade(
          'firmware.bin',
          data,
          () => {},
          () => {},
        ),
        expected,
      );
      assert.equal(done(), false);
      if (behavior.rejectManifest)
        assert.ok(port.writes.every((packet) => packet[0] === 0xaa));
    } finally {
      await session.close();
    }
  });

test(
  'supplied CW32L910 APP BIN validates and completes the simulated transfer',
  {
    skip: !process.env.IAP_TEST_FIRMWARE,
  },
  async () => {
    const data = new Uint8Array(await readFile(process.env.IAP_TEST_FIRMWARE));
    assert.equal(validateFirmware(data, CW32L910_CONFIG), null);
    const { port, done } = receiver(CW32L910_CONFIG, data);
    const session = new IapSerialSession(port, () => {}, CW32L910_CONFIG);
    try {
      await session.open();
      await session.upgrade(
        'firmware.bin',
        data,
        () => {},
        () => {},
      );
      assert.ok(done());
    } finally {
      await session.close();
    }
  },
);

test('CW32L910 transfers manifest and firmware using only IAP commands', async () => {
  const data = firmware(2048);
  const { port, commands, done } = receiver(CW32L910_CONFIG, data);
  const session = new IapSerialSession(port, () => {}, CW32L910_CONFIG);
  try {
    await session.open();
    await session.upgrade('firmware.bin', data, () => {}, () => {});
    assert.deepEqual(commands, [0, 2, 3]);
    assert.ok(done());
  } finally { await session.close(); }
});
