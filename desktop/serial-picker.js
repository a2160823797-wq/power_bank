const portsElement = document.getElementById('ports');
const emptyElement = document.getElementById('empty');
const statusElement = document.getElementById('status');
const connectButton = document.getElementById('connect');
let selectedPortId = '';

const unsubscribe = window.serialPicker.onPorts((ports) => {
  if (!ports.some((port) => port.portId === selectedPortId))
    selectedPortId = '';
  portsElement.replaceChildren();
  for (const port of ports) {
    const label = document.createElement('label');
    label.className = 'port';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'serial-port';
    input.value = port.portId;
    input.checked = port.portId === selectedPortId;
    const info = document.createElement('span');
    info.className = 'port-info';
    const name = document.createElement('span');
    name.className = 'port-name';
    name.textContent = port.portName;
    info.append(name);
    if (port.displayName && port.displayName !== port.portName) {
      const description = document.createElement('span');
      description.className = 'port-description';
      description.textContent = port.displayName;
      info.append(description);
    }
    label.append(input, info);
    portsElement.append(label);
  }
  emptyElement.hidden = ports.length !== 0;
  connectButton.disabled = !selectedPortId;
  statusElement.textContent = selectedPortId
    ? `已选择 ${ports.find((port) => port.portId === selectedPortId).portName}`
    : ports.length
      ? `${ports.length} 个可用串口，等待选择`
      : '等待设备连接';
});

portsElement.addEventListener('change', (event) => {
  selectedPortId = event.target.value;
  connectButton.disabled = false;
  statusElement.textContent = `已选择 ${event.target.closest('label').querySelector('.port-name').textContent}`;
});

connectButton.addEventListener('click', () => {
  if (selectedPortId) window.serialPicker.select(selectedPortId);
});
document
  .getElementById('cancel')
  .addEventListener('click', () => window.serialPicker.cancel());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.serialPicker.cancel();
  if (
    event.key === 'Enter' &&
    selectedPortId &&
    event.target.tagName !== 'BUTTON'
  ) {
    window.serialPicker.select(selectedPortId);
  }
});
window.addEventListener('beforeunload', unsubscribe, { once: true });
