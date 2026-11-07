import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PersistedState } from '../shared/types';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';

const base = { version: 1, projects: [], activeProjectId: null, preferences: {} } as unknown as PersistedState;
const bounds = { x: 1, y: 2, width: 3, height: 4 };

// Each test gets a fresh store module: the bounds main knows are module state.
async function freshStore(): Promise<typeof import('./store')> {
  vi.resetModules();
  return import('./store');
}

/** The state of the last debounced write. */
function lastWritten(): PersistedState {
  vi.advanceTimersByTime(400);
  const calls = vi.mocked(fs.writeFileSync).mock.calls;
  return JSON.parse(calls[calls.length - 1][1] as string) as PersistedState;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(fs.writeFileSync).mockClear();
  vi.mocked(fs.existsSync).mockReturnValue(false);
});
afterEach(() => vi.useRealTimers());

describe('renderer saves keep the main-owned sessionWindowBounds', () => {
  it('fills sessionWindowBounds when the renderer payload lacks it', async () => {
    const store = await freshStore();
    store.saveSessionWindowBounds(bounds);
    store.saveState(base);
    expect(lastWritten().sessionWindowBounds).toEqual(bounds);
  });

  it('overrides stale bounds present in the renderer payload (main is authoritative)', async () => {
    const store = await freshStore();
    store.saveSessionWindowBounds(bounds);
    store.saveState({ ...base, sessionWindowBounds: { x: 9, y: 9, width: 9, height: 9 } });
    expect(lastWritten().sessionWindowBounds).toEqual(bounds);
  });

  it('leaves the payload untouched when main knows nothing', async () => {
    const store = await freshStore();
    store.saveState(base);
    expect(lastWritten().sessionWindowBounds).toBeUndefined();
  });
});

describe('renderer save after main wrote newer bounds', () => {
  it('keeps the newer bounds', async () => {
    const startup = { x: 0, y: 0, width: 500, height: 500 };
    // The file main seeds from at startup.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...base, sessionWindowBounds: startup }));
    const store = await freshStore();
    expect(store.knownSessionWindowBounds()).toEqual(startup);
    store.saveSessionWindowBounds(bounds);
    // renderer snapshot still carries the startup value
    store.saveState({ ...base, sessionWindowBounds: startup });
    expect(lastWritten().sessionWindowBounds).toEqual(bounds);
  });
});
