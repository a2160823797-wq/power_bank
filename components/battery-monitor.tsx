'use client';

import { CircleAlert, Loader2 } from 'lucide-react';
import { useDeviceConnection } from '@/lib/device-connection-context';

const text = {
  monitoring: '电池监测',
  serialConnection: '串口连接',
  lastReport: '最近上报：',
  connecting: '正在连接',
  disconnecting: '正在断开',
  retryDisconnect: '重试断开',
  disconnect: '断开连接',
  connect: '连接设备',
  select: '选择设备',
  unsupported: '当前浏览器不支持串口连接，请使用桌面版 Chrome 或 Edge。',
  liveMetrics: '电池实时参数',
  totalVoltage: '电池总电压',
  temperature: '电池温度',
  cellVoltages: '各串电压',
  cellCount: (count: number) => `${count} 串电池`,
  cell: (index: number) => `第 ${index} 串`,
  cellInfo: '电芯信息',
  model: '型号',
  code: '编码',
  history: '异常记录',
  noRecords: '无异常记录',
  historyRecords: '电池异常记录',
  overvoltage: '过充电压',
  overtemperature: '高温',
  recordValue: '记录数值',
  occurrenceTime: '发生时间',
  noData: '暂无数据',
  receiving: (count: number, total: number | null) =>
    total === null
      ? `已收到 ${count} 条，等待设备返回完整记录。`
      : `已收到 ${count} 条，共 ${total} 条，等待传输完成。`,
  incomplete: (count: number, total: number | null) =>
    total === null
      ? `已收到 ${count} 条。请重新连接设备以读取完整记录。`
      : `已收到 ${count} 条，预期 ${total} 条。请重新连接设备以读取完整记录。`,
  emptyHistory: '本次读取已完成，设备报告的记录数为 0。',
};

const beijingReportTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const beijingHistoryTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(seconds: number) {
  return beijingHistoryTime.format(seconds * 1000);
}

function formatVoltage(millivolts: number | null) {
  return millivolts === null ? <EmptyValue /> : (millivolts / 1000).toFixed(3);
}

function EmptyValue() {
  return (
    <span className="battery-empty-value" role="img" aria-label={text.noData}>
      —
    </span>
  );
}

