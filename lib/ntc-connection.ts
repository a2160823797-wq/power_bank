import type { SerialPortLike } from './iap-protocol';
import { NtcSerialSession } from './ntc-protocol';

type DisconnectCallback = (session: NtcSerialSession, error: Error) => void;
interface NtcConnection {
  port: SerialPortLike;
  session: NtcSerialSession;
}

export class NtcDeviceSelectionError extends Error {
  constructor() {
    super('发现多台数字电位器设备，请手动选择');
    this.name = 'NtcDeviceSelectionError';
  }
}

export class NtcPortReleaseError extends Error {
  readonly session: NtcSerialSession;

  constructor(session: NtcSerialSession, error: unknown) {
    super(`设备端口释放失败，请重试断开：${error instanceof Error ? error.message : String(error)}`);
    this.name = 'NtcPortReleaseError';
    this.session = session;
  }
}

function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('设备连接已取消', 'AbortError');
}

async function release(session: NtcSerialSession) {
  try {
    await session.close();
  } catch (error) {
    throw new NtcPortReleaseError(session, error);
  }
}

async function probe(
  port: SerialPortLike,
  signal?: AbortSignal,
  onDisconnect?: DisconnectCallback,
  suppressFailure = true,
): Promise<NtcConnection | null> {
  checkCancellation(signal);
  const session: NtcSerialSession = new NtcSerialSession(port, () => {}, (error) => {
    onDisconnect?.(session, error);
  });
  try {
    await session.open();
    checkCancellation(signal);
    await session.identify(500, signal);
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

/** Probe only authorized ports supplied by the caller, without changing temperature. */
export async function discoverNtcDevice(
  ports: SerialPortLike[],
  preferredPort: SerialPortLike | null,
  signal?: AbortSignal,
  onDisconnect?: DisconnectCallback,
): Promise<NtcConnection | null> {
  checkCancellation(signal);
  if (preferredPort && ports.includes(preferredPort)) {
    const connection = await probe(preferredPort, signal, onDisconnect);
    if (connection) return connection;
  }

  let matchedPort: SerialPortLike | null = null;
  for (const port of ports) {
    if (port === preferredPort) continue;
    const connection = await probe(port, signal, onDisconnect);
    if (!connection) continue;
    await release(connection.session);
    checkCancellation(signal);
    if (matchedPort) throw new NtcDeviceSelectionError();
    matchedPort = port;
  }
  checkCancellation(signal);
  return matchedPort ? probe(matchedPort, signal, onDisconnect) : null;
}

/** A picker selection is also identified before it is accepted as the device. */
export async function connectSelectedNtcDevice(
  port: SerialPortLike,
  signal?: AbortSignal,
  onDisconnect?: DisconnectCallback,
): Promise<NtcConnection> {
  return (await probe(port, signal, onDisconnect, false))!;
}
