import { IapSerialSession, type SerialPortLike } from './iap-protocol';
import { BatterySerialSession, type BatteryState } from './battery-protocol';
import { NtcSerialSession } from './ntc-protocol';
import { SharedSerialTransport } from './shared-serial';

export type DeviceKind = 'battery' | 'ntc';

export interface DeviceCallbacks {
  onData?(session: DeviceSerialSession, state: BatteryState): void;
  onError?(session: DeviceSerialSession, message: string): void;
  onDisconnect?(session: DeviceSerialSession, error: Error): void;
}

/** 一个物理串口，两种协议；页面只使用本会话，不单独持有串口锁。 */
export class DeviceSerialSession {
  private readonly transport: SharedSerialTransport;
  private battery: BatterySerialSession | null = null;
  private ntc: NtcSerialSession | null = null;
  private upgradeChannel: SerialPortLike | null = null;
  private state:
    | 'new'
    | 'opening'
    | 'open'
    | 'upgrading'
    | 'failed'
    | 'closing'
    | 'closed' = 'new';
  private openTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;

  constructor(
    readonly port: SerialPortLike,
    private readonly callbacks: DeviceCallbacks = {},
  ) {
    this.transport = new SharedSerialTransport(port, (error) =>
      this.fail(error),
    );
  }

  get isOpen() {
    return (
      this.state === 'open' &&
      this.transport.isOpen &&
      this.battery?.isOpen === true &&
      this.ntc?.isOpen === true
    );
  }

  async open() {
    this.state = 'opening';
    const task = (async () => {
      await this.transport.open();
      if (this.state !== 'opening') throw new Error('设备连接已取消');
      await this.openProtocols();
      if (this.state !== 'opening' || !this.transport.isOpen)
        throw new Error('设备在连接过程中已断开');
      this.state = 'open';
    })();
    this.openTask = task;
    try {
      await task;
    } finally {
      if (this.openTask === task) this.openTask = null;
    }
  }

  private async openProtocols() {
    const battery = new BatterySerialSession(this.transport.createChannel(), {
      onData: (state) => {
        if (
          this.battery === battery &&
          this.state !== 'closing' &&
          this.state !== 'closed'
        )
          this.callbacks.onData?.(this, state);
      },
      onError: (message) => {
        if (
          this.battery === battery &&
          this.state !== 'closing' &&
          this.state !== 'closed'
        )
          this.callbacks.onError?.(this, message);
      },
      onDisconnect: () => {
        if (this.battery === battery) this.fail(new Error('设备已断开连接'));
      },
    });
    const ntc = new NtcSerialSession(
      this.transport.createChannel(),
      () => {},
      (error) => {
        if (this.ntc === ntc) this.fail(error);
      },
    );
    this.battery = battery;
    this.ntc = ntc;
    await battery.open();
    await ntc.open();
  }

  private async closeProtocols(ntcReason?: Error) {
    const battery = this.battery;
    const ntc = this.ntc;
    this.battery = null;
    this.ntc = null;
    const results = await Promise.allSettled([
      battery?.close(),
      ntc?.close(ntcReason),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private fail(error: Error) {
    if (
      this.state === 'failed' ||
      this.state === 'closing' ||
      this.state === 'closed'
    )
      return;
    this.state = 'failed';
    this.callbacks.onDisconnect?.(this, error);
  }

  identify(kind: DeviceKind, timeoutMs: number, signal?: AbortSignal) {
    if (!this.isOpen) return Promise.reject(new Error('请先连接设备'));
    return kind === 'battery'
      ? this.battery!.identify(timeoutMs, signal)
      : this.ntc!.identify(timeoutMs, signal);
  }

  async identifyUpgrade(timeoutMs = 500) {
    if (!this.isOpen) throw new Error('请先连接设备');
    const session = new IapSerialSession(this.transport.createChannel(), () => {});
    try {
      await session.open();
      await session.identify(timeoutMs);
    } finally {
      await session.close();
    }
  }

  requestHistory() {
    if (!this.isOpen) return Promise.reject(new Error('请先连接设备'));
    return this.battery!.requestHistory();
  }

  setTemperature(temperature: number, timeoutMs: number, signal?: AbortSignal) {
    if (!this.isOpen) return Promise.reject(new Error('请先连接设备'));
    return this.ntc!.setTemperature(temperature, timeoutMs, signal);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    const task = (async () => {
      await this.openTask?.catch(() => {});
      // 即使某个逻辑通道释放失败，也继续释放唯一的物理端口。
      await this.closeProtocols().catch(() => {});
      await this.upgradeChannel?.close().catch(() => {});
      this.upgradeChannel = null;
      await this.transport.close();
      this.state = 'closed';
    })();
    this.closeTask = task;
    void task.then(
      () => {
        if (this.closeTask === task) this.closeTask = null;
      },
      () => {
        if (this.closeTask === task) this.closeTask = null;
      },
    );
    return task;
  }

  /** 升级时关闭监测通道，IAP 独占收发；结束后恢复原协议通道。 */
  async withUpgrade<T>(
    operation: (channel: SerialPortLike) => Promise<T>,
  ): Promise<T> {
    if (!this.isOpen) throw new Error('请先连接设备');
    this.state = 'upgrading';
    let result: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      await this.closeProtocols(
        new DOMException('温度请求已停止', 'AbortError'),
      );
      if (this.state !== 'upgrading' || !this.transport.isOpen)
        throw new Error('设备已断开连接');
      const channel = this.transport.createChannel();
      this.upgradeChannel = channel;
      result = await operation(channel);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let restoreError: unknown;
    try {
      await this.upgradeChannel?.close();
      this.upgradeChannel = null;
      if (this.state === 'upgrading' && this.transport.isOpen) {
        await this.openProtocols();
        if (this.state !== 'upgrading' || !this.transport.isOpen)
          throw new Error('设备已断开连接');
        this.state = 'open';
        await this.identify('battery', 500);
        await this.requestHistory();
      } else {
        throw new Error('设备已断开连接');
      }
    } catch (error) {
      restoreError = error;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    if (operationFailed) throw operationError;
    if (restoreError) throw restoreError;
    return result as T;
  }
}
