'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createBatteryState,
  BatteryIdentityTimeoutError,
  type BatteryState,
} from './battery-protocol';
import { NtcIdentityTimeoutError, type NtcReply } from './ntc-protocol';
import type { SerialApi, SerialPortLike } from './iap-protocol';
import { DeviceSerialSession } from './device-session';
import {
  connectSelectedDevice,
  discoverDevice,
  DeviceSelectionError,
  DevicePortReleaseError,
} from './device-connection';
import { getSavedSerialPort, rememberSerialPort } from './serial-device';
import { getWorkspaceView } from './workspace-view';

type DeviceKind = 'battery' | 'ntc';
type Connection =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'release-error';
interface DeviceConnection {
  serialSupported: boolean | null;
  connection: Connection;
  connectionBusy: boolean;
  connected: boolean;
  selectionRequired: boolean;
  error: string;
  battery: BatteryState;
  connect: (kind: DeviceKind, automatic?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
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
const LAST_KIND_KEY = 'powerbank.device-kind';
const DeviceContext = createContext<DeviceConnection | null>(null);
const subscribeSerialSupport = () => () => {};
const getSerialSupport = () => 'serial' in navigator;
const getServerSerialSupport = () => null;
const messageOf = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

function automaticKind(): DeviceKind {
  const kind = getWorkspaceView() === 'ntc' ? 'ntc' : 'battery';
  try {
    const saved = localStorage.getItem(LAST_KIND_KEY);
    if (saved === 'battery' || saved === 'ntc') return saved;
    const oldKey =
      kind === 'ntc'
        ? 'powerbank.ntc-last-serial-port'
        : 'powerbank.last-serial-port';
    const otherKey =
      kind === 'ntc'
        ? 'powerbank.last-serial-port'
        : 'powerbank.ntc-last-serial-port';
    if (!localStorage.getItem(oldKey) && localStorage.getItem(otherKey))
      return kind === 'ntc' ? 'battery' : 'ntc';
  } catch {}
  return kind;
}

export function DeviceConnectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const serialSupported = useSyncExternalStore<boolean | null>(
    subscribeSerialSupport,
    getSerialSupport,
    getServerSerialSupport,
  );
  const [connection, setConnection] = useState<Connection>('disconnected');
  const [battery, setBattery] = useState(createBatteryState);
  const [error, setError] = useState('');
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const sessionRef = useRef<DeviceSerialSession | null>(null);
  const connectTaskRef = useRef<Promise<void> | null>(null);
  const connectControllerRef = useRef<AbortController | null>(null);
  const closeTaskRef = useRef<Promise<void> | null>(null);

  const markBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    if (mountedRef.current) setConnectionBusy(value);
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
        await session.close();
        if (sessionRef.current === session) sessionRef.current = null;
        if (mountedRef.current) {
          setConnection('disconnected');
          setBattery((current) =>
            current.historyStatus === 'receiving'
              ? { ...current, historyStatus: 'incomplete' }
              : current,
          );
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
  }, [markBusy]);

  async function connect(kind: DeviceKind, automatic = false) {
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
        let selectedPort =
          !automatic && selectionRequired ? await serial.requestPort() : null;
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
        let result;
        if (selectedPort) {
          result = await connectSelectedDevice(
            selectedPort,
            kind,
            controller.signal,
            callbacks,
          );
        } else {
          const ports = await serial.getPorts();
          const preferred =
            (await getSavedSerialPort(serial, LAST_PORT_KEY, ports)) ??
            (await getSavedSerialPort(
              serial,
              kind === 'ntc'
                ? 'powerbank.ntc-last-serial-port'
                : 'powerbank.last-serial-port',
              ports,
            ));
          if (automatic && !preferred) return;
          if (!ports.length && !automatic) {
            selectedPort = await serial.requestPort();
            result = await connectSelectedDevice(
              selectedPort,
              kind,
              controller.signal,
              callbacks,
            );
          } else {
            result = await discoverDevice(
              ports,
              preferred,
              kind,
              controller.signal,
              callbacks,
            );
          }
        }
        if (!result) {
          if (mountedRef.current) {
            setSelectionRequired(true);
            setError('未找到可用设备，请点击“选择设备”连接');
          }
          return;
        }
        session = result.session;
        sessionRef.current = session;
        if (controller.signal.aborted || !mountedRef.current) {
          await session.close();
          if (sessionRef.current === session) sessionRef.current = null;
          return;
        }
        if (!session.isOpen) throw new Error('设备已断开连接');
        setSelectionRequired(false);
        setConnection('connected');
        rememberSerialPort(LAST_PORT_KEY, result.port);
        try {
          localStorage.setItem(LAST_KIND_KEY, kind);
        } catch {}
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
            await session.close();
          } catch (closeReason) {
            releaseFailed = true;
            message = messageOf(closeReason);
          }
        }
        if (!releaseFailed && sessionRef.current === session)
          sessionRef.current = null;
        if (mountedRef.current) {
          if (reason instanceof DeviceSelectionError) {
            setSelectionRequired(true);
            message = '找到多台设备，请点击“选择设备”确认';
          } else if (
            reason instanceof BatteryIdentityTimeoutError ||
            reason instanceof NtcIdentityTimeoutError
          ) {
            setSelectionRequired(true);
          } else if (
            !automatic &&
            reason instanceof DOMException &&
            reason.name === 'SecurityError'
          ) {
            setSelectionRequired(true);
          }
          setConnection(releaseFailed ? 'release-error' : 'disconnected');
          setBattery((current) =>
            current.historyStatus === 'receiving'
              ? { ...current, historyStatus: 'incomplete' }
              : current,
          );
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
    if (mountedRef.current) await connect(automaticKind(), true);
  });

  useEffect(() => {
    mountedRef.current = true;
    if (serialSupported) void connectLastDevice();
    return () => {
      mountedRef.current = false;
      connectControllerRef.current?.abort();
      void sessionRef.current?.close().catch(() => undefined);
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
      if (session) return await session.withUpgrade(operation);
      const serial = (navigator as Navigator & { serial: SerialApi }).serial;
      return await operation(await serial.requestPort());
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
        selectionRequired,
        error,
        battery,
        connect,
        disconnect,
        withUpgrade,
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
