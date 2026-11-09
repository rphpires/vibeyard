import { describe, it, expect, vi, beforeEach } from 'vitest';

const prefs = vi.hoisted(() => ({}) as { zoomFactor?: number });
vi.mock('./state.js', () => ({
  appState: {
    preferences: prefs,
    setPreference: vi.fn((k: 'zoomFactor', v: number) => { prefs[k] = v; }),
  },
}));
vi.mock('./components/terminal-pane.js', () => ({ fitAllVisible: vi.fn() }));

import { applyZoom } from './zoom';

describe('applyZoom', () => {
  const zoomSet = vi.fn();
  const sessionSetZoom = vi.fn();

  beforeEach(() => {
    zoomSet.mockClear();
    sessionSetZoom.mockClear();
    delete prefs.zoomFactor;
    vi.stubGlobal('window', { vibeyard: { zoom: { set: zoomSet }, sessionWindow: { setZoom: sessionSetZoom } } });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => cb());
  });

  it('applies the clamped factor to the main and the session window', () => {
    applyZoom(1.25);
    expect(zoomSet).toHaveBeenCalledWith(1.25);
    expect(sessionSetZoom).toHaveBeenCalledWith(1.25);
  });

  it('does nothing when the factor is unchanged', () => {
    applyZoom(1.0);
    expect(sessionSetZoom).not.toHaveBeenCalled();
  });
});
