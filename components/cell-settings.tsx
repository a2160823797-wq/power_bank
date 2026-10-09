import { useState } from 'react';
import { useDeviceConnection } from '@/lib/device-connection-context';

export default function CellSettings() {
  const { connected, connectionBusy, battery, setCellInfo } = useDeviceConnection();
  const [model, setModel] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const cur_model = model ?? (battery.batteryModel === '-' ? '' : battery.batteryModel ?? '');
  const cur_code = code ?? (battery.batteryCode === '-' ? '' : battery.batteryCode ?? '');

  async function save() {
    const modelValue = cur_model.trim().toUpperCase();
    const codeValue = cur_code.trim().toUpperCase();
    setModel(modelValue);
    setCode(codeValue);
    if (![modelValue, codeValue].every((value) => /^[A-Z0-9-]{1,24}$/.test(value))) {
      setMessage('型号和编码仅允许 A-Z、0-9、-，每项长度为 1～24 个字符');
      return;
    }
    setMessage('正在写入设备…');
    try {
      await setCellInfo(0, modelValue);
      setMessage('型号已保存，正在写入编码…');
      await setCellInfo(1, codeValue);
      setMessage('型号和编码已保存并回读确认');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="battery-content cell-settings-content" aria-label="电芯设置">
      <section className="battery-panel">
        <div className="cell-settings-fields">
          <div>
            <input aria-label="型号" value={cur_model} disabled={connectionBusy} maxLength={24} onChange={(event) => setModel(event.currentTarget.value)} placeholder="型号" />
          </div>
          <div>
            <input aria-label="编码" value={cur_code} disabled={connectionBusy} maxLength={24} onChange={(event) => setCode(event.currentTarget.value)} placeholder="编码" />
            <button className="primary-action" aria-label="写入型号和编码" type="button" disabled={!connected || connectionBusy || !cur_model.trim() || !cur_code.trim()} onClick={() => void save()}>写入</button>
          </div>
        </div>
        {message && <p className="cell-settings-description" role="status">{message}</p>}
      </section>
    </section>
  );
}
