'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert } from 'lucide-react';
import { crc32, IapSerialSession, validateFirmware } from '@/lib/iap-protocol';
import BatteryMonitor from '@/components/battery-monitor';
import {
  getWorkspaceView,
  getServerWorkspaceView,
  setWorkspaceView,
  subscribeWorkspaceView,
  type WorkspaceView,
} from '@/lib/workspace-view';
import NtcSimulator from '@/components/ntc-simulator';
import DeviceConnectionBar from '@/components/device-connection-bar';
import {
  DeviceConnectionProvider,
  useDeviceConnection,
} from '@/lib/device-connection-context';

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
  navigation: '功能导航',
  battery: '电池监测',
  ntc: '数字电位器',
  upgrade: '固件升级',
  chooseFirmware: '选择固件',
  replaceFirmware: '更换固件',
  readingFirmware: '正在读取固件…',
  pleaseWait: '请稍候',
  clickToReplace: '点击更换',
  dropFirmware: '也可将 .bin 文件拖到这里',
  transferProgress: '固件传输进度',
  browserNote: '请使用电脑上的 Chrome 或 Edge 连接设备。',
  hideDetails: '收起详情',
  showDetails: '查看详情',
  startUpgrade: '一键升级',
  statusToolTitle: '读取固件升级状态',
  statusToolDescription:
    '读取当前已选固件、设备连接和升级进度，不改变设备状态。',
  deviceConnecting: '正在握手',
  deviceConnected: '已连接',
  deviceDisconnected: '未连接',
  cancelToolTitle: '取消固件升级',
  cancelToolDescription: '仅在升级正在进行时向设备发送取消帧，并停止当前升级。',
  noActiveUpgrade: '当前没有正在进行的固件升级',
  stages: {
    idle: '等待固件',
    ready: '准备就绪',
    connecting: '连接设备',
    preparing: '进入升级模式',
    writing: '传输固件',
    verifying: '确认接收完成',
    success: '升级完成',
    error: '升级失败',
  } satisfies Record<Stage, string>,
};

