'use client';

import { CircleAlert, Loader2 } from 'lucide-react';
import { useDeviceConnection } from '@/lib/device-connection-context';
import type { DeviceKind } from '@/lib/device-session';

const reportTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export default function DeviceConnectionBar({ kind }: { kind: DeviceKind }) {
  const {
    serialSupported,
    connection,
    connectionBusy,
    connected,
    selectionRequired,
    error,
    battery,
    connect,
    disconnect,
  } = useDeviceConnection();
  const buttonText = {
    disconnected: selectionRequired ? '选择设备' : '连接设备',
    connecting: '正在连接',
    connected: '断开连接',
    disconnecting: '正在断开',
    'release-error': '重试断开',
  }[connection];

  return (
    <section
      className={`device-connection${connected ? '' : ' is-empty'}`}
      aria-label="设备连接"
    >
      <div className="device-connection-panel">
        <div className="device-connection-row">
          {kind === 'battery' && connected && (
            <span className="device-report" aria-live="polite">
              最近上报：
              {battery.lastReceivedAt === null ? (
                <span role="img" aria-label="暂无数据">
                  —
                </span>
              ) : (
                reportTime.format(battery.lastReceivedAt)
              )}
            </span>
          )}
          <button
            className={`device-button ${connected || connection === 'release-error' ? 'device-button-secondary' : 'device-button-primary'}`}
            type="button"
            disabled={connectionBusy || !serialSupported}
            onClick={() => {
              void (
                connected || connection === 'release-error'
                  ? disconnect()
                  : connect(kind)
              ).catch(() => undefined);
            }}
          >
            {connectionBusy && (
              <Loader2 className="device-spin" aria-hidden="true" />
            )}
            {buttonText}
          </button>
        </div>
        {serialSupported === false && (
          <p className="device-message" role="alert">
            <CircleAlert aria-hidden="true" />
            当前浏览器不支持串口连接，请使用桌面版 Chrome 或 Edge。
          </p>
        )}
        {error && (
          <p className="device-message device-message-error" role="alert">
            <CircleAlert aria-hidden="true" />
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
