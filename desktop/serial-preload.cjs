const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialPicker', {
  onPorts(callback) {
    const listener = (_event, ports) => callback(ports);
    ipcRenderer.on('powerbank:serial-ports', listener);
    ipcRenderer.send('powerbank:serial-ready');
    return () => ipcRenderer.removeListener('powerbank:serial-ports', listener);
  },
  select: (portId) => ipcRenderer.send('powerbank:serial-select', portId),
  cancel: () => ipcRenderer.send('powerbank:serial-cancel'),
});
