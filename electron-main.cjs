const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let serverProcess;
const SERVER_PORT = process.env.PORT || 3000;

function startServer() {
  const serverPath = path.join(__dirname, '.output', 'server', 'index.mjs');
  serverProcess = spawn(process.execPath, [serverPath], {
    env: Object.assign({}, process.env, { PORT: String(SERVER_PORT) }),
    stdio: 'inherit',
  });

  serverProcess.on('close', (code) => {
    console.log('Nuxt server exited with code', code);
  });
}

function waitForServer(url, timeout = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', (err) => {
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(check, 200);
      });
    })();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  const url = `http://localhost:${SERVER_PORT}`;
  waitForServer(url).then(() => {
    win.loadURL(url);
  }).catch((err) => {
    console.error('Server did not start in time:', err);
    // still try to load
    win.loadURL(url);
  });
}

app.whenReady().then(() => {
  // Start Nuxt server (production build .output)
  startServer();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
