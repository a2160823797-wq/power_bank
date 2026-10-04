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
const { DEFAULT_CONFIG, IAP_BAUD_RATE, IAP_PACKET_SIZE } = await import(
  configUrl
);
// This fixture belongs to the simulated receiving Bootloader, never to host configuration.
const X202_BOARD = {
  appCapacity: 0xb400,
  appStart: 0x4800,
  ramStart: 0x20000000,
  ramSize: 0x2000,
};
const { IapSerialSession, crc8, crc16, crc32, validateFirmware } = await import(
  moduleUrl(
    (await compile('../lib/iap-protocol.ts')).replace(
      /(['"])\.\/iap-config\1/,
      JSON.stringify(configUrl),
    ),
  )
);
function firmware(size, stack = 0x20001000, reset = 0x4801) {
  const data = Uint8Array.from({ length: size }, (_, index) => index & 255);
  if (size >= 8) {
    const view = new DataView(data.buffer);
    view.setUint32(0, stack, true);
    view.setUint32(4, reset, true);
  }
  return data;
}

function boardAcceptsFirmware(data, board) {
  // Model IAP_APP_Is_Valid in the receiving X202 Bootloader.
  if (data.length < 8 || data.length > board.appCapacity) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const stack = view.getUint32(0, true);
  const reset = view.getUint32(4, true);
  const entry = (reset & 0xfffffffe) >>> 0;
  return (
    stack >= board.ramStart &&
    stack <= board.ramStart + board.ramSize &&
    (stack & 3) === 0 &&
    (reset & 1) !== 0 &&
    entry >= board.appStart &&
    entry < board.appStart + data.length
  );
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

function receiver(data, behavior = {}) {
  let upgradeMode = Boolean(behavior.startBootReady);
  let manifestAccepted = false;
  let phase = 'header';
  let offset = 0;
  let block = 1;
  let eots = 0;
  let retried = false;
  let retriedHeader = false;
  let retriedEnd = false;
  let manifestCrc;
  const receivedFirmware = new Uint8Array(data.length);
  const commands = [];
  const port = new MockPort(
    (packet) => {
      if (packet[0] === 0xaa) {
        const command = packet[2];
        assert.equal(packet[0], 0xaa);
        assert.equal(packet[1], 0x55);
        assert.equal(packet[3] | (packet[4] << 8), packet.length - 6);
        assert.equal(packet.at(-1), crc8(packet.subarray(2, -1)));
        commands.push(command);
        assert.ok(
          [0, 2, 3].includes(command),
          `unexpected IAP command ${command}`,
        );
        if (command === 3) {
          assert.ok(
            upgradeMode,
            'transfer manifest must follow entry into upgrade mode',
          );
          assert.equal(packet.length, 14);
          const view = new DataView(packet.buffer, packet.byteOffset + 5, 8);
          assert.equal(view.getUint32(0, true), data.length);
          assert.equal(view.getUint32(4, true), crc32(data));
          manifestCrc = view.getUint32(4, true);
        }
        const accepted =
          (behavior.fallback && command === 2 && packet[5] === 2) ||
          (command === 3 &&
            (behavior.rejectManifest ||
              (behavior.board &&
                (data.length < 8 || data.length > behavior.board.appCapacity))))
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
      if (behavior.reject1kData && packet[0] === 2) {
        assert.equal(phase, 'data');
        assert.ok(manifestAccepted);
        assert.equal(packet.length, IAP_PACKET_SIZE + 5);
        port.push([0x18, 0x18]);
        return;
      }
      const payload = packet.subarray(3, -2);
      assert.equal(packet[2], ~packet[1] & 255);
      assert.equal((packet.at(-2) << 8) | packet.at(-1), crc16(payload));
      if (phase === 'header') {
        // IAP_Flash_Init refuses to erase or ACK a header without CMD 3.
        if (!manifestAccepted) {
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
        if (behavior.noHeaderAck) return;
        port.push([0x06, 0x43]);
        phase = 'data';
      } else if (phase === 'end') {
        assert.equal(packet[0], 1);
        assert.equal(packet[1], 0);
        assert.deepEqual(payload, new Uint8Array(128));
        if (
          behavior.rejectFinal ||
          crc32(receivedFirmware) !== manifestCrc ||
          (behavior.board &&
            !boardAcceptsFirmware(receivedFirmware, behavior.board))
        ) {
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
        assert.equal(packet[0], 2);
        assert.equal(packet[1], block & 255);
        assert.equal(payload.length, IAP_PACKET_SIZE);
        const count = Math.min(IAP_PACKET_SIZE, data.length - offset);
        assert.deepEqual(
          payload.subarray(0, count),
          data.subarray(offset, offset + count),
        );
        assert.ok(payload.subarray(count).every((value) => value === 0x1a));
        if (behavior.stopAtData) {
          if (behavior.stopAtData === 'disconnect') port.finish();
          else port.push([0x18, 0x18]);
          return;
        }
        if (behavior.retryData && !retried) {
          retried = true;
          port.push([0x15]);
          return;
        }
        receivedFirmware.set(payload.subarray(0, count), offset);
        if (behavior.corruptFlash && offset === 0) receivedFirmware[0] ^= 1;
        offset += count;
        block++;
        port.push([0x06]);
      }
    },
    behavior.startBootReady ? [0x43] : [],
  );
  return { port, commands, done: () => phase === 'done' };
}

test('CRC reference vectors', () => {
  const vector = new TextEncoder().encode('123456789');
  assert.equal(crc16(vector), 0x31c3);
  assert.equal(crc32(vector), 0xcbf43926);
});

test('universal transport has fixed baud, packet size and internal timeouts', () => {
  assert.equal(IAP_BAUD_RATE, 1500000);
  assert.equal(IAP_PACKET_SIZE, 1024);
  assert.deepEqual(DEFAULT_CONFIG, {
    responseTimeoutMs: 5000,
    handshakeTimeoutMs: 30000,
    maxAttempts: 10,
  });
  assert.ok(DEFAULT_CONFIG.responseTimeoutMs < 7000);
});

test('host validates only nonempty firmware and the unsigned 32-bit manifest length', () => {
  assert.match(validateFirmware(new Uint8Array()), /不能为空/);
  assert.match(validateFirmware({ length: 0x100000000 }), /32 位长度/);
  assert.equal(validateFirmware({ length: 0xffffffff }), null);
  assert.equal(validateFirmware(new Uint8Array([1])), null);
  assert.equal(validateFirmware(new Uint8Array(1024)), null);
  assert.equal(validateFirmware(firmware(0xb401)), null);
  assert.equal(validateFirmware(firmware(256 * 1024 + 1)), null);
  assert.equal(validateFirmware(firmware(1024, 0x80001000, 0x00000100)), null);
  assert.equal(validateFirmware(firmware(1024, 0x20005000, 0x08004101)), null);
});

for (const data of [new Uint8Array(), { length: 0x100000000 }])
  test(
    'host rejects invalid manifest length before sending any serial bytes: ' +
      data.length,
    async () => {
      const port = new MockPort();
      const session = new IapSerialSession(port, () => {});
      try {
        await session.open();
        await assert.rejects(
          session.upgrade(
            'firmware.bin',
            data,
            () => {},
            () => {},
          ),
          /不能为空|32 位长度/,
        );
        assert.equal(port.writes.length, 0);
      } finally {
        await session.close();
      }
    },
  );

for (const scenario of [
  {
    name: 'default IAP + YMODEM 1K with initial buffered C and single EOT ACK',
    config: DEFAULT_CONFIG,
    size: 0xb3ff,
    behavior: { startBootReady: true, singleEot: true },
  },
  {
    name: 'generic 1K packets and sequence rollover',
    config: DEFAULT_CONFIG,
    size: 256 * 1024 + 1,
    behavior: {},
  },
  {
    name: 'NAK retries preserve header, data and final packet',
    config: DEFAULT_CONFIG,
    size: 1025,
    behavior: { retryHeader: true, retryData: true, retryEnd: true },
  },
  {
    name: 'single-byte non-Cortex-M firmware with universal command frames and CRC32',
    config: DEFAULT_CONFIG,
    size: 1,
    behavior: {},
  },
  {
    name: 'IAP + YMODEM fallback entry command',
    config: DEFAULT_CONFIG,
    size: 2049,
    behavior: { fallback: true },
  },
])
  test(scenario.name, async () => {
    const data = firmware(scenario.size);
    const { port, commands, done } = receiver(data, scenario.behavior);
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
      assert.equal(port.options.baudRate, IAP_BAUD_RATE);
      assert.deepEqual(stages, ['handshake', 'writing', 'verifying']);
      assert.deepEqual(progress.at(-1), [100, data.length]);
      assert.deepEqual(
        commands,
        scenario.behavior.fallback ? [0, 2, 2, 3] : [0, 2, 3],
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
  const config = {
    ...DEFAULT_CONFIG,
    responseTimeoutMs: 5,
    maxAttempts: 2,
  };
  const data = firmware(1024);
  const { port, commands } = receiver(data, { noHeaderAck: true });
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
      /连续 2 次尝试失败/,
    );
    assert.deepEqual(commands, [0, 2, 3]);
    const headers = port.writes.filter((packet) => packet[0] === 1);
    assert.equal(headers.length, 2);
    assert.deepEqual(headers[0], headers[1]);
  } finally {
    await session.close();
  }
});

test('cancel immediately wakes the handshake and sends CAN CAN', async () => {
  const port = new MockPort(() => {}, []);
  const session = new IapSerialSession(port, () => {}, DEFAULT_CONFIG);
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
    assert.equal(port.writes.length, 2);
    assert.equal(port.writes[0][0], 0xaa);
    assert.equal(port.writes[0][2], 0);
    assert.deepEqual(port.writes[1], new Uint8Array([0x18, 0x18]));
  } finally {
    await session.close();
  }
});

for (const reason of ['disconnect', 'device cancel'])
  test(`${reason} stops without retries`, async () => {
    const data = firmware(1024);
    const { port, commands } = receiver(data, {
      stopAtData: reason,
    });
    const session = new IapSerialSession(port, () => {}, DEFAULT_CONFIG);
    try {
      await session.open();
      await assert.rejects(
        session.upgrade(
          'firmware.bin',
          data,
          () => {},
          () => {},
        ),
        reason === 'disconnect' ? /串口已断开/ : /设备取消/,
      );
      assert.deepEqual(commands, [0, 2, 3]);
      assert.equal(port.writes.filter((packet) => packet[0] === 2).length, 1);
    } finally {
      await session.close();
    }
  });

for (const { name, data, rejectionStage } of [
  {
    name: 'oversized APP',
    data: firmware(0xb401, 0x20002000, 0x48d9),
    rejectionStage: 'manifest',
  },
  {
    name: 'short APP',
    data: new Uint8Array([1]),
    rejectionStage: 'manifest',
  },
  {
    name: 'invalid stack',
    data: firmware(1024, 0x20002004, 0x48d9),
    rejectionStage: 'verification',
  },
  {
    name: 'wrong APP address',
    data: firmware(1024, 0x20002000, 0x40d9),
    rejectionStage: 'verification',
  },
  {
    name: 'entry outside BIN',
    data: firmware(128, 0x20002000, 0x48d9),
    rejectionStage: 'verification',
  },
  {
    name: 'non-Cortex-M firmware',
    data: new Uint8Array(1024),
    rejectionStage: 'verification',
  },
])
  test(
    'X202 receiving Bootloader rejects ' +
      name +
      ' after host accepts transport',
    async () => {
      assert.equal(validateFirmware(data), null);
      const { port, commands, done } = receiver(data, { board: X202_BOARD });
      const session = new IapSerialSession(port, () => {});
      try {
        await session.open();
        await assert.rejects(
          session.upgrade(
            'firmware.bin',
            data,
            () => {},
            () => {},
          ),
          rejectionStage === 'manifest' ? /拒绝了固件大小或 CRC32/ : /设备取消/,
        );
        assert.deepEqual(commands, [0, 2, 3]);
        assert.equal(done(), false);
        if (rejectionStage === 'manifest')
          assert.ok(port.writes.every((packet) => packet[0] === 0xaa));
        else {
          assert.ok(port.writes.some((packet) => packet[0] === 2));
          assert.ok(port.writes.some((packet) => packet[0] === 0x04));
        }
      } finally {
        await session.close();
      }
    },
  );

for (const { name, behavior } of [
  { name: 'default APP entry', behavior: {} },
  {
    name: 'Bootloader entry with fallback',
    behavior: { fallback: true, startBootReady: true },
  },
  { name: 'lost final ACK', behavior: { dropFinalAck: true } },
])
  test(`X202 ${name}: manifest, 1K data, CRC and completion`, async () => {
    const config = { ...DEFAULT_CONFIG, responseTimeoutMs: 20 };
    const data = firmware(39448, 0x20001f30, 0x48d9);
    const { port, commands, done } = receiver(data, {
      ...behavior,
      board: X202_BOARD,
    });
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
      assert.equal(
        port.writes.filter((packet) => packet[0] === 2).length,
        Math.ceil(data.length / IAP_PACKET_SIZE),
      );
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
  const { port, commands, done } = receiver(data, {
    noFinalAck: true,
    board: X202_BOARD,
  });
  const logs = [];
  const session = new IapSerialSession(
    port,
    (message) => logs.push(message),
    config,
  );
  try {
    await session.open();
    await assert.rejects(
      session.upgrade(
        'firmware.bin',
        data,
        () => {},
        () => {},
      ),
      /结束文件头 连续 2 次尝试失败/,
    );
    assert.deepEqual(commands, [0, 2, 3]);
    assert.equal(done(), false);
    const finalPackets = port.writes.filter(
      (packet) => packet.length === 133 && packet[1] === 0 && packet[3] === 0,
    );
    assert.equal(finalPackets.length, config.maxAttempts);
    assert.deepEqual(finalPackets[0], finalPackets[1]);
    assert.ok(
      logs.every((message) => !/固件传输完成|设备已确认接收/.test(message)),
    );
  } finally {
    await session.close();
  }
});

for (const [name, config, behavior, expected] of [
  [
    'manifest rejected',
    DEFAULT_CONFIG,
    { rejectManifest: true },
    /拒绝了固件大小或 CRC32/,
  ],
  [
    'final device verification rejected',
    DEFAULT_CONFIG,
    { rejectFinal: true },
    /设备取消/,
  ],
  [
    'written firmware CRC32 mismatch',
    DEFAULT_CONFIG,
    { corruptFlash: true },
    /设备取消/,
  ],
])
  test(`X202 rejects ${name}`, async () => {
    const data = firmware(1024, 0x20001f30, 0x48d9);
    const { port, done } = receiver(data, { ...behavior, board: X202_BOARD });
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
  'supplied APP BIN transfers to a 1K-capable simulated receiver without host memory profile',
  {
    skip: !process.env.IAP_TEST_FIRMWARE,
  },
  async () => {
    const data = new Uint8Array(await readFile(process.env.IAP_TEST_FIRMWARE));
    assert.equal(validateFirmware(data, DEFAULT_CONFIG), null);
    const { port, done } = receiver(data);
    const session = new IapSerialSession(port, () => {}, DEFAULT_CONFIG);
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

test('universal host transfers firmware at another target address to a 1K-capable simulated receiver', async () => {
  const data = firmware(2048, 0x20001000, 0x4101);
  const { port, commands, done } = receiver(data);
  const session = new IapSerialSession(port, () => {}, DEFAULT_CONFIG);
  try {
    await session.open();
    await session.upgrade(
      'firmware.bin',
      data,
      () => {},
      () => {},
    );
    assert.deepEqual(commands, [0, 2, 3]);
    assert.ok(done());
  } finally {
    await session.close();
  }
});

test('CW32L910 current 128-only Bootloader rejects the first 1K data packet without retries or success', async () => {
  const data = firmware(2048, 0x20001000, 0x4101);
  const { port, commands, done } = receiver(data, {
    reject1kData: true,
  });
  const logs = [];
  const session = new IapSerialSession(
    port,
    (message) => logs.push(message),
    DEFAULT_CONFIG,
  );
  try {
    await session.open();
    await assert.rejects(
      session.upgrade(
        'firmware.bin',
        data,
        () => {},
        () => {},
      ),
      /设备取消/,
    );
    assert.deepEqual(commands, [0, 2, 3]);
    assert.equal(port.writes.filter((packet) => packet[0] === 2).length, 1);
    assert.equal(
      port.writes.some((packet) => packet[0] === 0x04),
      false,
    );
    assert.equal(
      port.writes.some(
        (packet) => packet.length === 133 && packet[1] === 0 && packet[3] === 0,
      ),
      false,
    );
    assert.equal(done(), false);
    assert.ok(
      logs.every((message) => !/固件传输完成|设备已确认接收/.test(message)),
    );
  } finally {
    await session.close();
  }
});
