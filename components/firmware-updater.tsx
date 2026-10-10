import { useRef, useState } from 'react';
import { IapSerialSession, validateFirmware } from '@/lib/iap-protocol';
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
type FirmwareInfo = { file: File; data: Uint8Array };

const t = {
  upgrade: '固件升级',
  chooseFirmware: '选择固件',
  replaceFirmware: '更换固件',
  readingFirmware: '读取固件…',
  pleaseWait: '请稍候',
  clickToReplace: '点击更换',
  dropFirmware: '也可将 .bin 文件拖到这里',
  browserNote: '请使用电脑上的 Chrome 或 Edge 连接设备。',
  startUpgrade: '升级',
  restartUpgrade: '升级',
  stages: {
    idle: '等待固件',
    ready: '准备就绪',
    connecting: '正在连接设备',
    preparing: '正在进入升级模式',
    writing: '正在传输固件',
    verifying: '正在核对升级状态、长度和 CRC32',
    success: '升级完成',
    error: '升级失败',
  } satisfies Record<Stage, string>,
};

export default function FirmwareUpdater({ active }: { active: boolean }) {
  const { serialSupported, connectionBusy, withUpgrade } =
    useDeviceConnection();
  const [loadingFile, setLoadingFile] = useState(false);
  const runningRef = useRef(false);
  const fileLoadRef = useRef(0);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const running = ['connecting', 'preparing', 'writing', 'verifying'].includes(
    stage,
  );
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
      setFirmware({ file, data });
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
    try {
      await withUpgrade(async (port) => {
        const session = new IapSerialSession(port);
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
      runningRef.current = false;
    }
  }

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
