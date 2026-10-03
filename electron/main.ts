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
import { HealthIncidentEngine } from '../src/relay/application/HealthIncidentEngine.ts';
import { HealthRuntimeCoordinator } from '../src/relay/application/HealthRuntimeCoordinator.ts';
import { HealthScheduler, withHealthDeliverySweep } from '../src/relay/application/HealthScheduler.ts';

let mainWindow: BrowserWindow | null = null;
let sqliteDb: SqliteRelayDatabase | null = null;
let relayEngine: RelayEngine | null = null;
let relayService: RelayApiService | null = null;
let tray: Tray | null = null;

/**
 * Phase 1 health monitoring lives in the ELECTRON MAIN PROCESS, never the
 * renderer. Detection must work with no window open, and the lag probe must
 * measure the main event loop — a renderer probe would measure a different loop
 * and could report a healthy main process as stalled.
 */
let healthCoordinator: HealthRuntimeCoordinator | null = null;
let healthScheduler: HealthScheduler | null = null;

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
    tray.setToolTip('RelayX — Control Plane Active');

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
        { label: 'RelayX Control Plane', enabled: false },
        { label: `Active Pairs: ${activeCount} | Working: ${workingWorkers}`, enabled: false },
        { type: 'separator' },
        {
          label: 'Show RelayX Window',
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
          label: 'Quit RelayX',
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
  console.log(`[RelayX Engine] Initializing durable SQLite database at: ${dbPath}`);

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
  initializeHealthMonitoring(sqliteDb);
  return relayService;
}

/**
 * Phase 1 health wiring. Read-only observation only: no repair, no retry, no
 * restart, and no health-specific mutation of any operational entity.
 *
 * Exactly one health timer exists in the whole application: the main-process
 * heartbeat. Time-based delivery checks ride RelayX's existing supervision loop
 * instead of adding a second timer.
 */
function initializeHealthMonitoring(db: SqliteRelayDatabase): void {
  const engine = new HealthIncidentEngine(db.healthObservations, db.healthIncidents);
  healthCoordinator = new HealthRuntimeCoordinator({ repos: db, engine });

  healthScheduler = new HealthScheduler({ coordinator: healthCoordinator });
  healthScheduler.start();

  console.log('[Health] Phase 1 health monitoring active in main process (read-only).');
}

function createWindow(): void {
  console.log('[Lifecycle] createWindow entered');
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: 'RelayX',
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
  console.log('[Lifecycle] BrowserWindow created');

  mainWindow.once('ready-to-show', () => {
    console.log('[Lifecycle] ready-to-show');
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-start-loading', () => {
    console.log('[Lifecycle] did-start-loading');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[Lifecycle] did-finish-load');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('[Lifecycle] did-fail-load:', errorCode, errorDescription);
  });

  mainWindow.on('close', () => {
    console.log('[Lifecycle] window close');
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
    console.log(`[RelayX Electron] Starting in DEVELOPMENT mode, connecting to Vite dev server: ${devServerUrl}`);
    mainWindow.loadURL(devServerUrl).catch((err) => {
      console.warn(`[RelayX Electron] Initial loadURL failed (${err.message}). Retrying with hostname fallback in 1s...`);
      const fallbackUrl = devServerUrl.includes('localhost')
        ? devServerUrl.replace('localhost', '127.0.0.1')
        : devServerUrl.replace('127.0.0.1', 'localhost');
      setTimeout(() => {
        mainWindow?.loadURL(devServerUrl).catch(() => {
          mainWindow?.loadURL(fallbackUrl).catch((retryErr) => {
            console.error('[RelayX Electron] Dev server connection failed:', retryErr);
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
      console.log(`[RelayX Electron] Starting in PRODUCTION mode, loading local assets from: ${resolvedPath}`);
      mainWindow.loadFile(resolvedPath);
    } else {
      console.error(
        `[RelayX Electron] Fatal: Could not locate compiled dist/index.html in any candidate path:\n${candidatePaths.join('\n')}`,
      );
    }
  }

  mainWindow.on('closed', () => {
    console.log('[Lifecycle] window closed');
    mainWindow = null;
  });
}

// Ensure single instance lock
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log(
    '[Lifecycle] Another RelayX instance owns the single-instance lock; exiting.'
  );
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
        console.log('[RelayX Engine] Startup crash recovery complete:', report);
      } catch (err) {
        console.error('[RelayX Engine] Startup recovery error:', err);
      }

      // Phase 8: Start continuous background supervision loop
      //
      // Health's time-based DELIVERY_STALLED check rides this EXISTING loop
      // instead of adding another timer. The engine's interval body runs RelayX
      // supervision unchanged; the override passed alongside it performs only the
      // throttled health sweep, so supervision is never run twice and never
      // blocked or failed by health.
      if (relayEngine && healthCoordinator) {
        const sweep = withHealthDeliverySweep(healthCoordinator);
        relayEngine.startSupervisionLoop(5000, () => sweep.sweepIfDue());
      } else {
        relayEngine.startSupervisionLoop(5000);
      }

      if (healthCoordinator) {
        await healthCoordinator.onStartup();
      }
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
    console.log('[Lifecycle] window-all-closed');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    console.log('[Lifecycle] before-quit');
  });

  app.on('will-quit', () => {
    console.log('[Lifecycle] will-quit');
    if (healthScheduler) {
      healthScheduler.stop();
      healthScheduler = null;
    }
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
        console.log('[RelayX Engine] SQLite database closed gracefully.');
      } catch (err) {
        console.error('[RelayX Engine] Error closing SQLite database:', err);
      }
    }
  });

  app.on('quit', (event, exitCode) => {
    console.log('[Lifecycle] quit, exitCode:', exitCode);
  });

  process.on('uncaughtException', (err) => {
    console.error('[Lifecycle] Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Lifecycle] Unhandled Rejection:', reason);
  });
}
