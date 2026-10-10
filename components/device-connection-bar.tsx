import { Loader2 } from 'lucide-react';
import { useDeviceConnection } from '@/lib/device-connection-context';

export function DeviceConnectionButton({ hidden = false }: { hidden?: boolean }) {
  const {
    serialSupported,
    connection,
    connectionBusy,
    connected,
    manualSelection,
    connect,
    disconnect,
  } = useDeviceConnection();
  const buttonText = {
    disconnected: manualSelection ? '选择设备' : '连接设备',
    connecting: '连接中',
    connected: '断开连接',
    disconnecting: '断开中',
    'release-error': '重试断开',
  }[connection];

  return (
    <button
      className={`device-button ${connection === 'disconnected' || connection === 'connecting' ? 'device-button-primary' : 'device-button-secondary'}${hidden ? ' is-hidden' : ''}`}
      type="button"
      disabled={hidden || connectionBusy || !serialSupported}
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : undefined}
      onClick={() => {
        void (
          connected || connection === 'release-error'
            ? disconnect()
            : connect(manualSelection)
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
