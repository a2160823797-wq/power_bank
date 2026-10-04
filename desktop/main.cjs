const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
} = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.setName('PowerBank');
app.setAppUserModelId('com.jack.powerbank');

let mainWindow = null;
let serialPicker = null;
let mainPageUrl = '';

function isPageUrl(value, expectedUrl) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href === expectedUrl;
  } catch {
    return false;
  }
}

function isMainPage(webContents) {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    webContents === mainWindow.webContents &&
    isPageUrl(webContents.getURL(), mainPageUrl),
  );
}

function restrictNavigation(window, pageUrl) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isPageUrl(event.url, pageUrl))
      event.preventDefault();
  });
  window.webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame || !isPageUrl(event.url, pageUrl))
      event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
}

function pickerPorts() {
  return Array.from(serialPicker.ports.values(), (port) => ({
    portId: port.portId,
    portName: port.portName,
    displayName: port.displayName ?? '',
  })).sort((a, b) =>
    a.portName.localeCompare(b.portName, 'zh-CN', { numeric: true }),
  );
}

function isPickerSender(event) {
  return (
    serialPicker &&
    !serialPicker.window.isDestroyed() &&
    event.sender === serialPicker.window.webContents &&
    event.senderFrame === serialPicker.window.webContents.mainFrame &&
    isPageUrl(event.senderFrame.url, serialPicker.pageUrl)
  );
}

function sendPickerPorts() {
  if (serialPicker && !serialPicker.window.isDestroyed()) {
    serialPicker.window.webContents.send(
      'powerbank:serial-ports',
      pickerPorts(),
    );
  }
}

function selectSerialPort(portList, requestContents, callback) {
  serialPicker?.finish('');
  const requestSession = requestContents.session;
  const pickerFile = path.join(__dirname, 'serial-picker.html');
  const pickerWindow = new BrowserWindow({
    parent: mainWindow,
    modal: true,
    width: 500,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '选择串口',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0e1117',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'serial-preload.cjs'),
      partition: 'powerbank-picker',
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  const picker = {
    window: pickerWindow,
    pageUrl: pathToFileURL(pickerFile).href,
    ports: new Map(portList.map((port) => [port.portId, port])),
    finish(portId) {
      if (serialPicker !== picker) return;
      serialPicker = null;
      requestSession.removeListener('serial-port-added', onPortAdded);
      requestSession.removeListener('serial-port-removed', onPortRemoved);
      requestContents.removeListener('destroyed', onRequestDestroyed);
      requestContents.removeListener('render-process-gone', onRequestDestroyed);
      requestContents.removeListener(
        'did-start-navigation',
        onRequestNavigation,
      );
      try {
        callback(portId);
      } finally {
        if (!pickerWindow.isDestroyed()) pickerWindow.destroy();
      }
    },
  };
  function onPortAdded(_event, port, webContents) {
    if (webContents !== requestContents) return;
    picker.ports.set(port.portId, port);
    sendPickerPorts();
  }
  function onPortRemoved(_event, port, webContents) {
    if (webContents !== requestContents) return;
    picker.ports.delete(port.portId);
    sendPickerPorts();
  }
  function onRequestDestroyed() {
    picker.finish('');
  }
  function onRequestNavigation(event) {
    if (event.isMainFrame && !event.isSameDocument) picker.finish('');
  }
  serialPicker = picker;
  requestSession.on('serial-port-added', onPortAdded);
  requestSession.on('serial-port-removed', onPortRemoved);
  requestContents.on('destroyed', onRequestDestroyed);
  requestContents.on('render-process-gone', onRequestDestroyed);
  requestContents.on('did-start-navigation', onRequestNavigation);
  restrictNavigation(pickerWindow, picker.pageUrl);
  pickerWindow.once('ready-to-show', () => pickerWindow.show());
  pickerWindow.on('closed', () => picker.finish(''));
  pickerWindow.webContents.on('render-process-gone', () => picker.finish(''));
  pickerWindow.loadFile(pickerFile).catch(() => picker.finish(''));
}

function configureSerialPermissions(appSession) {
  const allowSerial = (webContents, permission, details) =>
    permission === 'serial' &&
    isMainPage(webContents) &&
    details.isMainFrame &&
    isPageUrl(details.requestingUrl, mainPageUrl);
  appSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      allowSerial(webContents, permission, details),
  );
  appSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) =>
      callback(Boolean(allowSerial(webContents, permission, details))),
  );
  appSession.on(
    'select-serial-port',
    (event, portList, webContents, callback) => {
      event.preventDefault();
      if (!isMainPage(webContents)) {
        callback('');
        return;
      }
      selectSerialPort(portList, webContents, callback);
    },
  );
}

function createWindow() {
  const pageFile = path.join(app.getAppPath(), 'PowerBank.html');
  mainPageUrl = pathToFileURL(pageFile).href;
  const appSession = session.fromPartition('persist:powerbank');
  configureSerialPermissions(appSession);
  const pickerSession = session.fromPartition('powerbank-picker');
  pickerSession.setPermissionCheckHandler(() => false);
  pickerSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  pickerSession.setDevicePermissionHandler(() => false);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    title: 'PowerBank',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0e1117',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: appSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  restrictNavigation(mainWindow, mainPageUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    serialPicker?.finish('');
    mainWindow = null;
  });
  mainWindow.loadFile(pageFile).catch((error) => {
    dialog.showErrorBox('PowerBank 启动失败', error.message);
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    serialPicker?.window.focus();
  });
  ipcMain.on('powerbank:serial-ready', (event) => {
    if (isPickerSender(event)) sendPickerPorts();
  });
  ipcMain.on('powerbank:serial-select', (event, portId) => {
    if (
      isPickerSender(event) &&
      typeof portId === 'string' &&
      serialPicker.ports.has(portId)
    ) {
      serialPicker.finish(portId);
    }
  });
  ipcMain.on('powerbank:serial-cancel', (event) => {
    if (isPickerSender(event)) serialPicker.finish('');
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    createWindow();
  });
  app.on('before-quit', () => serialPicker?.finish(''));
  app.on('window-all-closed', () => app.quit());
}
