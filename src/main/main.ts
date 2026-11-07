import { app, BrowserWindow, dialog, powerMonitor, screen, shell } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { registerIpcHandlers, resetHookWatcher, getCtlServer } from './ipc-handlers';
import { installCtlScript } from './ctl-script';
import { stripInheritedCtlEnv } from './ctl-tokens';
import { killAllPtys } from './pty-manager';
import { stopAllRemoteMirrors } from './remote-ssh';
import { currentState, flushState, knownSessionWindowBounds, loadState, saveSessionWindowBounds } from './store';
import { createAppMenu } from './menu';
import { restartAndResync } from './hook-status';
import { initProviders, getAllProviders } from './providers/registry';
import { initAutoUpdater } from './auto-updater';
import { stopGitWatcher } from './git-watcher';
import { stopAllFileWatchers } from './file-watcher';
import { checkPythonAvailable } from './prerequisites';
import { isMac } from './platform';
import { isCloseConfirmed, setCloseConfirmed } from './close-state';
import { isHttpUrl } from '../shared/url';
import { getMainWindow, setMainWindow, getSessionWindow, setSessionWindow } from './windows';
import { isSessionWindowOpen, resolveSessionWindowBounds, sessionWindowZoom, syncMainThrottling } from './session-window';

// Before anything spawns: never pass a parent Vibeyard tab's ctl identity on.
stripInheritedCtlEnv();

function requestConfirmClose(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:confirmClose');
  } else {
    setCloseConfirmed(true);
    app.quit();
  }
}

function createWindow(): void {
  const iconPath = path.join(__dirname, '..', '..', '..', 'build', 'icon.png');
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: 'Vibeyard',
    icon: iconPath,
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // needed for node-pty IPC
      webviewTag: true, // needed for browser-tab sessions
    },
  });

  setMainWindow(mainWindow);

  const indexPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');
  mainWindow.loadFile(indexPath);

  // Open external links in default browser instead of inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // The one window the renderer may open: the sessions window (window.open('about:blank', name)).
    if (isSessionWindowOpen(url, frameName) && !getSessionWindow()) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...resolveSessionWindowBounds(knownSessionWindowBounds(), screen.getAllDisplays(), mainWindow.getBounds()),
          minWidth: 500,
          minHeight: 300,
          title: 'Vibeyard',
          icon: iconPath,
          backgroundColor: '#000000',
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true, // browser-tab panes may be moved here
          },
        },
      };
    }
    if (isHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (child) => {
    setSessionWindow(child);
    // Main's renderer drives the child (its frames and timers): keep it unthrottled meanwhile.
    syncMainThrottling(getMainWindow(), true);
    // The sessions window never opens further windows; http(s) goes to the default browser.
    child.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    // Match the main window's zoom from the start: in-memory, since the file lags the renderer.
    child.webContents.setZoomFactor(sessionWindowZoom(currentState().preferences?.zoomFactor));
    // Only about:blank is ever allowed here; everything else is blocked (external http opens in the browser).
    child.webContents.on('will-navigate', (event, navUrl) => {
      if (navUrl === 'about:blank') return;
      event.preventDefault();
      if (isHttpUrl(navUrl)) shell.openExternal(navUrl);
    });
    let boundsTimer: ReturnType<typeof setTimeout> | null = null;
    const saveBounds = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        boundsTimer = null;
        if (child.isDestroyed() || child.isMinimized() || child.isFullScreen()) return;
        saveSessionWindowBounds(child.getNormalBounds());
      }, 500);
    };
    child.on('move', saveBounds);
    child.on('resize', saveBounds);
    child.on('closed', () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      setSessionWindow(null);
      const main = getMainWindow();
      syncMainThrottling(main, false);
      if (main) main.webContents.send('sessionWindow:closed');
    });
  });

  // The app document is the ONLY navigation target we ever allow. A stray anchor
  // in rendered content (e.g. a relative `.md` link in the file reader) resolves
  // against this file:// document and would otherwise navigate the window away
  // from index.html, destroying every session, PTY and layout binding with it.
  // Compared on the decoded pathname so percent-encoding differences between
  // Electron's own loadFile URL and pathToFileURL never cause a false block.
  const appPathname = decodeURIComponent(pathToFileURL(indexPath).pathname);
  const isAppUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' && decodeURIComponent(parsed.pathname) === appPathname;
    } catch {
      return false;
    }
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url);
  });

  // vibeyard-ctl requests are relayed to the page, so the server must know when
  // that page goes away. A load start may still be cancelled (the will-navigate
  // guard above blocks most navigations), so it only holds new requests. Once a
  // new document commits or the renderer dies, the old page can never answer,
  // so in-flight requests are failed at once instead of waiting out the
  // client's timeout. A load that stops without committing left the old page in
  // place, so held requests are released to it; a real reload re-runs
  // initCtlBridge, which sends ctl:rendererReady itself.
  let navigatedSinceLoadStart = false;
  mainWindow.webContents.on('did-start-loading', () => {
    navigatedSinceLoadStart = false;
    getCtlServer()?.onRendererGone();
  });
  mainWindow.webContents.on('did-navigate', () => {
    navigatedSinceLoadStart = true;
    getCtlServer()?.failPending();
    getCtlServer()?.onRendererGone();
  });
  mainWindow.webContents.on('render-process-gone', () => {
    getCtlServer()?.failPending();
    getCtlServer()?.onRendererGone();
  });
  mainWindow.webContents.on('did-stop-loading', () => {
    if (!navigatedSinceLoadStart) getCtlServer()?.onRendererReady();
  });

  mainWindow.on('close', (event) => {
    if (!isCloseConfirmed()) {
      event.preventDefault();
      requestConfirmClose();
      return;
    }
    // Confirmed close: take the sessions window down with the main one (it has no confirm flow).
    const sessions = getSessionWindow();
    if (sessions) sessions.close();
    flushState();
  });

  mainWindow.on('closed', () => {
    getCtlServer()?.failPending();
    getCtlServer()?.onRendererGone();
    killAllPtys();
    stopAllRemoteMirrors();
    resetHookWatcher();
    stopAllFileWatchers();
    setMainWindow(null);
  });
}

