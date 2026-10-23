import { SerialPort } from 'serialport';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { SerialPortLike } from '../lib/iap-protocol';
import { cycleUsbPortScript } from './usb-port-control';

const execFileAsync = promisify(execFile);

export async function releaseUsbSerialPort(
  port: Awaited<ReturnType<typeof SerialPort.list>>[number],
) {
  if (process.platform !== 'win32') throw new Error('释放外部串口连接目前仅支持 Windows');
  if (
    !port.pnpId?.startsWith('USB\\') ||
    /MKLink|VID_0D28|MI_04/i.test(`${port.friendlyName} ${port.pnpId}`)
  )
    throw new Error('只能重启明确的目标 USB 串口，不能重启下载器或系统串口');

  const utility = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  try {
    await execFileAsync(utility, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(cycleUsbPortScript, 'utf16le').toString('base64'),
    ], {
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
        POWERBANK_RELEASE_DEVICE_ID: port.pnpId,
      },
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`重启 ${port.path} USB 串口失败：${failure.stdout?.trim() || failure.stderr?.trim() || failure.message}`);
  }

  let lastError = '设备尚未重新枚举';
  for (let attempt = 0; attempt < 40; attempt++) {
    const available = (await SerialPort.list()).find((item) => item.pnpId === port.pnpId);
    if (available) {
      const probe = new LocalSerialPort(available.path);
      try {
        await probe.open({
          baudRate: 1500000,
          dataBits: 8,
          stopBits: 1,
          parity: 'none',
          flowControl: 'none',
          bufferSize: 65536,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await delay(250);
        continue;
      }
      await probe.close();
      return { port: available.path, released: true, method: 'usb_port_cycle', pnpId: port.pnpId };
    }
    await delay(250);
  }
  throw new Error(`已请求重启 ${port.path}，但未确认串口释放：${lastError}`);
}

// 把本地串口适配为上位机已有的 Web Serial 接口，共用全部协议实现
export class LocalSerialPort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private serial: SerialPort | null = null;
  private trace: {
    at: string;
    direction: 'rx' | 'tx';
    size: number;
    hex: string;
    truncated: boolean;
  }[] = [];

  private record(direction: 'rx' | 'tx', data: Uint8Array) {
    this.trace.push({
      at: new Date().toISOString(),
      direction,
      size: data.length,
      hex: Buffer.from(data.subarray(0, 128)).toString('hex'),
      truncated: data.length > 128,
    });
    if (this.trace.length > 128) this.trace.shift();
  }

  getTrace(limit: number) {
    return this.trace.slice(-limit);
  }

  constructor(readonly path: string) {}

  getInfo() {
    return {};
  }

  async open(options: Parameters<SerialPortLike['open']>[0]) {
    if (this.serial) throw new Error('串口已打开，请先断开');
    const serial = new SerialPort({
      path: this.path,
      baudRate: options.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: options.parity,
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false,
      highWaterMark: options.bufferSize,
    });
    let readController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    const endRead = (error?: Error) => {
      if (!readController) return;
      if (error) readController.error(error);
      else readController.close();
      readController = null;
    };
    serial.on('data', (data: Buffer) => {
      this.record('rx', data);
      readController?.enqueue(new Uint8Array(data));
      if (readController && readController.desiredSize! <= 0) serial.pause();
    });
    serial.on('error', (error: Error) => endRead(error));
    serial.on('close', () => endRead());
    this.readable = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          readController = controller;
        },
        pull() {
          serial.resume();
        },
        cancel() {
          readController = null;
          serial.pause();
        },
      },
      { highWaterMark: options.bufferSize, size: (chunk) => chunk.byteLength },
    );
    this.writable = new WritableStream<Uint8Array>({
      write: (data) => {
        this.record('tx', data);
        return new Promise<void>((resolve, reject) => {
          if (!serial.isOpen) return reject(new Error('串口已关闭'));
          serial.write(data, (error) => {
            if (error) return reject(error);
            serial.drain((drainError) =>
              drainError ? reject(drainError) : resolve(),
            );
          });
        });
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        serial.open((error) => (error ? reject(error) : resolve()));
      });
      this.serial = serial;
    } catch (error) {
      endRead();
      this.readable = null;
      this.writable = null;
      throw new Error(
        `无法打开 ${this.path}：${error instanceof Error ? error.message : String(error)}。请检查连接并关闭占用该串口的上位机`,
        { cause: error },
      );
    }
  }

  async close() {
    const serial = this.serial;
    if (serial?.isOpen) {
      await new Promise<void>((resolve, reject) => {
        serial.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.serial = null;
    this.readable = null;
    this.writable = null;
  }
}
