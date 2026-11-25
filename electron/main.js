// PostVane desktop shell: runs the dashboard server inside the app, shows it in a window and keeps it in the tray.
import { app, BrowserWindow, Tray, Menu, shell, nativeImage, powerSaveBlocker, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

if (!app.requestSingleInstanceLock()) app.quit();

// Data (database, uploads, logs) lives in the per-user app data folder, not next to the program.
process.env.POSTVANE_HOME = app.getPath('userData');

let win = null;
let tray = null;
let quitting = false;
let url = '';

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'PostVane', backgroundColor: '#1B1A55', autoHideMenuBar: true,
    icon: path.join(root, 'build', 'icon.png'),
  });
  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  // Closing the window keeps PostVane running in the tray so scheduled posts still go out.
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(root, 'build', 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('PostVane');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PostVane', click: showWindow },
    { label: 'Open at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

async function startServer() {
  const { createApp, startWorker, workerPid } = await import('../src/server.js');
  const { paths, PORT, HOST } = await import('../src/config.js');
  const { openDb, getSettings } = await import('../src/db.js');
  const p = paths();
  const db = openDb(p.db);
  await new Promise((resolve, reject) => {
    const server = createApp(db, p).listen(PORT, HOST, resolve);
    server.on('error', reject);
  });
  url = `http://${HOST}:${PORT}`;
  // Start the worker again if it was running when the app was last closed.
  if (getSettings(db).worker_autostart === '1' && !workerPid(p.lock)) startWorker(p);
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('PostVane could not start', e.code === 'EADDRINUSE'
      ? 'Port 4317 is already in use. Close the other PostVane or program using it and try again.'
      : String(e?.message || e));
    app.exit(1);
    return;
  }
  powerSaveBlocker.start('prevent-app-suspension');
  createTray();
  createWindow();
});
