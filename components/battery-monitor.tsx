import { selectSafetyRecords, type SafetyRecord } from '@/lib/battery-protocol';
import { useDeviceConnection } from '@/lib/device-connection-context';

const text = {
  monitoring: '电池监测',
  liveMetrics: '电池实时参数',
  totalVoltage: '电池总电压',
  temperature: '电池温度',
  cellVoltages: '各串电压',
  cell: (index: number) => `第 ${index} 串`,
  cellInfo: '电芯信息',
  model: '型号',
  code: '编码',
  history: '异常记录',
  noRecords: '无异常记录',
  historyRecords: '电池异常记录',
  overvoltage: (cell: string) => `第${cell}串过充`,
  chargeOvertemperature: '充电高温',
  dischargeOvertemperature: '放电高温',
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
};

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

function recordTypeLabel(type: SafetyRecord['type']) {
  if (type.startsWith('overvoltage-'))
    return text.overvoltage(type.slice('overvoltage-'.length));
  if (type === 'charge-overtemperature') return text.chargeOvertemperature;
  return text.dischargeOvertemperature;
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
  const { connected, battery } = useDeviceConnection();
  if (!connected) return null;

  const visibleCellCount = battery.cellCount ?? 2;
  const visibleRecords = selectSafetyRecords(battery.records);
  const historyDescription = {
    unread: '',
    receiving: text.receiving(battery.records.length, battery.historyExpected),
    incomplete: text.incomplete(
      battery.records.length,
      battery.historyExpected,
    ),
    complete: '',
  }[battery.historyStatus];

  return (
    <section className="battery-content" aria-label={text.monitoring}>
      <section
        className="battery-panel battery-overview"
        aria-label={text.liveMetrics}
      >
        <div className="battery-metrics">
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
        </div>

        {visibleCellCount > 1 && (
          <section className="battery-cells" aria-label={text.cellVoltages}>
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

        <dl className="battery-identity" aria-label={text.cellInfo}>
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

      <section
        className={`battery-panel battery-history${visibleRecords.length === 0 ? ' battery-history-compact' : ''}`}
        aria-labelledby="battery-history-title"
      >
        <div className="battery-panel-heading">
          <h2 id="battery-history-title">{text.history}</h2>
          {visibleRecords.length === 0 && (
            <p className="battery-history-status" aria-live="polite">
              {battery.historyStatus === 'complete' ? (
                text.noRecords
              ) : (
                <EmptyValue />
              )}
            </p>
          )}
        </div>
        {historyDescription && (
          <p className="battery-history-description" aria-live="polite">
            {historyDescription}
          </p>
        )}
        {visibleRecords.length > 0 && (
          <ol className="battery-records" aria-label={text.historyRecords}>
            {visibleRecords.map((record, index) => (
              <li key={index}>
                <span className="battery-record-index" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="battery-record-heading">
                  <h3>{recordTypeLabel(record.type)}</h3>
                </div>
                <p
                  className="battery-record-value"
                  aria-label={text.recordValue}
                >
                  <span className="battery-record-number">
                    {record.type.startsWith('overvoltage-')
                      ? (record.value / 1000).toFixed(3)
                      : record.value.toFixed(0)}
                  </span>
                  <span className="battery-record-unit">
                    <span className="battery-record-degree">
                      {record.type.startsWith('overvoltage-') ? '' : '°'}
                    </span>
                    <span className="battery-record-symbol">
                      {record.type.startsWith('overvoltage-') ? 'V' : 'C'}
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
          </ol>
        )}
      </section>
    </section>
  );
}
