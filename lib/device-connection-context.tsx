import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createBatteryState,
  BatteryIdentityTimeoutError,
  type BatteryState,
} from './battery-protocol';
import { NtcIdentityTimeoutError, type NtcReply } from './ntc-protocol';
import type { IapSerialSession, SerialApi, SerialPortLike } from './iap-protocol';
import { DeviceSerialSession, type DeviceKind } from './device-session';
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
  discoverUpgradePort,
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
  deviceKind: DeviceKind | null;
  manualSelection: boolean;
  error: string;
  battery: BatteryState;
  connect: (manual?: boolean, kind?: DeviceKind) => Promise<void>;
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
const LAST_UPGRADE_PORT_KEY = 'powerbank.upgrade-last-successful-serial-port';
const DeviceContext = createContext<DeviceConnection | null>(null);
const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function clearBatteryData(cur_state: BatteryState): BatteryState {
  return { ...createBatteryState(), cellCount: cur_state.cellCount };
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
  const lastUpgradePortRef = useRef<SerialPortLike | null>(null);

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
      setBattery(clearBatteryData);
      setError('');
    }
    const operation = (async () => {
      try {
        await releaseSession(session);
        if (mountedRef.current) {
          setConnection('disconnected');
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
    if (connection !== 'connected' || connectionBusy || sessionRef.current?.kind !== 'battery') return;
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

  async function connect(manual = false, kind: DeviceKind = 'battery') {
    if (busyRef.current || sessionRef.current || !serialSupported) return;
    markBusy(true);
    setConnection('connecting');
    setBattery(createBatteryState);
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
        let result;
        if (selectedPort || !ports.length) {
          const port = selectedPort ?? await serial.requestPort();
          result = await connectSelectedDevice(
            port,
            controller.signal,
            callbacks,
            kind,
          );
        } else {
          result = await discoverDevice(
            ports,
            preferred,
            controller.signal,
            callbacks,
            kind,
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
        if (kind === 'battery') await session.requestHistory();
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
          } else if (reason instanceof BatteryIdentityTimeoutError || reason instanceof NtcIdentityTimeoutError) {
            message = '设备未响应';
          }
          setConnection(releaseFailed ? 'release-error' : 'disconnected');
          setBattery(clearBatteryData);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      connectControllerRef.current?.abort();
      void sessionRef.current?.close().catch(() => undefined);
      void upgradeProbeRef.current?.close().catch(() => undefined);
    };
  }, []);

  async function withUpgrade<T>(
    operation: (port: SerialPortLike) => Promise<T>,
  ): Promise<T> {
    if (connectTaskRef.current) await connectTaskRef.current;
    if (closeTaskRef.current) await closeTaskRef.current;
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
      let selectedPort = lastUpgradePortRef.current;
      if (selectedPort) {
        try {
          await verifyUpgradePort(selectedPort, session);
        } catch (reason) {
          if (reason instanceof UpgradePortReleaseError) throw reason;
          selectedPort = null;
          lastUpgradePortRef.current = null;
        }
      }
      if (!selectedPort) {
        let hasSavedPort = false;
        try {
          hasSavedPort = Boolean(localStorage.getItem(LAST_UPGRADE_PORT_KEY));
        } catch {}
        if (hasSavedPort) {
          const ports = await serial.getPorts();
          const preferredPort = await getSavedSerialPort(serial, LAST_UPGRADE_PORT_KEY, ports);
          try {
            selectedPort = await discoverUpgradePort(ports, preferredPort, session);
          } catch (reason) {
            if (!(reason instanceof DeviceSelectionError)) throw reason;
          }
        }
      }
      if (!selectedPort) {
        try {
          selectedPort = await serial.requestPort();
        } catch (reason) {
          if (
            reason instanceof DOMException &&
            ['NotFoundError', 'AbortError'].includes(reason.name)
          )
            throw new Error('升级已取消');
          throw reason;
        }
        await verifyUpgradePort(selectedPort, session);
      }
      const runOperation = async (port: SerialPortLike) => {
        const result = await operation(port);
        lastUpgradePortRef.current = port;
        rememberSerialPort(LAST_UPGRADE_PORT_KEY, port);
        return result;
      };
      if (session && selectedPort === session.port)
        return await session.withUpgrade(runOperation);
      return await runOperation(selectedPort);
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
        deviceKind: sessionRef.current?.kind ?? null,
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
