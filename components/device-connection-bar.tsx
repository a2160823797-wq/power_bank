import { Loader2 } from 'lucide-react';
import { useDeviceConnection } from '@/lib/device-connection-context';
import type { DeviceKind } from '@/lib/device-session';

export function DeviceConnectionButton({ kind }: { kind: DeviceKind }) {
  const {
    serialSupported,
    connection,
    connectionBusy,
    connected,
    connect,
    disconnect,
  } = useDeviceConnection();
  const buttonText = {
    disconnected: '连接设备',
    connecting: '连接中',
    connected: '断开连接',
    disconnecting: '断开中',
    'release-error': '重试断开',
  }[connection];

  return (
    <button
      className={`device-button ${connection === 'disconnected' || connection === 'connecting' ? 'device-button-primary' : 'device-button-secondary'}`}
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
  );
}

export default function DeviceConnectionBar() {
  const { serialSupported, error } = useDeviceConnection();
  return (
    <>
      {serialSupported === false && (
        <p className="device-message device-connection-message" role="alert">
          当前浏览器不支持串口连接，请使用桌面版 Chrome 或 Edge。
        </p>
      )}
      {error && (
        <p className="device-message device-connection-message" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
