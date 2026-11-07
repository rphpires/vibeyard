import type { BrowserWindow } from 'electron';

// Explicit window registry. Once a second window exists, the first entry of getAllWindows()
// is no longer guaranteed to be the main window, so main-process code must go through here.

export type WindowKind = 'main' | 'sessions';

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

export function windowKindOf(win: BrowserWindow | null): WindowKind | null {
  if (!win) return null;
  if (win === mainWindow) return 'main';
  if (win === sessionWindow) return 'sessions';
  return null;
}
