import { BootState, IapSerialSession, type SerialApi, type SerialPortLike } from './iap-protocol';
import { DEFAULT_CONFIG } from './iap-config';
import type { DeviceSerialSession } from './device-session';
import { DeviceSelectionError } from './device-connection';

export class UpgradePortReleaseError extends Error {
  constructor(readonly session: IapSerialSession, error: unknown) {
    super(`升级端口释放失败：${error instanceof Error ? error.message : String(error)}`);
    this.name = 'UpgradePortReleaseError';
  }
}

async function release(session: IapSerialSession) {
  try {
    await session.close();
  } catch (error) {
    throw new UpgradePortReleaseError(session, error);
  }
}

export async function withUpgradeSession<T>(
  port: SerialPortLike,
  operation: (session: IapSerialSession) => Promise<T>,
) {
  const session = new IapSerialSession(port);
  try {
    await session.open();
    return await operation(session);
  } finally {
    await release(session);
  }
}

export async function resumeUpgradeAfterReset<T>(
  serial: SerialApi,
  sourcePort: SerialPortLike,
  operation: (session: IapSerialSession) => Promise<T>,
) {
  const sourceInfo = sourcePort.getInfo();
  for (let attempt = 1; ; attempt++) {
    const ports = await serial.getPorts();
    const matches = ports.filter((port) => {
      const info = port.getInfo();
      return info.usbVendorId === sourceInfo.usbVendorId &&
        info.usbProductId === sourceInfo.usbProductId &&
        info.bluetoothServiceClassId === sourceInfo.bluetoothServiceClassId;
    });
    if (matches.length > 1) throw new DeviceSelectionError();
    const port = matches[0];
    if (port) {
      const session = new IapSerialSession(port);
      try {
        await session.open();
      } catch (error) {
        await release(session);
        if (!(error instanceof Error && error.name === 'NetworkError') || attempt >= DEFAULT_CONFIG.maxAttempts)
          throw error;
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 350));
        continue;
      }
      try {
        const option = await session.readBootOptionWithRetry();
        if (option.state !== BootState.AppRequestUpgrade && option.state !== BootState.AppUpdate)
          throw new Error('连接已恢复，但设备未进入升级模式；未发送固件');
        return { port, result: await operation(session) };
      } finally {
        await release(session);
      }
    }
    if (attempt >= DEFAULT_CONFIG.maxAttempts)
      throw new Error('复位后未找到原升级设备，请检查串口连接');
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 350));
  }
}

/** 只读确认 IAP 在线；共用监测串口时通过虚拟通道查询。 */
export async function verifyUpgradePort(
  port: SerialPortLike,
  connectedSession: DeviceSerialSession | null = null,
  ntcSession: DeviceSerialSession | null = null,
) {
  const activeSession = [connectedSession, ntcSession].find(
    (session) => session?.port === port,
  );
  if (activeSession) {
    await activeSession.identifyUpgrade();
    return;
  }
  const session = new IapSerialSession(port);
  try {
    await session.open();
    await session.identify(500);
  } finally {
    await release(session);
  }
}

async function matches(
  port: SerialPortLike,
  connectedSession: DeviceSerialSession | null,
  ntcSession: DeviceSerialSession | null,
) {
  try {
    await verifyUpgradePort(port, connectedSession, ntcSession);
    return true;
  } catch (error) {
    if (error instanceof UpgradePortReleaseError) throw error;
    return false;
  }
}

/** 扫描已授权端口，仅确认 IAP 协议，不切换升级模式或发送固件。 */
export async function discoverUpgradePort(
  ports: SerialPortLike[],
  preferredPort: SerialPortLike | null = null,
  connectedSession: DeviceSerialSession | null = null,
  ntcSession: DeviceSerialSession | null = null,
): Promise<SerialPortLike | null> {
  if (preferredPort && ports.includes(preferredPort)) {
    if (await matches(preferredPort, connectedSession, ntcSession)) return preferredPort;
  }
  let matchedPort: SerialPortLike | null = null;
  for (const port of ports) {
    if (port === preferredPort) continue;
    if (!(await matches(port, connectedSession, ntcSession))) continue;
    if (matchedPort) throw new DeviceSelectionError();
    matchedPort = port;
  }
  return matchedPort;
}
