'use client';

import { useEffect, useRef, useState } from 'react';
import { NtcTimeoutError } from '@/lib/ntc-protocol';
import { useDeviceConnection } from '@/lib/device-connection-context';

const ACK_TIMEOUT_MS = 1000;

export default function NtcSimulator() {
  const {
    connectionBusy,
    connected,
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
            throw new Error(`${cur_temperature}℃ 设置失败，请检查设备后重试`);
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
              ? `${cur_temperature}℃ 设置超时，请检查设备连接后重试`
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

  if (!connected) return null;

  return (
    <section className="ntc-content" aria-label="数字电位器">
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
          aria-label="设定温度"
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
    </section>
  );
}
