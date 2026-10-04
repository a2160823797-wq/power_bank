import { crc8, type SerialPortLike } from './iap-protocol';

const BEIJING_OFFSET_SECONDS = 8 * 60 * 60;
const COMMAND_INTERVAL_MS = 8;
const MAX_PAYLOAD = 512;

export interface SafetyRecord {
  id: number;
  type: 'overvoltage' | 'overtemperature';
  cell: number; // 0 为整组电池，1～16 为对应串
  state: 'idle' | 'discharging' | 'charging';
  value: number; // 过充电压为 mV，异常温度为有符号 0.1℃
  timeUnixSeconds: number | null; // 转换后的 UTC 秒，设备上报 0 时为未知
}

export interface BatteryState {
  temperatureC: number | null;
  totalVoltageMv: number | null;
  cellVoltagesMv: (number | null)[];
  cellCount: number | null;
  batteryModel: string | null;
  batteryCode: string | null;
  manufacturer: string | null;
  productionDate: string | null;
  records: SafetyRecord[];
  historyStatus: 'unread' | 'receiving' | 'complete' | 'incomplete';
  historyExpected: number | null;
  lastReceivedAt: number | null;
}

export function createBatteryState(): BatteryState {
  return {
    temperatureC: null,
    totalVoltageMv: null,
    cellVoltagesMv: [],
    cellCount: null,
    batteryModel: null,
    batteryCode: null,
    manufacturer: null,
    productionDate: null,
    records: [],
    historyStatus: 'unread',
    historyExpected: null,
    lastReceivedAt: null,
  };
}

export function batteryFrame(
  command: number,
  payload: Uint8Array = new Uint8Array(),
) {
  if (payload.length > MAX_PAYLOAD) throw new Error('监测帧数据过长');
  const frame = new Uint8Array(payload.length + 6);
  frame.set([0xaa, 0xbb, command, payload.length & 0xff, payload.length >> 8]);
  frame.set(payload, 5);
  frame[frame.length - 1] = crc8(frame.subarray(2, frame.length - 1));
  return frame;
}

function supportedLength(command: number, length: number) {
  switch (command & 0x7f) {
    case 0x02:
      return length >= 2 && length <= 256;
    case 0x08:
      return length >= 4 && length <= MAX_PAYLOAD;
    case 0x0a:
      return length === 3 || length === 16;
    default:
      return length <= MAX_PAYLOAD;
  }
}

// 按外层帧边界隔离 IAP/NTC 数据，载荷中的 AA BB 不进入监测通道。
export class BatteryFrameParser {
  private bytes: number[] = [];

  constructor(
    private readonly onFrame: (command: number, payload: Uint8Array) => void,
    private readonly onInvalid: () => void = () => {},
  ) {}

  clear() {
    this.bytes = [];
  }

  push(chunk: Uint8Array) {
    // 按字节消费，避免串口大块日志导致无限缓存或展开参数溢出。
    for (const byte of chunk) {
      this.bytes.push(byte);
      this.drain();
    }
  }

  private drain() {
    while (this.bytes.length >= 2) {
      if (this.bytes[0] !== 0xaa) {
        this.bytes.shift();
        continue;
      }
      if (this.bytes[1] === 0x55) {
        if (this.bytes.length < 5) return;
        const length = this.bytes[3] | (this.bytes[4] << 8);
        if (length > 128) {
          this.bytes.shift();
          continue;
        }
        if (this.bytes.length < length + 6) return;
        this.bytes.splice(0, length + 6);
        continue;
      }
      if (this.bytes[1] === 0x81 || this.bytes[1] === 0x82) {
        if (this.bytes.length < 12) return;
        this.bytes.splice(0, 12);
        continue;
      }
      if (this.bytes[1] !== 0xbb) {
        this.bytes.shift();
        continue;
      }
      if (this.bytes.length < 5) return;
      const command = this.bytes[2];
      const length = this.bytes[3] | (this.bytes[4] << 8);
      if (!supportedLength(command, length)) {
        this.onInvalid();
        this.bytes.shift();
        continue;
      }
      if (!this.possiblePayload(command & 0x7f, length)) {
        this.onInvalid();
        this.bytes.shift();
        continue;
      }
      if (this.bytes.length < length + 6) {
        // 合法二进制载荷也可能包含 AA BB 和有效 CRC，先等外层帧完整。
        return;
      }
      const frame = Uint8Array.from(this.bytes.slice(0, length + 6));
      if (
        crc8(frame.subarray(2, frame.length - 1)) !== frame[frame.length - 1]
      ) {
        this.onInvalid();
        this.bytes.splice(0, frame.length);
        continue;
      }
      this.bytes.splice(0, frame.length);
      this.onFrame(command & 0x7f, frame.slice(5, -1));
    }
  }