app.whenReady().then(async () => {
  initProviders();

  const providers = getAllProviders();
  const missing = providers.filter(p => !p.validatePrerequisites());
  for (const p of missing) {
    console.warn(`Provider "${p.meta.displayName}" not available`);
  }
  if (missing.length === providers.length) {
    const bullets = providers.map(p => `  • ${p.meta.displayName}`).join('\n');
    dialog.showErrorBox(
      'Vibeyard — No CLI Provider Found',
      `Vibeyard needs at least one supported CLI provider installed to run.\n\n` +
        `Install one of the following, then restart Vibeyard:\n\n${bullets}`,
    );
    app.quit();
    return;
  }

  registerIpcHandlers();
  const state = loadState();
  createAppMenu(state.preferences?.debugMode ?? false);
  createWindow();

  // Warn if Python is missing on Windows (hooks depend on it)
  const pythonWarning = checkPythonAvailable();
  if (pythonWarning) {
    console.warn(pythonWarning);
    dialog.showMessageBox(getMainWindow()!, {
      type: 'warning',
      title: 'Vibeyard — Python Not Found',
      message: pythonWarning,
    });
  }

  // Install hooks and status scripts for available providers (after window creation so dialogs can attach)
  for (const provider of getAllProviders()) {
    if (provider.validatePrerequisites()) {
      await provider.installHooks(getMainWindow());
      provider.installStatusScripts();
    }
  }
  try { installCtlScript(); } catch (err) { console.warn('Failed to install vibeyard-ctl:', err); }

  initAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        restartAndResync(win);
      }
    }
  });

  powerMonitor.on('resume', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      restartAndResync(win);
    }
  });
});

app.on('before-quit', (event) => {
  if (!isCloseConfirmed()) {
    event.preventDefault();
    requestConfirmClose();
    return;
  }
  flushState();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('app:quitting');
  }
  killAllPtys();
  stopAllRemoteMirrors();
  getCtlServer()?.stop();
  stopGitWatcher();
  stopAllFileWatchers();
  // Cleanup all providers
  for (const provider of getAllProviders()) {
    provider.cleanup();
  }
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
