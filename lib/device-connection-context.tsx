import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createBatteryState,
  BatteryIdentityTimeoutError,
  type BatteryState,
} from './battery-protocol';
import type { NtcReply } from './ntc-protocol';
import type { IapSerialSession, SerialApi, SerialPortLike } from './iap-protocol';
import { DeviceSerialSession } from './device-session';
import {
  connectSelectedDevice,
  discoverDevice,
  DeviceSelectionError,
  DevicePortReleaseError,
} from './device-connection';
import { getSavedSerialPort, rememberSerialPort } from './serial-device';
import {
  verifyUpgradePort,
  UpgradePortReleaseError,
} from './upgrade-connection';

type Connection =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'release-error';
interface DeviceConnection {
  serialSupported: boolean;
  connection: Connection;
  connectionBusy: boolean;
  connected: boolean;
  manualSelection: boolean;
  error: string;
  battery: BatteryState;
  connect: (automatic?: boolean, manual?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  setCellInfo: (field: 0 | 1, value: string) => Promise<void>;
  setTemperature: (
    temperature: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<NtcReply>;
  withUpgrade: <T>(
    operation: (port: SerialPortLike) => Promise<T>,
  ) => Promise<T>;
}

const LAST_PORT_KEY = 'powerbank.device-last-serial-port';
const DeviceContext = createContext<DeviceConnection | null>(null);
const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function markHistoryIncomplete(cur_state: BatteryState): BatteryState {
  return cur_state.historyStatus === 'receiving'
    ? { ...cur_state, historyStatus: 'incomplete' }
    : cur_state;
}

export function DeviceConnectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const serialSupported = 'serial' in navigator;
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [battery, setBattery] = useState(createBatteryState);
  const [error, setError] = useState('');
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [manualSelection, setManualSelection] = useState(false);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const sessionRef = useRef<DeviceSerialSession | null>(null);
  const connectTaskRef = useRef<Promise<void> | null>(null);
  const connectControllerRef = useRef<AbortController | null>(null);
  const closeTaskRef = useRef<Promise<void> | null>(null);
  const upgradeProbeRef = useRef<IapSerialSession | null>(null);

  const markBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    if (mountedRef.current) setConnectionBusy(value);
  }, []);

  const releaseSession = useCallback(async (session: DeviceSerialSession) => {
    await session.close();
    if (sessionRef.current === session) sessionRef.current = null;
  }, []);

  const disconnect = useCallback(async () => {
    connectControllerRef.current?.abort();
    await connectTaskRef.current;
    if (closeTaskRef.current) return closeTaskRef.current;
    const session = sessionRef.current;
    if (!session) return;
    markBusy(true);
    if (mountedRef.current) {
      setConnection('disconnecting');
      setError('');
    }
    const operation = (async () => {
      try {
        await releaseSession(session);
        if (mountedRef.current) {
          setConnection('disconnected');
          setBattery(markHistoryIncomplete);
        }
      } catch (reason) {
        if (mountedRef.current) {
          setConnection('release-error');
          setError(messageOf(reason));
        }
        throw reason;
      } finally {
        markBusy(false);
      }
    })();
    closeTaskRef.current = operation;
    try {
      await operation;
    } finally {
      if (closeTaskRef.current === operation) closeTaskRef.current = null;
    }
  }, [markBusy, releaseSession]);

  useEffect(() => {
    if (connection !== 'connected' || connectionBusy) return;
    const session = sessionRef.current;
    const report_timer = globalThis.setTimeout(() => {
      if (
        sessionRef.current === session &&
        session?.isOpen &&
        !busyRef.current
      ) {
        void disconnect().catch(() => undefined);
      }
    }, 1000);
    return () => globalThis.clearTimeout(report_timer);
  }, [connection, connectionBusy, battery.lastReceivedAt, disconnect]);

  async function connect(automatic = false, manual = false) {
    if (busyRef.current || sessionRef.current || !serialSupported) return;
    markBusy(true);
    setConnection('connecting');
    setError('');
    const controller = new AbortController();
    connectControllerRef.current = controller;
    const operation = (async () => {
      let session: DeviceSerialSession | null = null;
      try {
        const serial = (navigator as Navigator & { serial: SerialApi }).serial;
        const selectedPort = manual ? await serial.requestPort() : null;
        const ports = selectedPort ? [] : await serial.getPorts();
        if (controller.signal.aborted) return;
        const callbacks = {
          onData(candidate: DeviceSerialSession, state: BatteryState) {
            if (mountedRef.current && sessionRef.current === candidate)
              setBattery(state);
          },
          onError(candidate: DeviceSerialSession, message: string) {
            if (mountedRef.current && sessionRef.current === candidate)
              setError(message);
          },
          onDisconnect(candidate: DeviceSerialSession, reason: Error) {
            if (sessionRef.current !== candidate) return;
            void disconnect()
              .then(() => {
                if (mountedRef.current) setError(reason.message);
              })
              .catch(() => undefined);
          },
        };
        const preferred = selectedPort
          ? null
          : await getSavedSerialPort(serial, LAST_PORT_KEY, ports);
        if (automatic && !preferred) return;
        let result;
        if (selectedPort || (!ports.length && !automatic)) {
          const port = selectedPort ?? await serial.requestPort();
          result = await connectSelectedDevice(
            port,
            controller.signal,
            callbacks,
          );
        } else {
          result = await discoverDevice(
            ports,
            preferred,
            controller.signal,
            callbacks,
          );
        }
        if (!result) {
          if (mountedRef.current) {
            setError('未找到可用设备');
            setManualSelection(true);
          }
          return;
        }
        session = result.session;
        sessionRef.current = session;
        if (controller.signal.aborted || !mountedRef.current) {
          await releaseSession(session);
          return;
        }
        if (!session.isOpen) throw new Error('设备已断开连接');
        setConnection('connected');
        setManualSelection(false);
        rememberSerialPort(LAST_PORT_KEY, result.port);
        await session.requestHistory();
      } catch (reason) {
        let releaseFailed = false;
        let message = messageOf(reason);
        if (reason instanceof DevicePortReleaseError) {
          session = reason.session;
          sessionRef.current = session;
          releaseFailed = true;
        } else if (session) {
          try {
            await releaseSession(session);
          } catch (closeReason) {
            releaseFailed = true;
            message = messageOf(closeReason);
          }
        }
        if (mountedRef.current) {
          if (
            !releaseFailed &&
            !(reason instanceof DOMException &&
              ['NotFoundError', 'AbortError'].includes(reason.name))
          )
            setManualSelection(true);
          if (reason instanceof DeviceSelectionError) {
            message = '找到多台设备';
          } else if (reason instanceof BatteryIdentityTimeoutError) {
            message = '设备未响应';
          }
          setConnection(releaseFailed ? 'release-error' : 'disconnected');
          setBattery(markHistoryIncomplete);
          if (
            releaseFailed ||
            !(
              reason instanceof DOMException &&
              ['NotFoundError', 'AbortError'].includes(reason.name)
            )
          ) {
            setError(message);
          }
        }
      } finally {
        if (connectControllerRef.current === controller)
          connectControllerRef.current = null;
        if (mountedRef.current && !sessionRef.current)
          setConnection('disconnected');
        markBusy(false);
      }
    })();
    connectTaskRef.current = operation;
    await operation;
    if (connectTaskRef.current === operation) connectTaskRef.current = null;
  }

  const connectLastDevice = useEffectEvent(async () => {
    await connectTaskRef.current;
    if (mountedRef.current) await connect(true);
  });

  useEffect(() => {
    mountedRef.current = true;
    if (serialSupported) void connectLastDevice();
    return () => {
      mountedRef.current = false;
      connectControllerRef.current?.abort();
      void sessionRef.current?.close().catch(() => undefined);
      void upgradeProbeRef.current?.close().catch(() => undefined);
    };
  }, [serialSupported]);

  async function withUpgrade<T>(
    operation: (port: SerialPortLike) => Promise<T>,
  ): Promise<T> {
    if (busyRef.current) throw new Error('设备连接正在切换，请稍后重试');
    const session = sessionRef.current;
    if (session && !session.isOpen) throw new Error('请先重试断开设备连接');
    markBusy(true);
    try {
      if (upgradeProbeRef.current) {
        await upgradeProbeRef.current.close();
        upgradeProbeRef.current = null;
      }
      const serial = (navigator as Navigator & { serial: SerialApi }).serial;
      const selectedPort = await serial.requestPort();
      await verifyUpgradePort(selectedPort, session);
      if (session && selectedPort === session.port)
        return await session.withUpgrade(operation);
      return await operation(selectedPort);
    } catch (reason) {
      if (reason instanceof UpgradePortReleaseError)
        upgradeProbeRef.current = reason.session;
      if (reason instanceof DOMException && reason.name === 'SecurityError') {
        throw new Error('需要授权升级设备');
      }
      throw reason;
    } finally {
      markBusy(false);
    }
  }

  return (
    <DeviceContext.Provider
      value={{
        serialSupported,
        connection,
        connectionBusy,
        connected: connection === 'connected',
        manualSelection,
        error,
        battery,
        connect,
        disconnect,
        withUpgrade,
        async setCellInfo(field, value) {
          const session = sessionRef.current;
          if (!session?.isOpen || busyRef.current) throw new Error('请先连接设备');
          markBusy(true);
          try {
            await session.setCellInfo(field, value);
          } finally {
            markBusy(false);
          }
        },
        setTemperature(temperature, timeoutMs, signal) {
          const session = sessionRef.current;
          if (!session?.isOpen || busyRef.current)
            return Promise.reject(new Error('请先连接设备'));
          return session.setTemperature(temperature, timeoutMs, signal);
        },
      }}
    >
      {children}
    </DeviceContext.Provider>
  );
}

export function useDeviceConnection() {
  const value = useContext(DeviceContext);
  if (!value) throw new Error('设备连接必须在 DeviceConnectionProvider 中使用');
  return value;
}
