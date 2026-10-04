import { IapSerialSession, type SerialPortLike } from './iap-protocol';
import type { DeviceSerialSession } from './device-session';
import { DeviceSelectionError } from './device-connection';

export class UpgradePortReleaseError extends Error {
  constructor(readonly session: IapSerialSession, error: unknown) {
    super(`升级端口释放失败，请再次点击“一键升级”重试：${error instanceof Error ? error.message : String(error)}`);
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

/** 只读确认 IAP 在线；共用监测串口时通过虚拟通道查询。 */
export async function verifyUpgradePort(
  port: SerialPortLike,
  connectedSession: DeviceSerialSession | null = null,
) {
  if (connectedSession?.port === port) {
    await connectedSession.identifyUpgrade();
    return;
  }
  const session = new IapSerialSession(port, () => {});
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
) {
  try {
    await verifyUpgradePort(port, connectedSession);
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
): Promise<SerialPortLike | null> {
  if (preferredPort && ports.includes(preferredPort)) {
    if (await matches(preferredPort, connectedSession)) return preferredPort;
  }
  let matchedPort: SerialPortLike | null = null;
  for (const port of ports) {
    if (port === preferredPort) continue;
    if (!(await matches(port, connectedSession))) continue;
    if (matchedPort) throw new DeviceSelectionError();
    matchedPort = port;
  }
  return matchedPort;
}
