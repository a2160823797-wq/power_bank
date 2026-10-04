import {
  DEFAULT_CONFIG,
  IAP_BAUD_RATE,
  IAP_PACKET_SIZE,
  type IapConfig,
} from './iap-config';

const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQUEST = 0x43;

interface SerialReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

interface SerialWriter {
  write(data: Uint8Array): Promise<void>;
  releaseLock(): void;
}

export interface SerialPortLike {
  readable: { getReader(): SerialReader } | null;
  writable: { getWriter(): SerialWriter } | null;
  open(options: {
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: 'none';
    flowControl: 'none';
    bufferSize: number;
  }): Promise<void>;
  close(): Promise<void>;
  getInfo(): {
    usbVendorId?: number;
    usbProductId?: number;
    bluetoothServiceClassId?: string;
  };
}

export interface SerialApi {
  requestPort(): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
}

type ProgressCallback = (percent: number, sent: number) => void;
type StageCallback = (stage: 'handshake' | 'writing' | 'verifying') => void;
type LogCallback = (
  message: string,
  tone?: 'info' | 'success' | 'error',
) => void;

class RetryableError extends Error {}

class ByteInbox {
  private bytes: number[] = [];
  private listeners = new Set<() => void>();
  private failure: Error | null = null;

  push(chunk: Uint8Array) {
    this.bytes.push(...chunk);
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  fail(error: Error) {
    this.failure = error;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  clear() {
    this.bytes.length = 0;
  }

  async take(timeoutMs: number): Promise<number> {
    if (this.failure) throw this.failure;
    const deadline = Date.now() + timeoutMs;
    while (this.bytes.length === 0) {
      if (this.failure) throw this.failure;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RetryableError('设备响应超时');
      await new Promise<void>((resolve) => {
        const wake = () => {
          globalThis.clearTimeout(timer);
          resolve();
        };
        const timer = globalThis.setTimeout(() => {
          this.listeners.delete(wake);
          resolve();
        }, remaining);
        this.listeners.add(wake);
      });
    }
    if (this.failure) throw this.failure;
    return this.bytes.shift()!;
  }
}

export function crc8(data: Uint8Array, initial = 0xff) {
  let crc = initial;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export function crc16(data: Uint8Array, initial = 0) {
  let crc = initial;
  for (const value of data) {
    crc ^= value << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc32(data: Uint8Array, initial = 0) {
  let crc = (initial ^ 0xffffffff) >>> 0;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? ((crc >>> 1) ^ 0xedb88320) >>> 0 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validateFirmware(data: Uint8Array) {
  if (data.length === 0) return '固件文件不能为空';
  if (data.length > 0xffffffff) return '固件大小超出 32 位长度范围';
  return null;
}

function commandFrame(command: number, payload: Uint8Array = new Uint8Array()) {
  const frame = new Uint8Array(payload.length + 6);
  frame.set([0xaa, 0x55, command, payload.length & 0xff, payload.length >> 8]);
  frame.set(payload, 5);
  frame[frame.length - 1] = crc8(frame.subarray(2, frame.length - 1));
  return frame;
}

function ymodemPacket(header: number, block: number, payload: Uint8Array) {
  const packet = new Uint8Array(payload.length + 5);
  packet[0] = header;
  packet[1] = block & 0xff;
  packet[2] = ~block & 0xff;
  packet.set(payload, 3);
  const verify = crc16(payload);
  packet[packet.length - 2] = verify >> 8;
  packet[packet.length - 1] = verify & 0xff;
  return packet;
}

function u32le(value: number) {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

export class IapSerialSession {
  private inbox = new ByteInbox();
  private reader: SerialReader | null = null;
  private readTask: Promise<void> | null = null;
  private aborted = false;
  private opened = false;

  constructor(
    private port: SerialPortLike,
    private log: LogCallback,
    private config: IapConfig = DEFAULT_CONFIG,
  ) {}

  async open() {
    await this.port.open({
      baudRate: IAP_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 65536,
    });
    this.opened = true;
    if (!this.port.readable) throw new Error('串口不可读');
    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop();
  }

  private async readLoop() {
    try {
      while (this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (!this.aborted) this.inbox.fail(new Error('串口已断开'));
          break;
        }
        if (value?.length) this.inbox.push(value);
      }
    } catch (error) {
      if (!this.aborted)
        this.inbox.fail(
          error instanceof Error ? error : new Error('串口已断开'),
        );
    }
  }

  private ensureActive() {
    if (this.aborted) throw new Error('升级已取消');
  }

  private async write(data: Uint8Array) {
    this.ensureActive();
    if (!this.port.writable) throw new Error('串口不可写');
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  private async readCommand(
    expectedCommand: number,
    timeoutMs = this.config.responseTimeoutMs,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.inbox.take(deadline - Date.now())) !== 0xaa) continue;
      if ((await this.inbox.take(deadline - Date.now())) !== 0x55) continue;
      const command = await this.inbox.take(deadline - Date.now());
      const low = await this.inbox.take(deadline - Date.now());
      const high = await this.inbox.take(deadline - Date.now());
      const length = low | (high << 8);
      if (length > 128) continue;
      const payload = new Uint8Array(length);
      for (let i = 0; i < length; i += 1)
        payload[i] = await this.inbox.take(deadline - Date.now());
      const receivedCrc = await this.inbox.take(deadline - Date.now());
      const checked = new Uint8Array([command, low, high, ...payload]);
      if (command === expectedCommand && receivedCrc === crc8(checked))
        return payload;
    }
    throw new Error('未收到有效的 IAP 命令响应');
  }

  private async command(
    command: number,
    payload: Uint8Array = new Uint8Array(),
    timeoutMs = this.config.responseTimeoutMs,
  ) {
    await this.write(commandFrame(command, payload));
    return this.readCommand(command, timeoutMs);
  }

  private async waitControl(
    expected: number | number[],
    timeoutMs = this.config.responseTimeoutMs,
  ) {
    const accepted = Array.isArray(expected) ? expected : [expected];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.ensureActive();
      const value = await this.inbox.take(deadline - Date.now());
      this.ensureActive();
      if (value === CAN) throw new Error('设备取消了升级');
      if (accepted.includes(value)) return value;
      if (value === NAK) throw new RetryableError('设备要求重传');
    }
    throw new RetryableError('设备响应超时');
  }

  private async sendPacketWithRetry(
    packet: Uint8Array,
    label: string,
    expected: number | number[] = ACK,
    thenCrcRequest = false,
  ) {
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      await this.write(packet);
      try {
        const response = await this.waitControl(expected);
        if (thenCrcRequest) await this.waitControl(CRC_REQUEST);
        return response;
      } catch (error) {
        if (!(error instanceof RetryableError)) throw error;
        if (attempt === this.config.maxAttempts)
          throw new Error(
            `${label} 连续 ${this.config.maxAttempts} 次尝试失败`,
          );
        this.log(
          `${label} 未确认，正在重试 ${attempt}/${this.config.maxAttempts}`,
        );
      }
    }
  }

  private async enterUpgradeMode(onStage: StageCallback) {
    onStage('handshake');
    this.log('正在确认设备在线');
    const ack = await this.command(0);
    if (ack[0] !== 1) throw new Error('设备在线确认失败');
    this.log('设备握手成功', 'success');
    this.log('正在切换到 Bootloader');
    const request = await this.command(2, new Uint8Array([2]));
    if (request[0] !== 1) {
      const update = await this.command(2, new Uint8Array([3]));
      if (update[0] !== 1) throw new Error('设备拒绝进入升级模式');
    }
    await this.waitControl(CRC_REQUEST, this.config.handshakeTimeoutMs);
  }

  async upgrade(
    fileName: string,
    firmware: Uint8Array,
    onProgress: ProgressCallback,
    onStage: StageCallback,
  ) {
    this.ensureActive();
    const validationError = validateFirmware(firmware);
    if (validationError) throw new Error(validationError);
    this.inbox.clear();
    await this.enterUpgradeMode(onStage);
    const transferInfo = new Uint8Array(8);
    transferInfo.set(u32le(firmware.length), 0);
    transferInfo.set(u32le(crc32(firmware)), 4);
    this.log('正在下发固件校验信息');
    const accepted = await this.command(3, transferInfo);
    if (accepted[0] !== 1) throw new Error('Bootloader 拒绝了固件大小或 CRC32');
    await this.waitControl(CRC_REQUEST);

    const headerData = new Uint8Array(128);
    const safeName =
      fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'firmware.bin';
    const fileInfo = new TextEncoder().encode(
      `${safeName}\0${firmware.length}`,
    );
    headerData.set(fileInfo.subarray(0, 127));
    await this.sendPacketWithRetry(
      ymodemPacket(SOH, 0, headerData),
      '文件头',
      ACK,
      true,
    );

    this.log('正在写入固件');
    onStage('writing');
    const totalBlocks = Math.ceil(firmware.length / IAP_PACKET_SIZE);
    for (let index = 0; index < totalBlocks; index += 1) {
      this.ensureActive();
      const payload = new Uint8Array(IAP_PACKET_SIZE);
      payload.fill(0x1a);
      const offset = index * IAP_PACKET_SIZE;
      payload.set(firmware.subarray(offset, offset + IAP_PACKET_SIZE));
      await this.sendPacketWithRetry(
        ymodemPacket(STX, index + 1, payload),
        `数据块 ${index + 1}`,
      );
      const sent = Math.min(offset + IAP_PACKET_SIZE, firmware.length);
      onProgress(Math.round((sent / firmware.length) * 100), sent);
    }

    this.log('正在等待设备确认传输结束');
    onStage('verifying');
    const eotResponse = await this.sendPacketWithRetry(
      new Uint8Array([EOT]),
      '传输结束',
      [ACK, NAK],
    );
    if (eotResponse === NAK)
      await this.sendPacketWithRetry(new Uint8Array([EOT]), '传输结束');
    await this.waitControl(CRC_REQUEST);
    await this.sendPacketWithRetry(
      ymodemPacket(SOH, 0, new Uint8Array(128)),
      '结束文件头',
    );
    this.ensureActive();
    onProgress(100, firmware.length);
    this.log('固件传输完成，请确认设备运行状态', 'success');
  }

  async cancel() {
    if (this.aborted) return;
    const cancellation = this.write(new Uint8Array([CAN, CAN]));
    this.aborted = true;
    this.inbox.fail(new Error('升级已取消'));
    try {
      await cancellation;
    } catch {}
  }

  async close() {
    this.aborted = true;
    this.inbox.fail(new Error('串口已关闭'));
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
      this.reader.releaseLock();
      this.reader = null;
    }
    await this.readTask?.catch(() => undefined);
    if (this.opened) {
      await this.port.close();
      this.opened = false;
    }
  }
}
