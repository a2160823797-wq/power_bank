'use client';

import { useEffect, useRef, useState } from 'react';
import { NtcTimeoutError } from '@/lib/ntc-protocol';
import { useDeviceConnection } from '@/lib/device-connection-context';
import { useLanguage } from '@/lib/language';
import { localizeProtocolMessage } from '@/lib/protocol-messages';

const ACK_TIMEOUT_MS = 1000;

export default function NtcSimulator() {
  const { language } = useLanguage();
  const en = language === 'en';
  const t = (zh: string, english: string) => (en ? english : zh);
  const {
    serialSupported,
    connection,
    connectionBusy,
    connected,
    selectionRequired,
    error,
    connect,
    disconnect,
    setTemperature: setDeviceTemperature,
  } = useDeviceConnection();
  const [temperature, setTemperature] = useState(25);
  const [feedbackState, setFeedbackState] = useState({
    connected,
    message: '',
  });
  if (feedbackState.connected !== connected) {
    setFeedbackState({ connected, message: '' });
  }
  const message = feedbackState.message;
  function setMessage(value: string) {
    setFeedbackState({ connected, message: value });
  }
  const controllerRef = useRef<AbortController | null>(null);
  const queuedTemperature = useRef<number | null>(null);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queuedTemperature.current = null;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!connected) {
      queuedTemperature.current = null;
      controllerRef.current?.abort();
    }
  }, [connected]);

  function sendTemperature(value: number) {
    if (!connected || connectionBusy) return;
    queuedTemperature.current = value;
    if (sendingRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    sendingRef.current = true;
    setMessage('');
    void (async () => {
      let cur_temperature = value;
      try {
        while (queuedTemperature.current !== null) {
          cur_temperature = queuedTemperature.current;
          queuedTemperature.current = null;
          const reply = await setDeviceTemperature(
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
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          !(reason instanceof Error && reason.name === 'AbortError')
        ) {
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

  const connectionButton = (
    <button
      className="battery-button battery-button-primary"
      disabled={connectionBusy || !serialSupported}
      onClick={() => {
        setMessage('');
        void (
          connected || connection === 'release-error'
            ? disconnect()
            : connect('ntc')
        ).catch(() => undefined);
      }}
    >
      {connection === 'connecting'
        ? t('正在连接…', 'Connecting…')
        : connection === 'disconnecting'
          ? t('正在断开…', 'Disconnecting…')
          : connection === 'release-error'
            ? t('重试断开', 'Retry disconnect')
            : connected
              ? t('断开设备', 'Disconnect device')
              : selectionRequired
                ? t('选择设备', 'Select device')
                : t('连接设备', 'Connect device')}
    </button>
  );
  const feedback = (
    <>
      {serialSupported === false && (
        <p className="ntc-alert" role="alert">
          {t(
            '请使用桌面版 Chrome / Edge 打开此 HTML，当前环境不支持 Web Serial。',
            'Open this HTML in desktop Chrome / Edge. Web Serial is unavailable here.',
          )}
        </p>
      )}
      {error && (
        <output className="ntc-alert">
          {localizeProtocolMessage(error, language)}
        </output>
      )}
      {message && <output className="ntc-alert">{message}</output>}
    </>
  );

  return (
    <section
      className="ntc-content"
      aria-label={t('数字电位器', 'Digital potentiometer')}
    >
      {!connected && (
        <div className="ntc-empty">
          {connectionButton}
          {feedback}
        </div>
      )}
      {connected && (
        <>
          <div className="ntc-heading">{connectionButton}</div>
          {feedback}
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
              onPointerUp={(e) =>
                sendTemperature(Number(e.currentTarget.value))
              }
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
        </>
      )}
    </section>
  );
}
