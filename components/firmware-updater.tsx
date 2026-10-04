import { useEffect, useRef, useState } from 'react';
import { crc32, IapSerialSession, validateFirmware } from '@/lib/iap-protocol';
import { useDeviceConnection } from '@/lib/device-connection-context';

type Stage =
  | 'idle'
  | 'ready'
  | 'connecting'
  | 'preparing'
  | 'writing'
  | 'verifying'
  | 'success'
  | 'error';
type FirmwareInfo = { file: File; data: Uint8Array; crc: number };

const t = {
  upgrade: '固件升级',
  chooseFirmware: '选择固件',
  replaceFirmware: '更换固件',
  readingFirmware: '读取固件…',
  pleaseWait: '请稍候',
  clickToReplace: '点击更换',
  dropFirmware: '也可将 .bin 文件拖到这里',
  browserNote: '请使用电脑上的 Chrome 或 Edge 连接设备。',
  startUpgrade: '一键升级',
  restartUpgrade: '再次升级',
  statusToolTitle: '读取固件升级状态',
  statusToolDescription:
    '读取当前已选固件、设备连接和升级进度，不改变设备状态。',
  deviceConnecting: '握手中',
  deviceConnected: '已连接',
  deviceDisconnected: '未连接',
  cancelToolTitle: '取消固件升级',
  cancelToolDescription: '仅在升级正在进行时向设备发送取消帧，并停止当前升级。',
  noActiveUpgrade: '当前没有正在进行的固件升级',
  stages: {
    idle: '等待固件',
    ready: '准备就绪',
    connecting: '正在连接设备',
    preparing: '正在进入升级模式',
    writing: '正在传输固件',
    verifying: '正在确认接收完成',
    success: '升级完成',
    error: '升级失败',
  } satisfies Record<Stage, string>,
};

function formatHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

