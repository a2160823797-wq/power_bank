import type { SerialPortLike } from './iap-protocol';
import { DeviceSerialSession, type DeviceCallbacks, type DeviceKind } from './device-session';

interface DeviceConnection {
  port: SerialPortLike;
  session: DeviceSerialSession;
}

export class DeviceSelectionError extends Error {
  constructor() {
    super('发现多台设备，请手动选择');
    this.name = 'DeviceSelectionError';
  }
}

export class DevicePortReleaseError extends Error {
  constructor(readonly session: DeviceSerialSession, error: unknown) {
    super(`设备端口释放失败，请重试断开：${error instanceof Error ? error.message : String(error)}`);
    this.name = 'DevicePortReleaseError';
  }
}

function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('设备连接已取消', 'AbortError');
}

async function release(session: DeviceSerialSession) {
  try {
    await session.close();
  } catch (error) {
    throw new DevicePortReleaseError(session, error);
  }
}

async function probe(
  port: SerialPortLike,
  kind: DeviceKind,
  signal?: AbortSignal,
  callbacks?: DeviceCallbacks,
  suppressFailure = true,
): Promise<DeviceConnection | null> {
  checkCancellation(signal);
  const session = new DeviceSerialSession(port, callbacks);
  try {
    await session.open();
    checkCancellation(signal);
    await session.identify(kind, 500, signal);
    checkCancellation(signal);
    if (!session.isOpen) throw new Error('设备在识别过程中已断开');
    return { port, session };
  } catch (error) {
    await release(session);
    checkCancellation(signal);
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (!suppressFailure) throw error;
    return null;
  }
}

async function accept(connection: DeviceConnection | null, signal?: AbortSignal, suppressFailure = true) {
  if (signal?.aborted && connection) await release(connection.session);
  checkCancellation(signal);
  if (connection && !connection.session.isOpen) {
    await release(connection.session);
    checkCancellation(signal);
    if (!suppressFailure) throw new Error('设备在识别过程中已断开');
    return null;
  }
  return connection;
}

/** 扫描已获授权的端口，按当前功能的只读协议确认设备身份。 */
export async function discoverDevice(
  ports: SerialPortLike[],
  preferredPort: SerialPortLike | null,
  kind: DeviceKind,
  signal?: AbortSignal,
  callbacks?: DeviceCallbacks,
): Promise<DeviceConnection | null> {
  checkCancellation(signal);
  if (preferredPort && ports.includes(preferredPort)) {
    const connection = await probe(preferredPort, kind, signal, callbacks);
    if (connection) return accept(connection, signal);
    checkCancellation(signal);
  }

  let matchedPort: SerialPortLike | null = null;
  for (const port of ports) {
    if (port === preferredPort) continue;
    const connection = await probe(port, kind, signal, callbacks);
    if (!connection) continue;
    await release(connection.session);
    checkCancellation(signal);
    if (matchedPort) throw new DeviceSelectionError();
    matchedPort = port;
  }
  checkCancellation(signal);
  if (!matchedPort) return null;
  return accept(await probe(matchedPort, kind, signal, callbacks), signal);
}

/** 首次授权或手动选择之后也核验身份，避免连接到其他串口设备。 */
export async function connectSelectedDevice(
  port: SerialPortLike,
  kind: DeviceKind,
  signal?: AbortSignal,
  callbacks?: DeviceCallbacks,
): Promise<DeviceConnection> {
  return (await accept(await probe(port, kind, signal, callbacks, false), signal, false))!;
}
