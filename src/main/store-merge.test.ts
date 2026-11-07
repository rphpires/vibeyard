import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersistedState } from '../shared/types';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { preserveMainOwnedFields, saveSessionWindowBounds, saveState, setKnownSessionWindowBounds } from './store';

const base = { version: 1, projects: [], activeProjectId: null, preferences: {} } as unknown as PersistedState;
const bounds = { x: 1, y: 2, width: 3, height: 4 };

describe('preserveMainOwnedFields', () => {
  beforeEach(() => setKnownSessionWindowBounds(undefined));

  it('fills sessionWindowBounds when the renderer payload lacks it', () => {
    expect(preserveMainOwnedFields(base, bounds).sessionWindowBounds).toEqual(bounds);
  });

  it('overrides stale bounds present in the renderer payload (main is authoritative)', () => {
    const stale = { x: 9, y: 9, width: 9, height: 9 };
    expect(preserveMainOwnedFields({ ...base, sessionWindowBounds: stale }, bounds).sessionWindowBounds).toEqual(bounds);
  });

  it('leaves the payload untouched when main knows nothing', () => {
    expect(preserveMainOwnedFields(base, undefined)).toBe(base);
  });
});

describe('renderer save after main wrote newer bounds', () => {
  it('keeps the newer bounds', () => {
    vi.useFakeTimers();
    const startup = { x: 0, y: 0, width: 500, height: 500 };
    setKnownSessionWindowBounds(startup);
    saveSessionWindowBounds(bounds);
    // renderer snapshot still carries the startup value
    saveState({ ...base, sessionWindowBounds: startup });
    vi.advanceTimersByTime(400);
    const calls = vi.mocked(fs.writeFileSync).mock.calls;
    const written = JSON.parse(calls[calls.length - 1][1] as string) as PersistedState;
    expect(written.sessionWindowBounds).toEqual(bounds);
    vi.useRealTimers();
  });
});
