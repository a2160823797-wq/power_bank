import { BootState, IapSerialSession, type SerialPortLike } from './iap-protocol';
import { DEFAULT_CONFIG } from './iap-config';
import type { DeviceSerialSession } from './device-session';
import { DeviceSelectionError } from './device-connection';

export class UpgradePortReleaseError extends Error {
  constructor(readonly session: IapSerialSession, error: unknown) {
    super(`升级端口释放失败：${error instanceof Error ? error.message : String(error)}`);
    this.name = 'UpgradePortReleaseError';
  }
}

export class UpgradeResetDisconnectError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'UpgradeResetDisconnectError';
  }
}

async function release(session: IapSerialSession) {
  try {
    await session.close();
  } catch (error) {
    throw new UpgradePortReleaseError(session, error);
  }
}

export async function upgradeFirmware(
  port: SerialPortLike,
  ...[fileName, firmware, onProgress, onStage]: Parameters<IapSerialSession['upgrade']>
) {
  const session = new IapSerialSession(port);
  let before: BootState | undefined;
  let cur_stage: 'handshake' | 'writing' | 'verifying' = 'handshake';
  let sent = 0;
  try {
    await session.open();
    before = (await session.readBootOption()).state;
    await session.upgrade(
      fileName,
      firmware,
      (percent, count) => {
        sent = count;
        onProgress(percent, count);
      },
      (stage) => {
        cur_stage = stage;
        onStage(stage);
      },
    );
  } catch (error) {
    // 只恢复 APP 复位进入 Bootloader 时的断链，写入开始后不自动重发
    if (
      before === BootState.App &&
      cur_stage === 'handshake' &&
      sent === 0 &&
      session.isDisconnected
    ) {
      throw new UpgradeResetDisconnectError(error);
    }
    throw error;
  } finally {
    await release(session);
  }
}

export async function reconnectUpgradePort(port: SerialPortLike) {
  for (let attempt = 1; ; attempt++) {
    const session = new IapSerialSession(port);
    let option;
    try {
      await session.open();
      option = await session.readBootOptionWithRetry();
    } catch (error) {
      if (attempt >= DEFAULT_CONFIG.maxAttempts) throw error;
    } finally {
      await release(session);
    }
    if (option) {
      if (
        option.state !== BootState.AppRequestUpgrade &&
        option.state !== BootState.AppUpdate
      ) {
        throw new Error('连接已恢复，但设备未进入升级模式；未重发固件');
      }
      return;
    }
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
