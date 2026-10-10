import { useState } from 'react';
import BatteryMonitor from '@/components/battery-monitor';
import FirmwareUpdater from '@/components/firmware-updater';
import NtcSimulator from '@/components/ntc-simulator';
import CellSettings from '@/components/cell-settings';
import {
  getWorkspaceView,
  setWorkspaceView,
  type WorkspaceView,
} from '@/lib/workspace-view';
import DeviceConnectionBar, {
  DeviceConnectionButton,
} from '@/components/device-connection-bar';
import {
  DeviceConnectionProvider,
  useDeviceConnection,
} from '@/lib/device-connection-context';

const t = {
  navigation: '功能导航',
  battery: '新国标',
  temperature: '温度模拟',
  upgrade: '固件升级',
  cellSettings: '电芯设置',
};

export default function Home() {
  return (
    <DeviceConnectionProvider>
      <Workspace />
    </DeviceConnectionProvider>
  );
}

function Workspace() {
  const [view, setView] = useState(getWorkspaceView);
  const { connectionBusy, connected, deviceKind, disconnect } = useDeviceConnection();

  async function changeView(nextView: WorkspaceView) {
    if (connectionBusy) return;
    if (connected && nextView !== 'upgrade' && deviceKind !== (nextView === 'temperature' ? 'ntc' : 'battery')) {
      await disconnect();
    }
    setView(nextView);
    setWorkspaceView(nextView);
  }

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
              disabled={connectionBusy}
              onClick={() => void changeView('battery').catch(() => undefined)}
            >
              {t.battery}
            </button>
            <button
              type="button"
              aria-pressed={view === 'cell-settings'}
              disabled={connectionBusy}
              onClick={() => void changeView('cell-settings').catch(() => undefined)}
            >
              {t.cellSettings}
            </button>
            <button
              type="button"
              aria-pressed={view === 'temperature'}
              disabled={connectionBusy}
              onClick={() => void changeView('temperature').catch(() => undefined)}
            >
              {t.temperature}
            </button>
            <button
              type="button"
              aria-pressed={view === 'upgrade'}
              disabled={connectionBusy}
              onClick={() => void changeView('upgrade').catch(() => undefined)}
            >
              {t.upgrade}
            </button>
          </nav>
          <DeviceConnectionButton hidden={view === 'upgrade'} kind={view === 'temperature' ? 'ntc' : 'battery'} />
        </div>
      </header>
      {view !== 'upgrade' && <DeviceConnectionBar />}
      <div hidden={view !== 'battery'}>
        <BatteryMonitor />
      </div>
      <div hidden={view !== 'temperature'}>
        <section className="temperature-content" aria-label={t.temperature}>
          <NtcSimulator />
        </section>
      </div>
      <FirmwareUpdater active={view === 'upgrade'} />
      <div hidden={view !== 'cell-settings'}>
        <CellSettings />
      </div>
    </main>
  );
}