export default function BatteryMonitor() {
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
  const visibleCellCount = battery.cellCount ?? 0;
  const historyDescription = {
    unread: '',
    receiving: text.receiving(battery.records.length, battery.historyExpected),
    incomplete: text.incomplete(
      battery.records.length,
      battery.historyExpected,
    ),
    complete: battery.records.length === 0 ? text.emptyHistory : '',
  }[battery.historyStatus];

  return (
    <section
      className={`battery-content${connected ? '' : ' battery-empty'}`}
      aria-label={text.monitoring}
    >
      <section
        className="battery-connection"
        aria-label={text.serialConnection}
      >
        {connected && (
          <div className="battery-data-status" aria-live="polite">
            <span>
              {text.lastReport}
              {battery.lastReceivedAt === null ? (
                <EmptyValue />
              ) : (
                beijingReportTime.format(battery.lastReceivedAt)
              )}
            </span>
          </div>
        )}
        <div className="battery-actions">
          <button
            className={`battery-button ${connected || connection === 'release-error' ? 'battery-button-secondary' : 'battery-button-primary'}`}
            type="button"
            disabled={connectionBusy || !serialSupported}
            onClick={() => {
              if (connected || connection === 'release-error')
                void disconnect().catch(() => undefined);
              else void connect('battery');
            }}
          >
            {connectionBusy && <Loader2 className="battery-spin" />}
            {connection === 'connecting'
              ? text.connecting
              : connection === 'disconnecting'
                ? text.disconnecting
                : connection === 'release-error'
                  ? text.retryDisconnect
                  : connected
                    ? text.disconnect
                    : selectionRequired
                      ? text.select
                      : text.connect}
          </button>
        </div>
      </section>

      {serialSupported === false && (
        <p className="battery-message" role="alert">
          <CircleAlert />
          {text.unsupported}
        </p>
      )}
      {error && (
        <p className="battery-message battery-message-error" role="alert">
          <CircleAlert />
          {error}
        </p>
      )}

      {connected && (
        <>
          <section className="battery-metrics" aria-label={text.liveMetrics}>
            <div className="battery-metric">
              <p className="battery-field-label">{text.totalVoltage}</p>
              <p className="battery-metric-value">
                {formatVoltage(battery.totalVoltageMv)}
                <span>V</span>
              </p>
            </div>
            <div className="battery-metric">
              <p className="battery-field-label">{text.temperature}</p>
              <p className="battery-metric-value">
                {battery.temperatureC === null ? (
                  <EmptyValue />
                ) : (
                  battery.temperatureC.toFixed(0)
                )}
                <span>°C</span>
              </p>
            </div>
          </section>

          <div className="battery-details-grid">
            {visibleCellCount > 1 && (
              <section
                className="battery-panel"
                aria-labelledby="battery-cells-title"
              >
                <div className="battery-panel-heading">
                  <h2 id="battery-cells-title">{text.cellVoltages}</h2>
                  <span className="battery-section-note">
                    {text.cellCount(visibleCellCount)}
                  </span>
                </div>
                <div className="battery-cell-grid">
                  {Array.from({ length: visibleCellCount }, (_, index) => (
                    <div className="battery-cell" key={index}>
                      <span>{text.cell(index + 1)}</span>
                      <strong>
                        {formatVoltage(battery.cellVoltagesMv[index] ?? null)}{' '}
                        <small>V</small>
                      </strong>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section
              className="battery-panel"
              aria-labelledby="battery-identity-title"
            >
              <div className="battery-panel-heading">
                <h2 id="battery-identity-title">{text.cellInfo}</h2>
              </div>
              <dl className="battery-identity">
                <div>
                  <dt>{text.model}</dt>
                  <dd>{battery.batteryModel || <EmptyValue />}</dd>
                </div>
                <div>
                  <dt>{text.code}</dt>
                  <dd>{battery.batteryCode || <EmptyValue />}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section
            className="battery-panel battery-history"
            aria-labelledby="battery-history-title"
          >
            <div className="battery-panel-heading">
              <h2 id="battery-history-title">{text.history}</h2>
            </div>
            {battery.records.length === 0 ? (
              <div className="battery-history-empty" aria-live="polite">
                {battery.historyStatus === 'complete' ? (
                  <h3>{text.noRecords}</h3>
                ) : (
                  <EmptyValue />
                )}
              </div>
            ) : (
              <>
                {historyDescription && (
                  <p className="battery-history-description" aria-live="polite">
                    {historyDescription}
                  </p>
                )}
                <ul
                  className="battery-records"
                  aria-label={text.historyRecords}
                >
                  {battery.records.map((record, index) => (
                    <li key={index}>
                      <div className="battery-record-heading">
                        <h3>
                          {record.type === 'overvoltage'
                            ? text.overvoltage
                            : text.overtemperature}
                        </h3>
                      </div>
                      <p
                        className="battery-record-value"
                        aria-label={text.recordValue}
                      >
                        <span className="battery-record-number">
                          {record.type === 'overvoltage'
                            ? (record.value / 1000).toFixed(3)
                            : record.value.toFixed(0)}
                        </span>
                        <span className="battery-record-unit">
                          <span className="battery-record-degree">
                            {record.type === 'overvoltage' ? '' : '°'}
                          </span>
                          <span className="battery-record-symbol">
                            {record.type === 'overvoltage' ? 'V' : 'C'}
                          </span>
                        </span>
                      </p>
                      <p
                        className="battery-record-time"
                        aria-label={text.occurrenceTime}
                      >
                        {formatTime(record.timeUnixSeconds)}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
