import { useEffect, useState } from 'react';
import { useDeviceConnection } from '@/lib/device-connection-context';

const DEFAULT_BATTERY_MODEL = '146074MN100';
const DEFAULT_BATTERY_CODE = 'MLSHCEG6G-010623900';

function getCellInfoValue(value: string | null, defaultValue: string) {
  return !value || value === '-' || value === 'UNSET' ? defaultValue : value;
}

export default function CellSettings() {
  const { connected, connectionBusy, battery, setCellInfo } = useDeviceConnection();
  const [model, setModel] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const writing = progress !== null && progress < 100;
  const cur_model = model ?? getCellInfoValue(battery.batteryModel, DEFAULT_BATTERY_MODEL);
  const cur_code = code ?? getCellInfoValue(battery.batteryCode, DEFAULT_BATTERY_CODE);

  useEffect(() => {
    if (!connected) {
      setProgress(null);
      setMessage('');
    }
  }, [connected]);

  async function save() {
    const modelValue = cur_model.trim().toUpperCase();
    const codeValue = cur_code.trim().toUpperCase();
    setModel(modelValue);
    setCode(codeValue);
    setMessage('');
    setProgress(null);
    if (![modelValue, codeValue].every((value) => /^[A-Z0-9-]{1,24}$/.test(value))) {
      setMessage('型号和编码仅允许 A-Z、0-9、-，每项长度为 1～24 个字符');
      return;
    }
    setProgress(0);
    try {
      await setCellInfo(0, modelValue);
      setProgress(50);
      await setCellInfo(1, codeValue);
      setProgress(100);
    } catch (error) {
      setProgress(null);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="battery-content cell-settings-content" aria-label="电芯设置">
      <section className="battery-panel">
        <div className="cell-settings-fields">
          <div>
            <label className="battery-field-label" htmlFor="cell-model">型号</label>
            <input id="cell-model" value={cur_model} disabled={!connected || connectionBusy || writing} maxLength={24} onChange={(event) => {
              setModel(event.currentTarget.value);
              setProgress(null);
              setMessage('');
            }} />
          </div>
          <div>
            <label className="battery-field-label" htmlFor="cell-code">编码</label>
            <input id="cell-code" value={cur_code} disabled={!connected || connectionBusy || writing} maxLength={24} onChange={(event) => {
              setCode(event.currentTarget.value);
              setProgress(null);
              setMessage('');
            }} />
            {connected && <button className="primary-action" aria-label="写入型号和编码" type="button" disabled={connectionBusy || writing || !cur_model.trim() || !cur_code.trim()} onClick={() => void save()}>写入</button>}
          </div>
        </div>
        {progress !== null && (
          <div className="transfer-status" data-state={progress === 100 ? 'success' : 'writing'}>
            <div className="transfer-progress">
              <progress max={100} value={progress} aria-label="型号和编码写入进度" />
              <span className="transfer-percent" aria-hidden="true">{progress}%</span>
            </div>
          </div>
        )}
        {message && <p className="cell-settings-description" role="alert">{message}</p>}
      </section>
    </section>
  );
}