  private possiblePayload(command: number, length: number) {
    if (this.bytes.length < 6) return true;
    const type = this.bytes[5];
    if (command === 0x02) {
      if (type <= 3) return length === 3;
      if (type === 13) return length === 2;
      if (type === 15 || type === 16) return this.possibleAscii(6, length + 5);
      if (type === 0x12 && this.bytes.length >= 7) {
        const count = this.bytes[6];
        return count >= 1 && count <= 16 && length === count * 2 + 2;
      }
    } else if (command === 0x08) {
      const modelLength = type;
      if (
        modelLength === 0 ||
        length < modelLength + 3 ||
        length > modelLength + 257
      )
        return false;
      const codeOffset = modelLength + 6;
      if (!this.possibleAscii(6, codeOffset)) return false;
      if (this.bytes.length > codeOffset) {
        const codeLength = this.bytes[codeOffset];
        return (
          codeLength > 0 &&
          length === modelLength + codeLength + 2 &&
          this.possibleAscii(codeOffset + 1, length + 5)
        );
      }
    } else if (command === 0x0a) {
      return type === 1
        ? length === 16
        : (type === 0 || type === 2) && length === 3;
    }
    return true;
  }

  private possibleAscii(start: number, end: number) {
    for (
      let index = start;
      index < Math.min(end, this.bytes.length);
      index += 1
    ) {
      if (this.bytes[index] < 0x20 || this.bytes[index] > 0x7e) return false;
    }
    return true;
  }
}

function ascii(bytes: Uint8Array) {
  if (!bytes.length || bytes.some((byte) => byte < 0x20 || byte > 0x7e))
    return null;
  return String.fromCharCode(...bytes);
}

function deviceTimeToUnix(seconds: number) {
  return seconds === 0 ? null : seconds - BEIJING_OFFSET_SECONDS;
}

interface BatteryCallbacks {
  onData(state: BatteryState): void;
  onDisconnect(): void;
  onError(message: string): void;
}

export class BatteryIdentityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`设备未响应电池识别请求（${timeoutMs} ms）`);
    this.name = 'BatteryIdentityTimeoutError';
  }
}

interface BatteryIdentity {
  model: string;
  code: string;
}

interface PendingIdentity {
  sent: boolean;
  resolve(identity: BatteryIdentity): void;
  reject(error: Error): void;
}

function identityAbortError() {
  return new DOMException('设备识别已取消', 'AbortError');
}

export class BatterySerialSession {
  private state = createBatteryState();
  private reader: ReturnType<
    NonNullable<SerialPortLike['readable']>['getReader']
  > | null = null;
  private writer: ReturnType<
    NonNullable<SerialPortLike['writable']>['getWriter']
  > | null = null;
  private openTask: Promise<void> | null = null;
  private readTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private opened = false;
  private active = false;
  private closing = false;
  private notifyDisconnect = false;
  private lastWriteAt = 0;
  private cancelWriteDelay: (() => void) | null = null;
  private historyStarted = false;
  private historyInvalid = false;
  private historyRecords = new Map<number, SafetyRecord>();
  private pendingIdentity: PendingIdentity | null = null;
  private readonly parser: BatteryFrameParser;

  constructor(
    private readonly port: SerialPortLike,
    private readonly callbacks: BatteryCallbacks,
  ) {
    this.parser = new BatteryFrameParser(
      (command, payload) => this.receive(command, payload),
      () => {
        if (this.historyStarted) this.historyInvalid = true;
      },
    );
  }

  get isOpen() {
    return this.active && !this.closing;
  }

  async open() {
    if (this.closing) throw new Error('串口会话已关闭，请重新连接');
    this.openTask ??= this.openPort();
    try {
      await this.openTask;
    } catch (error) {
      if (!this.closing) this.callbacks.onError(this.errorMessage(error));
      await this.close();
      throw error;
    }
  }

  private async openPort() {
    await this.port.open({
      baudRate: 1500000,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 65536,
    });
    this.opened = true;
    if (this.closing) return;
    if (!this.port.readable || !this.port.writable)
      throw new Error('串口读写通道不可用');
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.state = createBatteryState();
    this.active = true;
    this.emit();
    this.readTask = this.readLoop();
  }

  close() {
    this.notifyDisconnect = false;
    return this.closeSession();
  }

