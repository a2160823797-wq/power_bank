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

export function crc8(data: Uint8Array) {
  let crc = 0;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function encodeSetTemperature(temperature: number) {
  checkTemperature(temperature);
  const frame = new Uint8Array(5);
  frame.set([0xaa, 0x01]);
  new DataView(frame.buffer).setInt16(2, temperature, true);
  frame[4] = crc8(frame.subarray(0, 4));
  return frame;
}

/** Each push accepts arbitrary serial chunks; only complete, valid replies are returned. */
export class NtcFrameParser {
  private bytes: number[] = [];

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
        const maxPayload = this.bytes[1] === 0xbb ? 1024 : 128;
        if (length > maxPayload) {
          this.bytes.shift();
          continue;
        }
        if (this.bytes.length < length + 6) break;
        this.bytes.splice(0, length + 6);
        continue;
      }
      if (this.bytes[1] !== 0x81 && this.bytes[1] !== 0x82) {
        this.bytes.shift();
        continue;
      }
      if (this.bytes.length < 12) break;
      const frame = Uint8Array.from(this.bytes.slice(0, 12));
      if (crc8(frame.subarray(0, 11)) !== frame[11]) {
        this.bytes.shift();
        continue;
      }
      this.bytes.splice(0, 12);
      if (frame[1] === 0x82) continue; // 丢弃完整识别回复，避免帧内数据被误认成温度回复
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
        continue;
      }
      replies.push(reply);
    }
    return replies;
  }
}

interface PendingReply {
  matches: (reply: NtcReply) => boolean;
  resolve: (reply: NtcReply) => void;
  reject: (error: Error) => void;
}

export class NtcSerialSession {
  private port: SerialPortLike;
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

  constructor(port: SerialPortLike, onDisconnect?: (error: Error) => void) {
    this.port = port;
    this.onDisconnect = onDisconnect;
    this.parser = new NtcFrameParser();
  }

  get isOpen() {
    return this.state === 'open';
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
        for (const reply of this.parser.push(value)) {
          this.receiveReply(reply);
        }
      }
    } catch (error) {
      if (this.state === 'open') failure = asError(error);
    } finally {
      reader.releaseLock();
      if (this.reader === reader) this.reader = null;
      if (failure) {
        this.pending?.reject(failure);
        // Start cleanup without awaiting our own read task.
        void this.close().catch(() => {});
        this.onDisconnect?.(failure);
      }
    }
  }

  private receiveReply(reply: NtcReply) {
    if (this.pending?.matches(reply)) {
      this.pending.resolve(reply);
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
    return await this.request(
      frame,
      (reply) => reply.temperature === temperature,
      timeoutMs,
      () => new NtcTimeoutError(temperature, timeoutMs),
      signal,
    );
  }

  private async request(
    frame: Uint8Array,
    matches: (reply: NtcReply) => boolean,
    timeoutMs: number,
    timeoutError: () => Error,
    signal?: AbortSignal,
  ): Promise<NtcReply> {
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
        matches,
        resolve: (reply) => finish(reply),
        reject: (error) => finish(undefined, error),
      };
      const onAbort = () => pending.reject(abortError());
      const timer = globalThis.setTimeout(() => pending.reject(timeoutError()), timeoutMs);
      this.pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const writeTask = (async () => {
      const writer = this.port.writable!.getWriter() as Writer;
      this.writer = writer;
      try {
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

  close(reason: Error = new Error('串口已断开')): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    this.pending?.reject(reason);
    const task = (async () => {
      try {
        await this.openTask?.catch(() => {});
        await Promise.allSettled([
          this.reader?.cancel(),
          this.writer?.abort?.(new Error('串口关闭')),
        ]);
        await Promise.allSettled([this.readTask, this.writeTask]);
        if (this.opened) {
          await this.port.close();
          this.opened = false;
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
