const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

const DEFAULT_PORT = '3217';
const APP_ID = 'com.bookmachine.os';
const APP_NAME = 'Book Machine OS';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

function appRoot() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function externalRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : __dirname;
}

function iconPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(appRoot(), 'build', 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico')
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return env;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return env;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
    return env;
  }, {});
}

function loadConfig() {
  const candidateFiles = [
    path.join(appRoot(), 'config', 'holdfast.env'),
    path.join(externalRoot(), 'config', 'holdfast.env')
  ];
  const config = candidateFiles.reduce((merged, file) => ({ ...merged, ...parseEnvFile(file) }), {});
  process.env.HOLDFAST_CONFIG_PATH = path.join(externalRoot(), 'config', 'holdfast.env');
  Object.entries(config).forEach(([key, value]) => {
    if (value && !process.env[key]) process.env[key] = value;
  });
  if (!process.env.PORT) process.env.PORT = DEFAULT_PORT;
  if (!process.env.HOLDFAST_LIBRARY && !process.env.REPO_PATH) {
    process.env.HOLDFAST_LIBRARY = path.join(app.getPath('userData'), 'library');
  }
  process.env.HOLDFAST_NO_OPEN = '1';
}

function startServer() {
  loadConfig();
  return require('./server');
}

function createWindow() {
  const port = process.env.PORT || DEFAULT_PORT;
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: '#f4f1ec',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.removeMenu();
  win.loadURL(`http://localhost:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  startServer();
  setTimeout(createWindow, 500);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
