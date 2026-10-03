import type { SerialPortLike } from './iap-protocol';

export const NTC_MIN_TEMPERATURE = -25;
export const NTC_MAX_TEMPERATURE = 125;

export interface NtcReply {
  temperature: number;
  resistanceOhms: number;
  code: number;
  status: number;
  crc: 'PASS';
  receivedAt: number;
}

export type NtcLogDirection = 'TX' | 'RX' | 'INFO' | 'ERROR';
type LogCallback = (direction: NtcLogDirection, message: string) => void;
type Reader = NonNullable<SerialPortLike['readable']> extends {
  getReader(): infer T;
} ? T : never;
type Writer = ReturnType<NonNullable<SerialPortLike['writable']>['getWriter']> & {
  abort?(reason?: unknown): Promise<void>;
};

export class NtcTimeoutError extends Error {
  constructor(temperature: number, timeoutMs: number) {
    super(`等待 ${temperature}℃ 回复超时（${timeoutMs} ms）`);
    this.name = 'NtcTimeoutError';
  }
}

function abortError() {
  return new DOMException('温度请求已停止', 'AbortError');
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function checkTemperature(temperature: number) {
  if (
    !Number.isInteger(temperature) ||
    temperature < NTC_MIN_TEMPERATURE ||
    temperature > NTC_MAX_TEMPERATURE
  ) {
    throw new RangeError('温度必须为 -25～125℃ 的整数');
  }
}

function crc8WithInitial(data: Uint8Array, initial: number) {
  let crc = initial;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function crc8(data: Uint8Array) {
  return crc8WithInitial(data, 0);
}

export function encodeSetTemperature(temperature: number) {
  checkTemperature(temperature);
  const frame = new Uint8Array(5);
  frame.set([0xaa, 0x01]);
  new DataView(frame.buffer).setInt16(2, temperature, true);
  frame[4] = crc8(frame.subarray(0, 4));
  return frame;
}

export function statusText(status: number) {
  return [
    'OK',
    '温度超范围',
    'CRC 错误',
    'AD5270 设置失败',
    '参数错误',
  ][status] ?? `未知状态 0x${status.toString(16).toUpperCase().padStart(2, '0')}`;
}

function hex(data: Uint8Array) {
  return Array.from(data, (value) => value.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** Each push accepts arbitrary serial chunks; only complete, valid replies are returned. */
export class NtcFrameParser {
  private bytes: number[] = [];
  private onError: (message: string) => void;

  constructor(onError: (message: string) => void = () => {}) {
    this.onError = onError;
  }

  reset() {
    this.bytes.length = 0;
  }

  push(chunk: Uint8Array): NtcReply[] {
    for (const byte of chunk) this.bytes.push(byte);
    const replies: NtcReply[] = [];
    while (this.bytes.length) {
      const header = this.bytes.indexOf(0xaa);
      if (header < 0) {
        this.bytes.length = 0;
        break;
      }
      if (header > 0) this.bytes.splice(0, header);
      if (this.bytes.length < 2) break;
      // Existing battery/IAP frames share this UART. Preserve their outer frame
      // boundary so an AA 81 sequence in binary payload cannot become an ACK.
      if (this.bytes[1] === 0xbb || this.bytes[1] === 0x55) {
        if (this.bytes.length < 5) break;
        const length = this.bytes[3] | (this.bytes[4] << 8);
        const maxPayload = this.bytes[1] === 0xbb ? 512 : 128;
        if (length > maxPayload) {
          this.onError('RX 非 NTC 帧长度异常，重新同步');
          this.bytes.shift();
          continue;
        }
        if (this.bytes.length < length + 6) break;
        const outerFrame = Uint8Array.from(this.bytes.splice(0, length + 6));
        if (crc8WithInitial(outerFrame.subarray(2, -1), 0xff) !== outerFrame[outerFrame.length - 1]) {
          this.onError('RX 非 NTC 帧 CRC 错误，按外层帧边界丢弃');
        }
        continue;
      }
      if (this.bytes[1] !== 0x81) {
        this.bytes.shift();
        continue;
      }
      if (this.bytes.length < 12) break;
      const frame = Uint8Array.from(this.bytes.slice(0, 12));
      if (crc8(frame.subarray(0, 11)) !== frame[11]) {
        this.onError(`RX CRC 校验失败，丢弃并重新同步：${hex(frame)}`);
        this.bytes.shift();
        continue;
      }
      this.bytes.splice(0, 12);
      const view = new DataView(frame.buffer);
      const reply: NtcReply = {
        temperature: view.getInt16(2, true),
        resistanceOhms: view.getUint32(4, true),
        code: view.getUint16(8, true),
        status: frame[10],
        crc: 'PASS',
        receivedAt: Date.now(),
      };
      // Error replies may use R = 0 when calculation was not executed.
      // OK replies describe the rounded manufacturer target, not measured resistance.
      if (
        reply.status > 4 ||
        reply.code > 1023 ||
        reply.resistanceOhms > 100000 ||
        (reply.status === 0 && (
          reply.temperature < NTC_MIN_TEMPERATURE ||
          reply.temperature > NTC_MAX_TEMPERATURE ||
          reply.resistanceOhms < 534 ||
          reply.resistanceOhms > 89710
        ))
      ) {
        this.onError(`RX 参数异常，丢弃：${hex(frame)}`);
        continue;
      }
      replies.push(reply);
    }
    return replies;
  }
}

interface PendingReply {
  temperature: number;
  resolve: (reply: NtcReply) => void;
  reject: (error: Error) => void;
}

export class NtcSerialSession {
  private port: SerialPortLike;
  private log: LogCallback;
  private onDisconnect?: (error: Error) => void;
  private parser: NtcFrameParser;
  private reader: Reader | null = null;
  private writer: Writer | null = null;
  private openTask: Promise<void> | null = null;
  private readTask: Promise<void> | null = null;
  private writeTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private pending: PendingReply | null = null;
  private opened = false;
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed';

  constructor(port: SerialPortLike, onLog: LogCallback, onDisconnect?: (error: Error) => void) {
    this.port = port;
    this.log = onLog;
    this.onDisconnect = onDisconnect;
    this.parser = new NtcFrameParser((message) => this.log('ERROR', message));
  }

  async open() {
    if (this.state !== 'closed') throw new Error('串口已经打开或正在切换状态');
    this.state = 'opening';
    const task = this.openPort();
    this.openTask = task;
    try {
      await task;
      if (!this.opened || this.closeTask) throw new Error('串口连接已取消');
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      if (this.openTask === task) this.openTask = null;
    }
  }

  private async openPort() {
    await this.port.open({
      baudRate: 1500000,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 4096,
    });
    this.opened = true;
    if (this.state === 'closing') return;
    if (!this.port.readable || !this.port.writable) throw new Error('串口读写通道不可用');
    this.reader = this.port.readable.getReader();
    this.parser.reset();
    this.state = 'open';
    this.readTask = this.readLoop(this.reader);
    this.log('INFO', '串口已连接：1500000 / 8N1');
  }

  private async readLoop(reader: Reader) {
    let failure: Error | null = null;
    try {
      while (this.state === 'open') {
        const { value, done } = await reader.read();
        if (done) {
          if (this.state === 'open') failure = new Error('串口已断开');
          break;
        }
        if (!value?.length) continue;
        this.log('RX', hex(value));
        for (const reply of this.parser.push(value)) {
          if (this.pending?.temperature === reply.temperature) {
            this.pending.resolve(reply);
          } else {
            this.log('INFO', `忽略无匹配请求的回复：${reply.temperature}℃ / ${statusText(reply.status)}`);
          }
        }
      }
    } catch (error) {
      if (this.state === 'open') failure = asError(error);
    } finally {
      reader.releaseLock();
      if (this.reader === reader) this.reader = null;
      if (failure) {
        this.pending?.reject(failure);
        this.log('ERROR', failure.message);
        // Start cleanup without awaiting our own read task.
        void this.close().catch((error: unknown) => this.log('ERROR', asError(error).message));
        this.onDisconnect?.(failure);
      }
    }
  }

  /**
   * A single in-flight command is allowed. CRC-invalid replies never settle it.
   * This protocol has no sequence ID: a delayed ACK for the same temperature
   * cannot be distinguished from a retry ACK. Firmware must echo requested TEMP
   * on error replies too; do not interpret an ACK as a physical resistance reading.
   */
  async setTemperature(temperature: number, timeoutMs: number, signal?: AbortSignal): Promise<NtcReply> {
    const frame = encodeSetTemperature(temperature);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
      throw new RangeError('回复超时必须大于 0 ms');
    }
    if (signal?.aborted) throw abortError();
    if (this.state !== 'open' || !this.port.writable) throw new Error('串口未连接');
    if (this.pending || this.writeTask) throw new Error('上一条温度命令尚未结束');
    const response = new Promise<NtcReply>((resolve, reject) => {
      const finish = (reply?: NtcReply, error?: Error) => {
        if (this.pending !== pending) return;
        this.pending = null;
        globalThis.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(reply!);
      };
      const pending: PendingReply = {
        temperature,
        resolve: (reply) => finish(reply),
        reject: (error) => finish(undefined, error),
      };
      const onAbort = () => pending.reject(abortError());
      const timer = globalThis.setTimeout(() => {
        this.log('ERROR', `TIMEOUT：${temperature}℃ / ${timeoutMs} ms`);
        pending.reject(new NtcTimeoutError(temperature, timeoutMs));
      }, timeoutMs);
      this.pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const writeTask = (async () => {
      const writer = this.port.writable!.getWriter() as Writer;
      this.writer = writer;
      try {
        this.log('TX', hex(frame));
        await writer.write(frame);
      } finally {
        writer.releaseLock();
        if (this.writer === writer) this.writer = null;
      }
    })();
    this.writeTask = writeTask;
    void writeTask.then(() => {
      if (this.writeTask === writeTask) this.writeTask = null;
    }, (error: unknown) => {
      if (this.writeTask === writeTask) this.writeTask = null;
      this.pending?.reject(asError(error));
    });
    const [reply] = await Promise.all([response, writeTask]);
    return reply;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    this.pending?.reject(new Error('串口已断开'));
    const task = (async () => {
      try {
        await this.openTask?.catch(() => {});
        await Promise.allSettled([
          this.reader?.cancel(),
          this.writer?.abort?.(new Error('串口关闭')),
        ]);
        await Promise.allSettled([this.readTask, this.writeTask]);
        if (this.opened) {
          try {
            await this.port.close();
            this.opened = false;
          } catch (error) {
            this.log('ERROR', `关闭串口：${asError(error).message}`);
            throw error;
          }
        }
      } finally {
        this.reader = null;
        this.writer = null;
        this.readTask = null;
        this.writeTask = null;
        this.parser.reset();
        // A failed port.close still owns the device. Keep close retryable and
        // reject open/write until the caller has successfully released it.
        this.state = this.opened ? 'closing' : 'closed';
        this.closeTask = null;
      }
    })();
    this.closeTask = task;
    return task;
  }
}
