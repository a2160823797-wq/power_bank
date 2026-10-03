'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowRight,
  ArrowUpToLine,
  Check,
  CircleAlert,
  Loader2,
} from 'lucide-react';
import {
  crc32,
  IapSerialSession,
  type SerialApi,
  validateFirmware,
} from '@/lib/iap-protocol';
import { DEFAULT_CONFIG } from '@/lib/iap-config';
import BatteryMonitor, {
  type BatteryMonitorHandle,
} from '@/components/battery-monitor';

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

const stageLabel: Record<Stage, string> = {
  idle: '等待固件',
  ready: '准备就绪',
  connecting: '连接设备',
  preparing: '进入升级模式',
  writing: '传输固件',
  verifying: '确认接收完成',
  success: '升级完成',
  error: '升级失败',
};

function formatBytes(value: number) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(2)} KiB`;
}

function formatHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

const subscribeSerialSupport = () => () => {};
const getSerialSupport = () => 'serial' in navigator;
const getServerSerialSupport = () => null;

export default function Home() {
  const [view, setView] = useState<'battery' | 'upgrade'>('battery');
  const [switchingView, setSwitchingView] = useState(false);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const monitorBusyRef = useRef(false);
  const switchingViewRef = useRef(false);
  const monitorRef = useRef<BatteryMonitorHandle>(null);
  const autoConnectMonitorRef = useRef(true);
  const [running, setRunning] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const runningRef = useRef(false);
  const fileLoadRef = useRef(0);
  const [firmware, setFirmware] = useState<FirmwareInfo | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const serialSupported = useSyncExternalStore<boolean | null>(
    subscribeSerialSupport,
    getSerialSupport,
    getServerSerialSupport,
  );
  const [logs, setLogs] = useState<string[]>([
    '升级器已就绪 · 等待选择 .bin 固件',
  ]);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const sessionRef = useRef<IapSerialSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef({ stage, progress, firmware });
  useEffect(() => {
    statusRef.current = { stage, progress, firmware };
  }, [stage, progress, firmware]);
  const busy = running;
  const validationError = firmware
    ? validateFirmware(firmware.data, DEFAULT_CONFIG)
    : null;
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
    if (!firmware || runningRef.current || loadingFile) return;
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
    let session: IapSerialSession | null = null;
    try {
      const serial = (navigator as Navigator & { serial: SerialApi }).serial;
      const port = await serial.requestPort();
      session = new IapSerialSession(port, log, DEFAULT_CONFIG);
      sessionRef.current = session;
      await session.open();
      log('串口已连接，正在准备升级');
      await session.upgrade(
        firmware.file.name,
        firmware.data,
        (percent) => {
          setProgress(percent);
        },
        (nextStage) => {
          setStage(nextStage === 'handshake' ? 'preparing' : nextStage);
        },
      );
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
      await session?.close();
      sessionRef.current = null;
      runningRef.current = false;
      setRunning(false);
    }
  }

  async function cancelUpgrade() {
    await sessionRef.current?.cancel();
  }

  async function changeView(nextView: 'battery' | 'upgrade') {
    if (
      view === nextView ||
      runningRef.current ||
      monitorBusyRef.current ||
      switchingViewRef.current
    )
      return;
    switchingViewRef.current = true;
    setSwitchingView(true);
    try {
      await monitorRef.current?.disconnect();
      autoConnectMonitorRef.current = false;
      setView(nextView);
    } catch {
      // 监测页保留断开失败提示，串口释放后再切换
    } finally {
      switchingViewRef.current = false;
      setSwitchingView(false);
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
      title: '读取固件升级状态',
      description: '读取当前已选固件、设备连接和升级进度，不改变设备状态。',
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
              ? '正在握手'
              : ['preparing', 'writing', 'verifying'].includes(current.stage)
                ? '已连接'
                : '未连接',
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
      title: '取消固件升级',
      description: '仅在升级正在进行时向设备发送取消帧，并停止当前升级。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute() {
        if (!sessionRef.current) throw new Error('当前没有正在进行的固件升级');
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
        <nav className="workspace-nav" aria-label="功能导航">
          <button
            type="button"
            aria-pressed={view === 'battery'}
            disabled={running || monitorBusy || switchingView}
            onClick={() => void changeView('battery')}
          >
            电池监测
          </button>
          <button
            type="button"
            aria-pressed={view === 'upgrade'}
            disabled={running || monitorBusy || switchingView}
            onClick={() => void changeView('upgrade')}
          >
            固件升级
          </button>
        </nav>
      </header>
      {view === 'battery' && (
        <BatteryMonitor
          ref={monitorRef}
          serialSupported={serialSupported}
          autoConnect={autoConnectMonitorRef.current}
          onConnectionBusyChange={(value) => {
            monitorBusyRef.current = value;
            setMonitorBusy(value);
          }}
        />
      )}
      {view === 'upgrade' && (
        <section className="updater-content" aria-label="固件升级">
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,application/octet-stream"
            disabled={busy || loadingFile}
            className="sr-only"
            tabIndex={-1}
            aria-label="选择固件"
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
              firmware ? `更换固件：${firmware.file.name}` : '选择固件'
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
                  ? '正在读取固件…'
                  : firmware
                    ? firmware.file.name
                    : '选择固件'}
              </span>
              <span className="file-description">
                {loadingFile
                  ? '请稍候'
                  : firmware
                    ? `${formatBytes(firmware.data.length)}${busy ? '' : ' · 点击更换'}`
                    : '也可将 .bin 文件拖到这里'}
              </span>
            </span>
          </button>
          {(busy || showTransferProgress || stage === 'success') && (
            <div className="transfer-status" data-state={stage}>
              <div className="status-heading">
                <output className="status-label" aria-live="polite">
                  {stage === 'success' ? (
                    <Check aria-hidden="true" />
                  ) : stage === 'error' ? (
                    <CircleAlert aria-hidden="true" />
                  ) : (
                    <Loader2 className="icon-spinner" aria-hidden="true" />
                  )}
                  {stageLabel[stage]}
                </output>
                {(showTransferProgress || stage === 'success') && (
                  <span className="status-percent">{progress}%</span>
                )}
              </div>
              {(showTransferProgress || stage === 'success') && (
                <progress
                  className="transfer-progress"
                  value={progress}
                  max={100}
                  aria-label="固件传输进度"
                />
              )}
              <p className="status-description">
                {stage === 'success'
                  ? '设备已确认接收完成。'
                  : stage === 'connecting'
                    ? '请在浏览器弹窗中选择你的设备。'
                    : stage === 'error'
                      ? '升级已停止，请查看下方提示。'
                      : '请保持设备连接，等待升级完成。'}
              </p>
            </div>
          )}
          {displayedError && (
            <div className="error-message" role="alert">
              <CircleAlert aria-hidden="true" />
              <p>{displayedError}</p>
            </div>
          )}
          {serialSupported === false && (
            <p className="browser-note">
              请使用电脑上的 Chrome 或 Edge 连接设备。
            </p>
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
                {logsExpanded ? '收起详情' : '查看详情'}
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
          {firmware && (
            <div className="actions">
              {stage === 'success' && !busy ? (
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => {
                    setStage('ready');
                    setProgress(0);
                    setError('');
                  }}
                >
                  下一次升级 <ArrowRight aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-action"
                  disabled={
                    busy ||
                    loadingFile ||
                    !serialSupported ||
                    Boolean(validationError)
                  }
                  onClick={startUpgrade}
                >
                  {busy ? '正在升级…' : '一键升级'}
                  {!busy && <ArrowUpToLine aria-hidden="true" />}
                </button>
              )}
              {busy && stage !== 'connecting' && (
                <button
                  type="button"
                  className="secondary-action"
                  onClick={cancelUpgrade}
                >
                  取消升级
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