export default function FirmwareUpdater({
  active,
  running,
  onRunningChange,
}: {
  active: boolean;
  running: boolean;
  onRunningChange: (value: boolean) => void;
}) {
  const { serialSupported, connectionBusy, connected, withUpgrade } =
    useDeviceConnection();
  const [loadingFile, setLoadingFile] = useState(false);
  const runningRef = useRef(false);
  const fileLoadRef = useRef(0);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const sessionRef = useRef<IapSerialSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef({
    stage,
    progress,
    firmware,
    connected,
  });
  useEffect(() => {
    statusRef.current = {
      stage,
      progress,
      firmware,
      connected,
    };
  });
  const validationError = firmware ? validateFirmware(firmware.data) : null;
  const displayedError = error || validationError;
  const showTransferStatus =
    ['writing', 'verifying'].includes(stage) ||
    (stage === 'error' && progress > 0);

  async function loadFile(file?: File) {
    if (!file || runningRef.current) return;
    const request = ++fileLoadRef.current;
    setLoadingFile(false);
    setFirmware(null);
    setProgress(0);
    setError('');
    setStage('idle');
    if (!file.name.toLowerCase().endsWith('.bin')) {
      setError('请选择原始 .bin 固件文件');
      setStage('error');
      return;
    }
    setLoadingFile(true);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (request !== fileLoadRef.current) return;
      const info = { file, data, crc: crc32(data) };
      setFirmware(info);
      setStage('ready');
      setProgress(0);
    } catch (reason) {
      if (request !== fileLoadRef.current) return;
      setError(reason instanceof Error ? reason.message : '无法读取固件文件');
      setStage('error');
    } finally {
      if (request === fileLoadRef.current) setLoadingFile(false);
    }
  }

  async function startUpgrade() {
    if (!firmware || runningRef.current || loadingFile || connectionBusy)
      return;
    if (validationError) {
      setError(validationError);
      setStage('error');
      return;
    }
    if (!serialSupported) {
      setError('当前浏览器不支持 Web Serial，请使用桌面版 Chrome 或 Edge');
      setStage('error');
      return;
    }
    setError('');
    setProgress(0);
    setStage('connecting');
    runningRef.current = true;
    onRunningChange(true);
    try {
      await withUpgrade(async (port) => {
        const session = new IapSerialSession(port);
        sessionRef.current = session;
        try {
          await session.open();
          await session.upgrade(
            firmware.file.name,
            firmware.data,
            (percent) => setProgress(percent),
            (nextStage) =>
              setStage(nextStage === 'handshake' ? 'preparing' : nextStage),
          );
        } finally {
          await session.close();
          sessionRef.current = null;
        }
      });
      setStage('success');
      setProgress(100);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : '升级过程中发生未知错误';
      if (message !== '升级已取消') {
        setError(message);
        setStage('error');
      } else {
        setStage('ready');
      }
    } finally {
      sessionRef.current = null;
      runningRef.current = false;
      onRunningChange(false);
    }
  }

  useEffect(() => {
    const modelContext = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: Record<string, unknown>,
            options?: { signal?: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!modelContext?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: Record<string, unknown>) => {
      try {
        void Promise.resolve(
          modelContext.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => undefined);
      } catch {}
    };
    register({
      name: 'get_firmware_upgrade_status',
      title: t.statusToolTitle,
      description: t.statusToolDescription,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() {
        const current = statusRef.current;
        return {
          stage: current.stage,
          progress: current.progress,
          device:
            current.stage === 'connecting'
              ? t.deviceConnecting
              : ['preparing', 'writing', 'verifying'].includes(current.stage)
                ? t.deviceConnected
                : current.connected
                  ? t.deviceConnected
                  : t.deviceDisconnected,
          firmware: current.firmware
            ? {
                name: current.firmware.file.name,
                size: current.firmware.data.length,
                crc32: formatHex(current.firmware.crc),
              }
            : null,
        };
      },
    });
    register({
      name: 'cancel_firmware_upgrade',
      title: t.cancelToolTitle,
      description: t.cancelToolDescription,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        if (!sessionRef.current) throw new Error(t.noActiveUpgrade);
        await sessionRef.current.cancel();
        return { cancelled: true };
      },
    });
    return () => lifecycle.abort();
  }, []);

  if (!active) return null;

  return (
    <section className="updater-content" aria-label={t.upgrade}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".bin,application/octet-stream"
        disabled={running || loadingFile}
        className="sr-only"
        tabIndex={-1}
        aria-label={t.chooseFirmware}
        onChange={(event) => {
          void loadFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <button
        className={`file-drop${dragging ? ' is-dragging' : ''}${firmware ? ' has-file' : ''}`}
        type="button"
        disabled={running || loadingFile}
        aria-label={
          firmware
            ? `${t.replaceFirmware}: ${firmware.file.name}`
            : t.chooseFirmware
        }
        title={firmware?.file.name}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!running && !loadingFile) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void loadFile(event.dataTransfer.files[0]);
        }}
      >
        <span className="file-copy">
          <span className="file-title">
            {loadingFile
              ? t.readingFirmware
              : firmware
                ? firmware.file.name
                : t.chooseFirmware}
          </span>
          {(!firmware || !running) && (
            <span className="file-description">
              {loadingFile
                ? t.pleaseWait
                : firmware
                  ? t.clickToReplace
                  : t.dropFirmware}
            </span>
          )}
        </span>
      </button>
      {(running || showTransferStatus || stage === 'success') && (
        <div className="transfer-status" data-state={stage}>
          <output className="transfer-caption" aria-live="polite">
            {t.stages[stage]}
            {stage === 'writing' && ` ${Math.round(progress)}%`}
          </output>
        </div>
      )}
      {displayedError && (
        <p className="error-message" role="alert">
          {displayedError}
        </p>
      )}
      {serialSupported === false && (
        <p className="browser-note">{t.browserNote}</p>
      )}
      {firmware && !running && (
        <div className="actions">
          <button
            type="button"
            className="primary-action"
            disabled={
              connectionBusy ||
              loadingFile ||
              !serialSupported ||
              Boolean(validationError)
            }
            onClick={startUpgrade}
          >
            {stage === 'success' ? t.restartUpgrade : t.startUpgrade}
          </button>
        </div>
      )}
    </section>
  );
}
