'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { SerialApi } from '@/lib/iap-protocol';
import { NtcSerialSession, NtcTimeoutError } from '@/lib/ntc-protocol';
import { useLanguage } from '@/lib/language';

export interface NtcSimulatorHandle {
  disconnect(): Promise<void>;
}
interface Props {
  serialSupported: boolean | null;
  onConnectionBusyChange?: (busy: boolean) => void;
}
const ACK_TIMEOUT_MS = 1000;

const NtcSimulator = forwardRef<NtcSimulatorHandle, Props>(
  function NtcSimulator({ serialSupported, onConnectionBusyChange }, ref) {
    const { language } = useLanguage();
    const en = language === 'en';
    const t = (zh: string, english: string) => (en ? english : zh);
    const [temperature, setTemperature] = useState(25);
    const [connected, setConnected] = useState(false);
    const [connectionBusy, setConnectionBusy] = useState(false);
    const [message, setMessage] = useState('');
    const sessionRef = useRef<NtcSerialSession | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const queuedTemperature = useRef<number | null>(null);
    const sendingRef = useRef(false);
    const connectionBusyRef = useRef(false);
    const taskRef = useRef<Promise<void> | null>(null);

    function busy(value: boolean) {
      connectionBusyRef.current = value;
      setConnectionBusy(value);
      onConnectionBusyChange?.(value);
    }
    function cancelRequest() {
      queuedTemperature.current = null;
      controllerRef.current?.abort();
    }
    async function disconnect() {
      if (!sessionRef.current && !sendingRef.current) return;
      if (connectionBusyRef.current) throw new Error('串口正在切换，请稍候');
      busy(true);
      cancelRequest();
      try {
        await taskRef.current;
        await sessionRef.current?.close();
        sessionRef.current = null;
        setConnected(false);
        setMessage('');
      } catch (reason) {
        setMessage(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      } finally {
        busy(false);
      }
    }
    useImperativeHandle(ref, () => ({ disconnect }));
    useEffect(
      () => () => {
        controllerRef.current?.abort();
        void sessionRef.current?.close().catch(() => undefined);
      },
      [],
    );

    async function connect() {
      if (connectionBusyRef.current) return;
      busy(true);
      setMessage('');
      try {
        await taskRef.current;
        await sessionRef.current?.close();
        sessionRef.current = null;
        const serial = (navigator as Navigator & { serial: SerialApi }).serial;
        const port = await serial.requestPort();
        const session = new NtcSerialSession(
          port,
          () => undefined,
          () => {
            cancelRequest();
            setConnected(false);
            setMessage(
              t(
                '串口已断开，请重新连接',
                'Serial disconnected. Please reconnect.',
              ),
            );
          },
        );
        sessionRef.current = session;
        await session.open();
        setConnected(true);
      } catch (reason) {
        let detail = reason instanceof Error ? reason.message : String(reason);
        try {
          await sessionRef.current?.close();
          sessionRef.current = null;
        } catch (closeError) {
          detail += `；${closeError instanceof Error ? closeError.message : String(closeError)}`;
        }
        setMessage(detail);
      } finally {
        busy(false);
      }
    }

    function sendTemperature(value: number) {
      if (!sessionRef.current || !connected || connectionBusyRef.current)
        return;
      queuedTemperature.current = value;
      if (sendingRef.current) return;
      const session = sessionRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      sendingRef.current = true;
      setMessage('');
      taskRef.current = (async () => {
        let cur_temperature = value;
        try {
          while (queuedTemperature.current !== null) {
            cur_temperature = queuedTemperature.current;
            queuedTemperature.current = null;
            const reply = await session.setTemperature(
              cur_temperature,
              ACK_TIMEOUT_MS,
              controller.signal,
            );
            if (reply.status !== 0) {
              throw new Error(
                t(
                  `${cur_temperature}℃ 设置失败，请检查设备后重试`,
                  `Failed to set ${cur_temperature}°C. Check the device and try again.`,
                ),
              );
            }
          }
        } catch (reason) {
          if (!controller.signal.aborted) {
            setMessage(
              reason instanceof NtcTimeoutError
                ? t(
                    `${cur_temperature}℃ 设置超时，请检查设备连接后重试`,
                    `Setting ${cur_temperature}°C timed out. Check the connection and try again.`,
                  )
                : reason instanceof Error
                  ? reason.message
                  : String(reason),
            );
          }
        } finally {
          controllerRef.current = null;
          sendingRef.current = false;
          queuedTemperature.current = null;
        }
      })();
    }

    return (
      <section
        className="ntc-content"
        aria-label={t('数字电位器', 'Digital potentiometer')}
      >
        <div className="ntc-heading">
          <button
            className="battery-button battery-button-primary"
            disabled={connectionBusy || !serialSupported}
            onClick={() =>
              void (connected ? disconnect() : connect()).catch(() => undefined)
            }
          >
            {connectionBusy
              ? t('处理中…', 'Working…')
              : connected
                ? t('断开串口', 'Disconnect')
                : t('连接串口', 'Connect serial')}
          </button>
        </div>
        {serialSupported === false && (
          <p className="ntc-alert" role="alert">
            {t(
              '请使用桌面版 Chrome / Edge 打开此 HTML，当前环境不支持 Web Serial。',
              'Open this HTML in desktop Chrome / Edge. Web Serial is unavailable here.',
            )}
          </p>
        )}
        {message && <output className="ntc-alert">{message}</output>}
        <section className="ntc-panel ntc-setpoint">
          <div className="ntc-temperature">
            <output htmlFor="ntc-temperature-slider">
              {temperature}
              <small>℃</small>
            </output>
          </div>
          <input
            id="ntc-temperature-slider"
            className="ntc-slider"
            type="range"
            min="-25"
            max="125"
            step="1"
            value={temperature}
            aria-label={t('设定温度', 'Set temperature')}
            onChange={(e) => setTemperature(Number(e.currentTarget.value))}
            onPointerDown={(e) =>
              e.currentTarget.setPointerCapture(e.pointerId)
            }
            onPointerUp={(e) => sendTemperature(Number(e.currentTarget.value))}
            onKeyUp={(e) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowRight',
                  'ArrowUp',
                  'ArrowDown',
                  'Home',
                  'End',
                  'PageUp',
                  'PageDown',
                ].includes(e.key)
              ) {
                sendTemperature(Number(e.currentTarget.value));
              }
            }}
          />
        </section>
      </section>
    );
  },
);

export default NtcSimulator;
