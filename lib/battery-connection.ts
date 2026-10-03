import type { SerialPortLike } from './iap-protocol';
import { BatterySerialSession, type BatteryState } from './battery-protocol';

export interface BatteryConnectionCallbacks {
  onData?(session: BatterySerialSession, state: BatteryState): void;
  onDisconnect?(session: BatterySerialSession): void;
  onError?(session: BatterySerialSession, message: string): void;
}

interface BatteryConnection {
  port: SerialPortLike;
  session: BatterySerialSession;
}

export class BatteryDeviceSelectionError extends Error {
  constructor() {
    super('发现多台电池监测设备，请手动选择');
    this.name = 'BatteryDeviceSelectionError';
  }
}

export class BatteryPortReleaseError extends Error {
  readonly session: BatterySerialSession;

  constructor(session: BatterySerialSession, error: unknown) {
    super(
      `设备端口释放失败，请重试断开：${error instanceof Error ? error.message : String(error)}`,
    );
    this.name = 'BatteryPortReleaseError';
    this.session = session;
  }
}

function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('设备连接已取消', 'AbortError');
}

async function release(session: BatterySerialSession) {
  try {
    await session.close();
  } catch (error) {
    throw new BatteryPortReleaseError(session, error);
  }
}

async function probe(
  port: SerialPortLike,
  signal?: AbortSignal,
  callbacks?: BatteryConnectionCallbacks,
  suppressFailure = true,
): Promise<BatteryConnection | null> {
  checkCancellation(signal);
  const session: BatterySerialSession = new BatterySerialSession(port, {
    onData: (state) => callbacks?.onData?.(session, state),
    onDisconnect: () => callbacks?.onDisconnect?.(session),
    onError: (message) => callbacks?.onError?.(session, message),
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

async function accept(
  connection: BatteryConnection | null,
  signal?: AbortSignal,
  suppressFailure = true,
) {
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

/** 仅检查调用者提供的已授权端口，使用现有型号查询识别电池监测设备 */
export async function discoverBatteryDevice(
  ports: SerialPortLike[],
  preferredPort: SerialPortLike | null,
  signal?: AbortSignal,
  callbacks?: BatteryConnectionCallbacks,
): Promise<BatteryConnection | null> {
  checkCancellation(signal);
  if (preferredPort && ports.includes(preferredPort)) {
    const connection = await probe(preferredPort, signal, callbacks);
    if (connection) return accept(connection, signal);
    checkCancellation(signal);
  }

  let matchedPort: SerialPortLike | null = null;
  for (const port of ports) {
    if (port === preferredPort) continue;
    const connection = await probe(port, signal, callbacks);
    if (!connection) {
      checkCancellation(signal);
      continue;
    }
    await release(connection.session);
    checkCancellation(signal);
    if (matchedPort) throw new BatteryDeviceSelectionError();
    matchedPort = port;
  }
  checkCancellation(signal);
  if (!matchedPort) return null;
  const connection = await probe(matchedPort, signal, callbacks);
  return accept(connection, signal);
}

/** 浏览器手动选择的端口同样需要通过型号回复核验 */
export async function connectSelectedBatteryDevice(
  port: SerialPortLike,
  signal?: AbortSignal,
  callbacks?: BatteryConnectionCallbacks,
): Promise<BatteryConnection> {
  const connection = await probe(port, signal, callbacks, false);
  return (await accept(connection, signal, false))!;
}
