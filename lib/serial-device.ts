import type { SerialApi, SerialPortLike } from './iap-protocol';

export async function getSavedSerialPort(serial: SerialApi, key: string, ports?: SerialPortLike[]) {
  let saved;
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    saved = JSON.parse(value);
    if (!saved || typeof saved !== 'object') return null;
  } catch {
    return null;
  }
  const matches = (ports ?? await serial.getPorts()).filter((candidate) => {
    const info = candidate.getInfo();
    return (
      info.usbVendorId === saved.usbVendorId &&
      info.usbProductId === saved.usbProductId &&
      info.bluetoothServiceClassId === saved.bluetoothServiceClassId
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

export function rememberSerialPort(key: string, port: SerialPortLike) {
  try {
    localStorage.setItem(key, JSON.stringify(port.getInfo()));
  } catch {}
}
