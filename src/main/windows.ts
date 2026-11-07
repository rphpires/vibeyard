import type { BrowserWindow } from 'electron';
import type { ViewKind } from '../shared/session-window';

// Explicit window registry. Once a second window exists, the first entry of getAllWindows()
// is no longer guaranteed to be the main window, so main-process code must go through here.

let mainWindow: BrowserWindow | null = null;
let sessionWindow: BrowserWindow | null = null;

function live(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function getMainWindow(): BrowserWindow | null {
  return live(mainWindow);
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getSessionWindow(): BrowserWindow | null {
  return live(sessionWindow);
}

export function setSessionWindow(win: BrowserWindow | null): void {
  sessionWindow = win;
}

export function windowKindOf(win: BrowserWindow | null): ViewKind | null {
  if (!win) return null;
  if (win === mainWindow) return 'main';
  if (win === sessionWindow) return 'sessions';
  return null;
}

/**
 * Restore (if minimized) and focus `win`. `show`/`moveTop` also make it visible and put
 * it above every other window (the sessions window, which a plain focus may not raise).
 */
export function raiseWindow(win: BrowserWindow, opts: { show?: boolean; moveTop?: boolean } = {}): void {
  if (win.isMinimized()) win.restore();
  if (opts.show) win.show();
  win.focus();
  if (opts.moveTop) win.moveTop();
}