  private closeSession() {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.active = false;
    this.pendingIdentity?.reject(new Error('串口已关闭'));
    this.cancelWriteDelay?.();
    this.parser.clear();
    this.closeTask = this.releaseResources().catch((error) => {
      this.closeTask = null;
      throw error;
    });
    return this.closeTask;
  }

  private async releaseResources() {
    await this.openTask?.catch(() => {});
    let closeError: unknown;
    try {
      await this.reader?.cancel();
    } catch {
      // 已断开的 ReadableStream 会再次拒绝 cancel；仍继续释放锁并关闭串口。
    }
    await this.readTask;
    await this.writeTail.catch(() => {});
    for (const stream of [this.reader, this.writer]) {
      try {
        stream?.releaseLock();
      } catch (error) {
        closeError ??= error;
      }
    }
    this.reader = null;
    this.writer = null;
    if (this.opened) {
      try {
        await this.port.close();
        this.opened = false;
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) throw closeError;
    if (this.notifyDisconnect) this.callbacks.onDisconnect();
  }

  private async readLoop() {
    try {
      while (this.active) {
        const { value, done } = await this.reader!.read();
        if (!this.active) break;
        if (done) {
          this.fail(new Error('设备已断开连接'));
          break;
        }
        if (value) this.parser.push(value);
      }
    } catch (error) {
      if (this.active) this.fail(error);
    }
  }

  private fail(error: unknown) {
    if (!this.active) return;
    this.pendingIdentity?.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
    this.callbacks.onError(this.errorMessage(error));
    this.notifyDisconnect = true;
    void this.closeSession().catch(() => {});
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private emit() {
    if (!this.active) return;
    this.callbacks.onData({
      ...this.state,
      cellVoltagesMv: [...this.state.cellVoltagesMv],
      records: this.state.records.map((record) => ({ ...record })),
    });
  }

  requestHistory() {
    if (!this.active) return Promise.reject(new Error('请先连接设备'));
    this.historyStarted = false;
    this.historyInvalid = false;
    this.state.historyStatus = 'receiving';
    this.state.historyExpected = null;
    this.emit();
    return this.queueWrite([[0x0a, new Uint8Array()]]);
  }

  identify(timeoutMs: number, signal?: AbortSignal): Promise<BatteryIdentity> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff)
      return Promise.reject(new RangeError('回复超时必须大于 0 ms'));
    if (signal?.aborted) return Promise.reject(identityAbortError());
    if (!this.isOpen) return Promise.reject(new Error('请先连接设备'));
    if (this.pendingIdentity)
      return Promise.reject(new Error('上一条设备识别请求尚未结束'));
    let pending: PendingIdentity;
    const response = new Promise<BatteryIdentity>((resolve, reject) => {
      const finish = (identity?: BatteryIdentity, error?: Error) => {
        if (this.pendingIdentity !== pending) return;
        this.pendingIdentity = null;
        globalThis.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(identity!);
      };
      pending = {
        sent: false,
        resolve: (identity) => finish(identity),
        reject: (error) => finish(undefined, error),
      };
      const onAbort = () => pending.reject(identityAbortError());
      const timer = globalThis.setTimeout(
        () => pending.reject(new BatteryIdentityTimeoutError(timeoutMs)),
        timeoutMs,
      );
      this.pendingIdentity = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    const write = this.queueWrite(
      [[0x08, new Uint8Array()]],
      () => this.pendingIdentity === pending,
      () => {
        pending.sent = true;
      },
    );
    void write.catch((error: unknown) => {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return Promise.all([response, write]).then(([identity]) => identity);
  }

  private queueWrite(
    commands: [number, Uint8Array][],
    canWrite: () => boolean = () => true,
    beforeWrite: () => void = () => {},
  ) {
    const task = this.writeTail
      .then(async () => {
        for (const [command, payload] of commands) {
          if (!this.active) throw new Error('串口已关闭');
          if (!canWrite()) return;
          const remaining =
            COMMAND_INTERVAL_MS - (Date.now() - this.lastWriteAt);
          if (remaining > 0) {
            await new Promise<void>((resolve) => {
              const timer = globalThis.setTimeout(() => {
                this.cancelWriteDelay = null;
                resolve();
              }, remaining);
              this.cancelWriteDelay = () => {
                globalThis.clearTimeout(timer);
                this.cancelWriteDelay = null;
                resolve();
              };
            });
          }
          if (!this.active) throw new Error('串口已关闭');
          if (!canWrite()) return;
          beforeWrite();
          await this.writer!.write(batteryFrame(command, payload));
          this.lastWriteAt = Date.now();
        }
      })
      .catch((error) => {
        if (this.active) this.fail(error);
        throw error;
      });
    this.writeTail = task;
    // 内部队列也观察拒绝；调用者仍可 await 原任务获知失败。
    void task.catch(() => {});
    return task;
  }

  private receive(command: number, payload: Uint8Array) {
    if (!this.active) return;
    const valid = this.applyFrame(command, payload);
    if (!valid) {
      if (command === 0x0a && this.historyStarted) this.historyInvalid = true;
      return;
    }
    this.state.lastReceivedAt = Date.now();
    if (command === 0x08 && this.pendingIdentity?.sent) {
      this.pendingIdentity.resolve({
        model: this.state.batteryModel!,
        code: this.state.batteryCode!,
      });
    }
    this.emit();
  }

  private applyFrame(command: number, data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (command === 0x02) {
      const type = data[0];
      if (type <= 3 && data.length === 3) {
        if (type === 0) this.state.temperatureC = view.getInt16(1, true) / 10;
        else if (type === 1)
          this.state.totalVoltageMv = view.getUint16(1, true);
        else {
          const index = type - 2;
          // 串数已知时忽略旧接口中不属于此电池组的占位值。
          if (this.state.cellCount !== null && index >= this.state.cellCount)
            return false;
          while (this.state.cellVoltagesMv.length <= index)
            this.state.cellVoltagesMv.push(null);
          this.state.cellVoltagesMv[index] = view.getUint16(1, true);
        }
        return true;
      }
      if (type === 13 && data.length === 2 && data[1] >= 1 && data[1] <= 16) {
        this.state.cellCount = data[1];
        this.state.cellVoltagesMv = Array.from(
          { length: data[1] },
          (_, index) => this.state.cellVoltagesMv[index] ?? null,
        );
        return true;
      }
      if ((type === 15 || type === 16) && data.length > 1) {
        const text = ascii(data.subarray(1));
        if (text === null) return false;
        if (type === 15) this.state.manufacturer = text;
        else this.state.productionDate = text;
        return true;
      }
      if (
        type === 0x12 &&
        data[1] >= 1 &&
        data[1] <= 16 &&
        data.length === 2 + data[1] * 2
      ) {
        this.state.cellCount = data[1];
        this.state.cellVoltagesMv = Array.from(
          { length: data[1] },
          (_, index) => view.getUint16(2 + index * 2, true),
        );
        return true;
      }
      return false;
    }
    if (command === 0x08) {
      const modelLength = data[0];
      const codeOffset = modelLength + 1;
      const codeLength = data[codeOffset];
      if (
        !modelLength ||
        !codeLength ||
        codeOffset + codeLength + 1 !== data.length
      )
        return false;
      const model = ascii(data.subarray(1, codeOffset));
      const code = ascii(data.subarray(codeOffset + 1));
      if (model === null || code === null) return false;
      this.state.batteryModel = model;
      this.state.batteryCode = code;
      return true;
    }
    if (command === 0x0a) return this.applyHistory(data, view);
    return false;
  }

  private applyHistory(data: Uint8Array, view: DataView) {
    if (data[0] === 0 && data.length === 3) {
      this.historyStarted = true;
      this.historyInvalid = false;
      this.historyRecords.clear();
      this.state.records = [];
      this.state.historyExpected = view.getUint16(1, true);
      this.state.historyStatus = 'receiving';
      return true;
    }
    if (
      data[0] === 1 &&
      data.length === 16 &&
      data[5] <= 1 &&
      data[6] <= 16 &&
      data[7] <= 2
    ) {
      if (data[5] === 0 && (data[6] === 0 || view.getInt32(8, true) < 0))
        return false;
      const record: SafetyRecord = {
        id: view.getUint32(1, true),
        type: data[5] === 0 ? 'overvoltage' : 'overtemperature',
        cell: data[6],
        state: (['idle', 'discharging', 'charging'] as const)[data[7]],
        value: view.getInt32(8, true),
        timeUnixSeconds: deviceTimeToUnix(view.getUint32(12, true)),
      };
      this.historyRecords.set(record.id, record);
      this.state.records = [...this.historyRecords.values()];
      if (!this.historyStarted) {
        this.state.historyStatus = 'incomplete';
        this.state.historyExpected = null;
      }
      return true;
    }
    if (data[0] === 2 && data.length === 3) {
      const total = view.getUint16(1, true);
      this.state.historyStatus =
        this.historyStarted &&
        !this.historyInvalid &&
        this.state.historyExpected === total &&
        this.historyRecords.size === total
          ? 'complete'
          : 'incomplete';
      this.historyStarted = false;
      return true;
    }
    return false;
  }
}
