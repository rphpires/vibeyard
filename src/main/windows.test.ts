import { describe, it, expect, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { getMainWindow, setMainWindow, getSessionWindow, setSessionWindow, windowKindOf } from './windows';

function fakeWin(destroyed = false): BrowserWindow {
  const w = { destroyed, isDestroyed: () => w.destroyed };
  return w as unknown as BrowserWindow;
}

describe('windows registry', () => {
  beforeEach(() => {
    setMainWindow(null);
    setSessionWindow(null);
  });

  it('returns the registered main window', () => {
    const a = fakeWin();
    setMainWindow(a);
    expect(getMainWindow()).toBe(a);
  });

  it('classifies windows by kind', () => {
    const a = fakeWin(), b = fakeWin(), c = fakeWin();
    setMainWindow(a);
    setSessionWindow(b);
    expect(windowKindOf(a)).toBe('main');
    expect(windowKindOf(b)).toBe('sessions');
    expect(windowKindOf(c)).toBeNull();
    expect(windowKindOf(null)).toBeNull();
  });

  it('returns null for destroyed windows', () => {
    setMainWindow(fakeWin(true));
    setSessionWindow(fakeWin(true));
    expect(getMainWindow()).toBeNull();
    expect(getSessionWindow()).toBeNull();
  });
});
