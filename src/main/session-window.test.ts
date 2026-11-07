import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const persisted = vi.hoisted(() => ({ zoomFactor: undefined as number | undefined }));
vi.mock('./store', () => ({ currentState: () => ({ preferences: { zoomFactor: persisted.zoomFactor } }) }));
import { isSessionWindowOpen, resolveSessionWindowBounds, syncMainThrottling, rememberSessionWindowZoom, sessionWindowZoom } from './session-window';

describe('isSessionWindowOpen', () => {
  it('accepts only about:blank with a numbered sessions frame name', () => {
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-1')).toBe(true);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-12')).toBe(true);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions')).toBe(false);
    expect(isSessionWindowOpen('about:blank', 'x')).toBe(false);
    expect(isSessionWindowOpen('https://a', 'vibeyard-sessions-1')).toBe(false);
    expect(isSessionWindowOpen('file:///x', 'vibeyard-sessions-1')).toBe(false);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-')).toBe(false);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-x')).toBe(false);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-1-evil')).toBe(false);
    expect(isSessionWindowOpen('about:blank', 'vibeyard-sessions-1x')).toBe(false);
  });
});

describe('resolveSessionWindowBounds', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const main = { x: 100, y: 100, width: 1400, height: 900 };

  it('returns saved bounds when inside a display', () => {
    const saved = { x: 200, y: 150, width: 800, height: 600 };
    expect(resolveSessionWindowBounds(saved, displays, main)).toEqual(saved);
  });

  it('keeps saved bounds when at least half the area is visible', () => {
    const saved = { x: 1520, y: 100, width: 800, height: 600 };
    expect(resolveSessionWindowBounds(saved, displays, main)).toEqual(saved);
  });

  it('centers 1000x700 on main when the saved display is gone', () => {
    const saved = { x: 3000, y: 100, width: 800, height: 600 };
    expect(resolveSessionWindowBounds(saved, displays, main)).toEqual({ x: 300, y: 200, width: 1000, height: 700 });
  });

  it('centers on main when nothing is saved', () => {
    expect(resolveSessionWindowBounds(undefined, displays, main)).toEqual({ x: 300, y: 200, width: 1000, height: 700 });
  });
});

describe('syncMainThrottling', () => {
  // The main renderer drives the sessions window (its rAF and timers), so main
  // must keep running at full rate while a sessions window exists, even hidden.
  function fakeMain(destroyed = false) {
    const setBackgroundThrottling = vi.fn();
    const win = { isDestroyed: () => destroyed, webContents: { setBackgroundThrottling } };
    return { win: win as unknown as BrowserWindow, setBackgroundThrottling };
  }

  it('turns throttling off while the sessions window exists and back on when it closes', () => {
    const { win, setBackgroundThrottling } = fakeMain();
    syncMainThrottling(win, true);
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    syncMainThrottling(win, false);
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('ignores a missing or destroyed main window', () => {
    expect(() => syncMainThrottling(null, true)).not.toThrow();
    const { win, setBackgroundThrottling } = fakeMain(true);
    syncMainThrottling(win, false);
    expect(setBackgroundThrottling).not.toHaveBeenCalled();
  });
});

describe('sessionWindowZoom', () => {
  it('uses the persisted zoom until the renderer reports one, then the reported one', () => {
    expect(sessionWindowZoom()).toBe(1);
    persisted.zoomFactor = 1.25;
    expect(sessionWindowZoom()).toBe(1.25);
    // A zoom change reported before any child exists (the disk copy still lags).
    rememberSessionWindowZoom(1.5);
    expect(sessionWindowZoom()).toBe(1.5);
  });
});