function formatBytes(value: number) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(2)} KiB`;
}

function formatHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

export default function Home() {
  return (
    <DeviceConnectionProvider>
      <Workspace />
    </DeviceConnectionProvider>
  );
}

function Workspace() {
  const view = useSyncExternalStore(
    subscribeWorkspaceView,
    getWorkspaceView,
    getServerWorkspaceView,
  );
  const { serialSupported, connectionBusy, connected, withUpgrade } =
    useDeviceConnection();
  const [running, setRunning] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const runningRef = useRef(false);
  const fileLoadRef = useRef(0);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [logs, setLogs] = useState<string[]>([
    '升级器已就绪 · 等待选择 .bin 固件',
  ]);
  const [logsExpanded, setLogsExpanded] = useState(false);
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
  const busy = running;
  const validationError = firmware ? validateFirmware(firmware.data) : null;
  const displayedError = error || validationError;
  const showTransferProgress =
    ['writing', 'verifying'].includes(stage) ||
    (stage === 'error' && progress > 0);
  const showDiagnostics =
    stage === 'error' && logs.some((entry) => entry.startsWith('!'));

  function log(message: string, tone: 'info' | 'success' | 'error' = 'info') {
    const prefix = tone === 'success' ? '✓' : tone === 'error' ? '!' : '›';
    setLogs((current) => [...current.slice(-6), `${prefix} ${message}`]);
  }

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
      setLogsExpanded(false);
      setLogs([
        `✓ 已加载 ${file.name}`,
        `› 大小 ${formatBytes(data.length)} · CRC32 ${formatHex(info.crc)}`,
      ]);
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
    setLogsExpanded(false);
    setStage('connecting');
    runningRef.current = true;
    setRunning(true);
    try {
      await withUpgrade(async (port) => {
        const session = new IapSerialSession(port, log);
        sessionRef.current = session;
        try {
          await session.open();
          log('设备已连接，正在准备升级');
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
        log(message, 'error');
        setStage('error');
      } else {
        setStage('ready');
        log('升级已取消');
      }
    } finally {
      sessionRef.current = null;
      runningRef.current = false;
      setRunning(false);
    }
  }

  function changeView(nextView: WorkspaceView) {
    if (!runningRef.current) setWorkspaceView(nextView);
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

  return (
    <main className="updater-shell">
      <header className="topbar">
        <svg
          className="brand-wordmark"
          viewBox="0 0 232 64"
          role="img"
          aria-label="Jack"
        >
          <title>Jack</title>
          <g
            transform="translate(8 0) skewX(-8)"
            fill="none"
            stroke="currentColor"
            strokeWidth="7"
            strokeLinejoin="miter"
          >
            <path d="M22 15H40V42L32 50H18L10 42V36" />
            <path d="M58 50L76 15H83L101 50M66 36H93" />
            <path d="M151 15H126L117 24V41L126 50H151" />
            <path d="M169 15V50M178 33L200 50" />
          </g>
          <path
            fill="currentColor"
            d="M178 37C190 18 209 8 230 4C209 5 189 13 175 28Z"
          />
        </svg>
        <div className="topbar-controls">
          <nav className="workspace-nav" aria-label={t.navigation}>
            <button
              type="button"
              aria-pressed={view === 'battery'}
              disabled={running || connectionBusy}
              onClick={() => changeView('battery')}
            >
              {t.battery}
            </button>
            <button
              type="button"
              aria-pressed={view === 'upgrade'}
              disabled={running || connectionBusy}
              onClick={() => changeView('upgrade')}
            >
              {t.upgrade}
            </button>
            <button
              type="button"
              aria-pressed={view === 'ntc'}
              disabled={running || connectionBusy}
              onClick={() => changeView('ntc')}
            >
              {t.ntc}
            </button>
          </nav>
        </div>
      </header>
      {(view === 'battery' || view === 'ntc') && (
        <DeviceConnectionBar kind={view} />
      )}
      <div hidden={view !== 'battery'}>
        <BatteryMonitor />
      </div>
      <div className="ntc-workspace" hidden={view !== 'ntc'}>
        <NtcSimulator />
      </div>
      {view === 'upgrade' && (
        <section className="updater-content" aria-label={t.upgrade}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            disabled={busy || loadingFile}
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
            disabled={busy || loadingFile}
            aria-label={
              firmware
                ? `${t.replaceFirmware}: ${firmware.file.name}`
                : t.chooseFirmware
            }
            title={firmware?.file.name}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy && !loadingFile) setDragging(true);
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
              {(!firmware || !busy) && (
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
          {(busy || showTransferProgress || stage === 'success') && (
            <div className="transfer-status" data-state={stage}>
              <output className="sr-only" aria-live="polite">
                {t.stages[stage]}
              </output>
              <progress
                className="transfer-progress"
                value={showTransferProgress || stage === 'success' ? progress : undefined}
                max={100}
                aria-label={t.transferProgress}
              />
            </div>
          )}
          {displayedError && (
            <div className="error-message" role="alert">
              <CircleAlert aria-hidden="true" />
              <p>{displayedError}</p>
            </div>
          )}
          {serialSupported === false && (
            <p className="browser-note">{t.browserNote}</p>
          )}
          {showDiagnostics && (
            <div className="diagnostics">
              <button
                type="button"
                className="detail-toggle"
                aria-expanded={logsExpanded}
                aria-controls="upgrade-logs"
                onClick={() => setLogsExpanded((current) => !current)}
              >
                {logsExpanded ? t.hideDetails : t.showDetails}
              </button>
              {logsExpanded && (
                <div id="upgrade-logs" className="upgrade-logs">
                  {logs.map((entry, index) => (
                    <p key={`${entry}-${index}`}>{entry}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          {firmware && !busy && stage !== 'success' && (
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
                {t.startUpgrade}
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
