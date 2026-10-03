'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  CircleAlert,
  Loader2,
  Plug,
  Unplug,
} from 'lucide-react';
import {
  BatterySerialSession,
  createBatteryState,
} from '@/lib/battery-protocol';
import type { SerialApi } from '@/lib/iap-protocol';

export interface BatteryMonitorHandle {
  disconnect(): Promise<void>;
}

interface BatteryMonitorProps {
  serialSupported: boolean | null;
  autoConnect: boolean;
  onConnectionBusyChange?: (busy: boolean) => void;
}

type Connection =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'release-error';

const LAST_PORT_KEY = 'powerbank.last-serial-port';

const beijingReportTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const beijingHistoryTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(seconds: number | null, empty = '—') {
  return seconds === null ? empty : beijingHistoryTime.format(seconds * 1000);
}

function formatVoltage(millivolts: number | null) {
  return millivolts === null ? <EmptyValue /> : (millivolts / 1000).toFixed(3);
}

function EmptyValue() {
  return <span className="battery-empty-value" role="img" aria-label="暂无数据">—</span>;
}

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

const BatteryMonitor = forwardRef<BatteryMonitorHandle, BatteryMonitorProps>(
  function BatteryMonitor({ serialSupported, autoConnect, onConnectionBusyChange }, ref) {
    const [battery, setBattery] = useState(createBatteryState);
    const [connection, setConnection] = useState<Connection>('disconnected');
    const [error, setError] = useState('');
    const mountedRef = useRef(true);
    const busyRef = useRef(false);
    const sessionRef = useRef<BatterySerialSession | null>(null);
    const connectPromiseRef = useRef<Promise<void> | null>(null);
    const closePromiseRef = useRef<Promise<void> | null>(null);

    const setConnectionBusy = useCallback(
      (busy: boolean) => {
        busyRef.current = busy;
        if (mountedRef.current) onConnectionBusyChange?.(busy);
      },
      [onConnectionBusyChange],
    );

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        const session = sessionRef.current;
        sessionRef.current = null;
        void session?.close().catch(() => undefined);
      };
    }, []);

    const disconnect = useCallback(async () => {
      await connectPromiseRef.current;
      if (closePromiseRef.current) return closePromiseRef.current;
      const session = sessionRef.current;
      if (!session) return;
      setConnectionBusy(true);
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
            setError(errorMessage(reason, '无法释放串口，请重试断开连接'));
          }
          throw reason;
        } finally {
          setConnectionBusy(false);
        }
      })();
      closePromiseRef.current = operation;
      try {
        await operation;
      } finally {
        closePromiseRef.current = null;
      }
    }, [setConnectionBusy]);

    useImperativeHandle(ref, () => ({ disconnect }), [disconnect]);

    async function connect(automatic = false) {
      if (busyRef.current || sessionRef.current || !serialSupported) return;
      setConnectionBusy(true);
      setConnection('connecting');
      setError('');
      const operation = (async () => {
        let session: BatterySerialSession | null = null;
        try {
          const serial = (navigator as Navigator & { serial: SerialApi })
            .serial;
          let port;
          if (automatic) {
            let saved;
            try {
              const value = localStorage.getItem(LAST_PORT_KEY);
              if (!value) return;
              saved = JSON.parse(value);
              if (!saved || typeof saved !== 'object') return;
            } catch {
              return;
            }
            const ports = await serial.getPorts();
            const matches = ports.filter((candidate) => {
              const info = candidate.getInfo();
              return info.usbVendorId === saved.usbVendorId &&
                info.usbProductId === saved.usbProductId &&
                info.bluetoothServiceClassId === saved.bluetoothServiceClassId;
            });
            if (matches.length !== 1) return;
            port = matches[0];
          } else {
            port = await serial.requestPort();
          }
          if (!mountedRef.current) return;
          setBattery(createBatteryState());
          session = new BatterySerialSession(port, {
            onData(state) {
              if (mountedRef.current && sessionRef.current === session)
                setBattery(state);
            },
            onDisconnect() {
              if (sessionRef.current !== session) return;
              sessionRef.current = null;
              if (mountedRef.current) {
                setConnection('disconnected');
                setBattery((current) =>
                  current.historyStatus === 'receiving'
                    ? { ...current, historyStatus: 'incomplete' }
                    : current,
                );
              }
            },
            onError(message) {
              if (mountedRef.current && sessionRef.current === session)
                setError(message);
            },
          });
          sessionRef.current = session;
          await session.open();
          if (!mountedRef.current || sessionRef.current !== session) {
            await session.close();
            return;
          }
          setConnection('connected');
          try {
            localStorage.setItem(LAST_PORT_KEY, JSON.stringify(port.getInfo()));
          } catch {
            // 浏览器禁用本地存储时，仍保留本次串口连接
          }
          await session.requestSnapshot();
        } catch (reason) {
          let releaseFailed = false;
          if (session) {
            try {
              await session.close();
            } catch (closeReason) {
              releaseFailed = true;
              if (mountedRef.current)
                setError(
                  errorMessage(closeReason, '无法释放串口，请重试断开连接'),
                );
            }
          }
          if (!releaseFailed && sessionRef.current === session)
            sessionRef.current = null;
          if (mountedRef.current) {
            setConnection(releaseFailed ? 'release-error' : 'disconnected');
            setBattery((current) =>
              current.historyStatus === 'receiving'
                ? { ...current, historyStatus: 'incomplete' }
                : current,
            );
            if (
              !releaseFailed &&
              !(
                reason instanceof DOMException &&
                reason.name === 'NotFoundError'
              )
            )
              setError(errorMessage(reason, '串口连接失败'));
          }
        } finally {
          if (mountedRef.current && !sessionRef.current)
            setConnection('disconnected');
          setConnectionBusy(false);
        }
      })();
      connectPromiseRef.current = operation;
      await operation;
      if (connectPromiseRef.current === operation)
        connectPromiseRef.current = null;
    }

    const connectLastPort = useEffectEvent(() => {
      void connect(true);
    });

    useEffect(() => {
      if (serialSupported && autoConnect) connectLastPort();
    }, [serialSupported, autoConnect]);

    const connected = connection === 'connected';
    const connectionBusy =
      connection === 'connecting' || connection === 'disconnecting';
    const visibleCellCount = battery.cellCount ?? 0;
    const showRecordCell = battery.cellCount !== 1;
    const historyDescription = {
      unread: '',
      receiving: `已收到 ${battery.records.length} 条${battery.historyExpected === null ? '，等待设备返回完整记录。' : `，共 ${battery.historyExpected} 条，等待传输完成。`}`,
      incomplete: `已收到 ${battery.records.length} 条${battery.historyExpected === null ? '' : `，预期 ${battery.historyExpected} 条`}。请重新连接设备以读取完整记录。`,
      complete:
        battery.records.length === 0
          ? '本次读取已完成，设备报告的记录数为 0。'
          : '',
    }[battery.historyStatus];

    return (
      <section className="battery-content" aria-label="电池监测">
        <section className="battery-connection" aria-label="串口连接">
          <div className="battery-data-status" aria-live="polite">
            <span>
              最近上报：
              {battery.lastReceivedAt === null
                ? <EmptyValue />
                : beijingReportTime.format(battery.lastReceivedAt)}
            </span>
          </div>
          <div className="battery-actions">
            <button
              className={`battery-button ${connected || connection === 'release-error' ? 'battery-button-secondary' : 'battery-button-primary'}`}
              type="button"
              disabled={connectionBusy || !serialSupported}
              onClick={() => {
                if (connected || connection === 'release-error')
                  void disconnect().catch(() => undefined);
                else void connect();
              }}
            >
              {connectionBusy ? (
                <Loader2 className="battery-spin" />
              ) : connected || connection === 'release-error' ? (
                <Unplug />
              ) : (
                <Plug />
              )}
              {connection === 'connecting'
                ? '正在连接'
                : connection === 'disconnecting'
                  ? '正在断开'
                  : connection === 'release-error'
                    ? '重试断开'
                    : connected
                      ? '断开连接'
                      : '连接设备'}
            </button>
          </div>
        </section>

        {serialSupported === false && (
          <p className="battery-message" role="alert">
            <CircleAlert />
            当前浏览器不支持串口连接，请使用桌面版 Chrome 或 Edge。
          </p>
        )}
        {error && (
          <p className="battery-message battery-message-error" role="alert">
            <CircleAlert />
            {error}
          </p>
        )}

        <section className="battery-metrics" aria-label="电池实时参数">
          <div className="battery-metric">
            <p className="battery-field-label">电池总电压</p>
            <p className="battery-metric-value">
              {formatVoltage(battery.totalVoltageMv)}
              <span>V</span>
            </p>
          </div>
          <div className="battery-metric">
            <p className="battery-field-label">电池温度</p>
            <p className="battery-metric-value">
              {battery.temperatureC === null
                ? <EmptyValue />
                : battery.temperatureC.toFixed(1)}
              <span>°C</span>
            </p>
          </div>
        </section>

        <div className="battery-details-grid">
          {visibleCellCount > 1 && (
          <section
            className="battery-panel"
            aria-labelledby="battery-cells-title"
          >
            <div className="battery-panel-heading">
              <h2 id="battery-cells-title">各串电压</h2>
              <span className="battery-section-note">
                {visibleCellCount} 串电池
              </span>
            </div>
              <div className="battery-cell-grid">
                {Array.from({ length: visibleCellCount }, (_, index) => (
                  <div className="battery-cell" key={index}>
                    <span>第 {index + 1} 串</span>
                    <strong>
                      {formatVoltage(battery.cellVoltagesMv[index] ?? null)}{' '}
                      <small>V</small>
                    </strong>
                  </div>
                ))}
              </div>
          </section>
          )}

          <section
            className="battery-panel"
            aria-labelledby="battery-identity-title"
          >
            <div className="battery-panel-heading">
              <h2 id="battery-identity-title">电芯信息</h2>
            </div>
            <dl className="battery-identity">
              <div>
                <dt>型号</dt>
                <dd>{battery.batteryModel || <EmptyValue />}</dd>
              </div>
              <div>
                <dt>编码</dt>
                <dd>{battery.batteryCode || <EmptyValue />}</dd>
              </div>
            </dl>
          </section>
        </div>

        <section
          className="battery-panel battery-history"
          aria-labelledby="battery-history-title"
        >
          <div className="battery-panel-heading">
            <h2 id="battery-history-title">异常记录</h2>
          </div>
          {battery.records.length === 0 ? (
            <div className="battery-history-empty" aria-live="polite">
              {battery.historyStatus === 'complete' ? (
                <h3>无异常记录</h3>
              ) : (
                <EmptyValue />
              )}
            </div>
          ) : (
            <>
              {historyDescription && (
                <p className="battery-history-description" aria-live="polite">
                  {historyDescription}
                </p>
              )}
              <ul className="battery-records" aria-label="电池异常记录">
                {battery.records.map((record) => (
                  <li key={record.id}>
                    <div className="battery-record-heading">
                      <h3>
                        {record.type === 'overvoltage'
                          ? '过充电压'
                          : '高温'}
                      </h3>
                      {showRecordCell && (
                        <span>
                          {record.cell === 0
                            ? '整组电池'
                            : `第 ${record.cell} 串`}
                        </span>
                      )}
                    </div>
                    <p className="battery-record-value" aria-label="记录数值">
                      {record.type === 'overvoltage'
                        ? (record.value / 1000).toFixed(3)
                        : (record.value / 10).toFixed(1)}
                      <span>{record.type === 'overvoltage' ? 'V' : '°C'}</span>
                    </p>
                    <p className="battery-record-time" aria-label="发生时间">
                      {formatTime(record.timeUnixSeconds, '未记录')}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </section>
    );
  },
);

export default BatteryMonitor;
