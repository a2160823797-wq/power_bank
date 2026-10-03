import type { SerialPortLike } from './iap-protocol';

type SerialReader = ReturnType<
  NonNullable<SerialPortLike['readable']>['getReader']
>;
type SerialWriter = ReturnType<
  NonNullable<SerialPortLike['writable']>['getWriter']
>;
type ReadResult = Awaited<ReturnType<SerialReader['read']>>;

const connectionClosed = () => new Error('设备连接已关闭');
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

class SerialChannel implements SerialPortLike {
  private opened = false;
  private receiving = false;
  private failure: Error | null = null;
  private chunks: Uint8Array[] = [];
  private pendingRead: {
    resolve: (result: ReadResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private readerLocked = false;
  private writerLocked = false;
  private writes = new Set<Promise<void>>();

  constructor(private transport: SharedSerialTransport) {}

  get readable() {
    return this.opened ? { getReader: () => this.getReader() } : null;
  }

  get writable() {
    return this.opened ? { getWriter: () => this.getWriter() } : null;
  }

  getInfo() {
    return this.transport.port.getInfo();
  }

  async open() {
    if (!this.transport.isOpen) throw connectionClosed();
    if (this.opened) throw new Error('通道已经打开');
    this.opened = true;
    this.receiving = true;
    this.failure = null;
    this.chunks.length = 0;
    this.transport.addChannel(this);
  }

  async close() {
    this.opened = false;
    this.finish();
    this.transport.removeChannel(this);
    await Promise.allSettled(this.writes);
  }

  push(chunk: Uint8Array) {
    if (!this.opened || !this.receiving || this.failure) return;
    const value = chunk.slice();
    if (this.pendingRead) {
      this.pendingRead.resolve({ value, done: false });
      this.pendingRead = null;
    } else {
      this.chunks.push(value);
    }
  }

  finish() {
    this.receiving = false;
    this.chunks.length = 0;
    this.pendingRead?.resolve({ done: true });
    this.pendingRead = null;
  }

  fail(error: Error) {
    if (!this.opened) return;
    this.failure = error;
    this.receiving = false;
    this.chunks.length = 0;
    this.pendingRead?.reject(error);
    this.pendingRead = null;
  }

  private getReader(): SerialReader {
    if (this.readerLocked) throw new Error('通道读取已被锁定');
    this.readerLocked = true;
    let released = false;
    return {
      read: () => {
        if (released) return Promise.reject(new Error('通道读取锁已释放'));
        if (this.failure) return Promise.reject(this.failure);
        if (!this.receiving) return Promise.resolve({ done: true });
        const value = this.chunks.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.pendingRead) return Promise.reject(new Error('通道正在读取'));
        return new Promise<ReadResult>((resolve, reject) => {
          this.pendingRead = { resolve, reject };
        });
      },
      cancel: async () => this.finish(),
      releaseLock: () => {
        if (this.pendingRead) throw new Error('通道读取尚未结束');
        released = true;
        this.readerLocked = false;
      },
    };
  }

  private getWriter(): SerialWriter & {
    abort(reason?: unknown): Promise<void>;
  } {
    if (this.writerLocked) throw new Error('通道写入已被锁定');
    this.writerLocked = true;
    let released = false;
    let failure: Error | null = null;
    return {
      write: (data) => {
        const canWrite = () => {
          if (failure) throw failure;
          if (this.failure) throw this.failure;
          if (!this.opened) throw connectionClosed();
        };
        try {
          if (released) throw new Error('通道写入锁已释放');
          canWrite();
        } catch (error) {
          return Promise.reject(error);
        }
        const task = this.transport.write(data.slice(), canWrite);
        this.writes.add(task);
        void task.then(
          () => this.writes.delete(task),
          () => this.writes.delete(task),
        );
        return task;
      },
      abort: async (reason) => {
        failure = reason === undefined ? connectionClosed() : asError(reason);
        await Promise.allSettled(this.writes);
      },
      releaseLock: () => {
        released = true;
        this.writerLocked = false;
      },
    };
  }
}

// 唯一持有物理串口，页面协议各自使用虚拟通道
export class SharedSerialTransport {
  private state: 'closed' | 'opening' | 'open' | 'closing' = 'closed';
  private opened = false;
  private reader: SerialReader | null = null;
  private writer: SerialWriter | null = null;
  private openTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private readTask: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private channels = new Set<SerialChannel>();

  constructor(
    readonly port: SerialPortLike,
    private onDisconnect?: (error: Error) => void,
  ) {}

  get isOpen() {
    return this.state === 'open';
  }

  createChannel(): SerialPortLike {
    return new SerialChannel(this);
  }

  addChannel(channel: SerialChannel) {
    this.channels.add(channel);
  }

  removeChannel(channel: SerialChannel) {
    this.channels.delete(channel);
  }

  open(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    if (this.openTask) return this.openTask;
    if (this.state === 'closing') return Promise.reject(connectionClosed());
    this.state = 'opening';
    this.openTask = this.openPort().finally(() => {
      this.openTask = null;
    });
    return this.openTask;
  }

  private async openPort() {
    try {
      await this.port.open({
        baudRate: 1500000,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        bufferSize: 65536,
      });
      this.opened = true;
      if (this.state !== 'opening') throw connectionClosed();
      if (!this.port.readable || !this.port.writable)
        throw new Error('设备串口读写流不可用');
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.state = 'open';
      this.readTask = this.readLoop(this.reader);
    } catch (error) {
      this.state = this.opened ? 'closing' : 'closed';
      throw error;
    }
  }

  write(data: Uint8Array, canWrite: () => void): Promise<void> {
    const task = this.writeTail.then(async () => {
      if (!this.isOpen) throw connectionClosed();
      canWrite();
      try {
        await this.writer!.write(data);
      } catch (error) {
        this.fail(asError(error));
        throw error;
      }
    });
    this.writeTail = task.catch(() => {});
    return task;
  }

  private async readLoop(reader: SerialReader) {
    try {
      while (this.isOpen) {
        const { value, done } = await reader.read();
        if (!this.isOpen) return;
        if (done) throw new Error('设备连接已断开');
        if (value) for (const channel of this.channels) channel.push(value);
      }
    } catch (error) {
      if (this.isOpen) this.fail(asError(error));
    }
  }

  private fail(error: Error) {
    if (!this.isOpen) return;
    this.state = 'closing';
    for (const channel of this.channels) channel.fail(error);
    void this.close().catch(() => {});
    this.onDisconnect?.(error);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    for (const channel of this.channels) channel.finish();
    this.closeTask = this.closePort().finally(() => {
      this.closeTask = null;
    });
    return this.closeTask;
  }

  private async closePort() {
    await this.openTask?.catch(() => {});
    await this.reader?.cancel().catch(() => {});
    await this.readTask;
    await this.writeTail;
    this.reader?.releaseLock();
    this.reader = null;
    this.writer?.releaseLock();
    this.writer = null;
    if (this.opened) {
      await this.port.close();
      this.opened = false;
    }
    this.state = 'closed';
  }
}
