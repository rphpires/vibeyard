import type { BrowserWindow } from 'electron';
import { SESSION_WINDOW_FRAME } from '../shared/session-window';

export interface Bounds { x: number; y: number; width: number; height: number }

export const DEFAULT_SESSION_WINDOW_SIZE = { width: 1000, height: 700 };

// The renderer suffixes a counter (`vibeyard-sessions-3`) so a reopen never reuses a closing window.
// Exact match: a bare prefix test would admit any about:blank link whose target merely starts with it.
const SESSION_WINDOW_FRAME_RE = new RegExp(`^${SESSION_WINDOW_FRAME}-[0-9]+$`);

export function isSessionWindowOpen(url: string, frameName: string): boolean {
  return url === 'about:blank' && SESSION_WINDOW_FRAME_RE.test(frameName);
}

function overlapArea(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Saved bounds if at least half their area is on some display; else default size centered on main. */
export function resolveSessionWindowBounds(
  saved: Bounds | undefined,
  displays: { workArea: Bounds }[],
  main: Bounds,
): Bounds {
  if (saved && saved.width > 0 && saved.height > 0) {
    const area = saved.width * saved.height;
    if (displays.some((d) => overlapArea(saved, d.workArea) * 2 >= area)) return saved;
  }
  const { width, height } = DEFAULT_SESSION_WINDOW_SIZE;
  return {
    x: Math.round(main.x + (main.width - width) / 2),
    y: Math.round(main.y + (main.height - height) / 2),
    width,
    height,
  };
}

/**
 * The sessions window has no code of its own: the main renderer drives it, rAF and
 * timers included. Chromium throttles a minimized or covered window's renderer, so
 * while a sessions window exists main must not be throttled, or a Ctrl+T there
 * leaves the PTY unspawned and the dialog unfocused until main is shown again.
 */
export function syncMainThrottling(main: BrowserWindow | null, sessionWindowOpen: boolean): void {
  if (!main || main.isDestroyed()) return;
  main.webContents.setBackgroundThrottling(!sessionWindowOpen);
}
