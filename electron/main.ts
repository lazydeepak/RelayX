import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';
import { SqliteRelayDatabase } from '../src/relay/persistence/sqlite/SqliteDatabase.ts';
import { RelayEngine } from '../src/relay/application/RelayEngine.ts';
import { RelayApiService } from '../src/relay/application/RelayApiService.ts';
import {
  ChatGPTProvider,
  OpenCodeProvider,
  VSCodeProvider,
} from '../src/relay/providers/adapters.ts';
import { registerRelayIpcHandlers } from './ipc/registerHandlers.ts';

let mainWindow: BrowserWindow | null = null;
let sqliteDb: SqliteRelayDatabase | null = null;
let relayEngine: RelayEngine | null = null;
let relayService: RelayApiService | null = null;
let tray: Tray | null = null;

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const buffer = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const inIcon = (x >= 3 && x <= 12) && (y >= 3 && y <= 12);
      if (inIcon) {
        buffer[idx] = 255;
        buffer[idx + 1] = 255;
        buffer[idx + 2] = 255;
        buffer[idx + 3] = 240;
      }
    }
  }
  const img = nativeImage.createFromBuffer(buffer, { width: size, height: size });
  img.setTemplateImage(true);
  return img;
}

function setupTray(): void {
  try {
    const icon = createTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip('Relay — Control Plane Active');

    const updateMenu = async () => {
      let activeCount = 0;
      let workingWorkers = 0;
      if (sqliteDb) {
        try {
          const pairs = await sqliteDb.pairs.findAll();
          activeCount = pairs.filter((p) => p.status === 'active').length;
          const runtimes = await sqliteDb.runtimes.findAll();
          workingWorkers = runtimes.filter((r) => r.status === 'working').length;
        } catch {}
      }

      const contextMenu = Menu.buildFromTemplate([
        { label: 'Relay Control Plane', enabled: false },
        { label: `Active Pairs: ${activeCount} | Working: ${workingWorkers}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Show Relay Window',
          click: () => {
            if (mainWindow) {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            } else {
              createWindow();
            }
          },
        },
        {
          label: 'Run Supervision Tick Now',
          click: async () => {
            if (relayEngine) {
              try {
                const res = await relayEngine.runSupervisionTick();
                console.log('[Tray] Supervision tick executed:', res);
              } catch (err) {
                console.error('[Tray] Supervision tick error:', err);
              }
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Relay',
          click: () => {
            app.quit();
          },
        },
      ]);
      tray?.setContextMenu(contextMenu);
    };

    updateMenu();
    setInterval(updateMenu, 10000);
  } catch (err) {
    console.warn('[Tray] Could not initialize tray menu:', err);
  }
}

function initializeEngine(): RelayApiService {
  const userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });

  const dbPath = path.join(userDataPath, 'relay.sqlite');
  console.log(`[Relay Engine] Initializing durable SQLite database at: ${dbPath}`);

  sqliteDb = new SqliteRelayDatabase(dbPath);
  relayEngine = new RelayEngine(sqliteDb);

  // Register providers with explicit integration status
  const chatgpt = new ChatGPTProvider();
  const opencode = new OpenCodeProvider();
  const vscode = new VSCodeProvider();

  relayEngine.registerProvider(chatgpt);
  relayEngine.registerProvider(opencode);
  relayEngine.registerProvider(vscode);

  relayService = new RelayApiService(sqliteDb, relayEngine, {
    isElectron: true,
    databasePath: dbPath,
    databaseType: 'sqlite_wal',
    userDataPath,
  });

  registerRelayIpcHandlers(relayService);
  return relayService;
}

function createWindow(): void {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'Relay',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    backgroundColor: '#020617', // slate-950
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Handle external links safely in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Determine runtime mode explicitly
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (isDev && devServerUrl) {
    console.log(`[Relay Electron] Starting in DEVELOPMENT mode, connecting to Vite dev server: ${devServerUrl}`);
    mainWindow.loadURL(devServerUrl).catch((err) => {
      console.warn(`[Relay Electron] Initial loadURL failed (${err.message}). Retrying with hostname fallback in 1s...`);
      const fallbackUrl = devServerUrl.includes('localhost')
        ? devServerUrl.replace('localhost', '127.0.0.1')
        : devServerUrl.replace('127.0.0.1', 'localhost');
      setTimeout(() => {
        mainWindow?.loadURL(devServerUrl).catch(() => {
          mainWindow?.loadURL(fallbackUrl).catch((retryErr) => {
            console.error('[Relay Electron] Dev server connection failed:', retryErr);
          });
        });
      }, 1000);
    });
  } else {
    // Production or packaged desktop mode: load compiled dist/index.html directly from local disk
    const candidatePaths = [
      path.join(__dirname, '../dist/index.html'),
      path.join(app.getAppPath(), 'dist/index.html'),
      path.join(process.cwd(), 'dist/index.html'),
    ];
    const resolvedPath = candidatePaths.find((p) => fs.existsSync(p));

    if (resolvedPath) {
      console.log(`[Relay Electron] Starting in PRODUCTION mode, loading local assets from: ${resolvedPath}`);
      mainWindow.loadFile(resolvedPath);
    } else {
      console.error(
        `[Relay Electron] Fatal: Could not locate compiled dist/index.html in any candidate path:\n${candidatePaths.join('\n')}`,
      );
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ensure single instance lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    initializeEngine();

    // Phase 9: Recover state and reconcile active assignments across restarts
    if (relayEngine) {
      try {
        const report = await relayEngine.recoverOnStartup();
        console.log('[Relay Engine] Startup crash recovery complete:', report);
      } catch (err) {
        console.error('[Relay Engine] Startup recovery error:', err);
      }

      // Phase 8: Start continuous background supervision loop
      relayEngine.startSupervisionLoop(5000);
    }

    createWindow();
    setupTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    if (relayEngine) {
      relayEngine.stopSupervisionLoop();
    }
    if (tray) {
      try {
        tray.destroy();
      } catch {}
      tray = null;
    }
    if (sqliteDb && sqliteDb.db) {
      try {
        sqliteDb.db.close();
        console.log('[Relay Engine] SQLite database closed gracefully.');
      } catch (err) {
        console.error('[Relay Engine] Error closing SQLite database:', err);
      }
    }
  });
}
