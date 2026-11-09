import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PersistedState } from '../shared/types';
import type { Bounds } from './session-window';

export type { SessionRecord, ProjectRecord, Preferences, PersistedState } from '../shared/types';

const STATE_DIR = path.join(os.homedir(), '.vibeyard');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function defaultState(): PersistedState {
  return {
    version: 1,
    projects: [],
    activeProjectId: null,
    preferences: { soundOnSessionWaiting: true, notificationsDesktop: true, debugMode: false, sessionHistoryEnabled: true, insightsEnabled: true, autoTitleEnabled: true, confirmCloseWorkingSession: true, externalControlEnabled: false, locale: 'en' },
  };
}

export function loadState(): PersistedState {
  for (const file of [STATE_FILE, STATE_FILE + '.tmp']) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.version !== 1) continue;
      if (file !== STATE_FILE) {
        console.warn('Recovered state from temp file');
      }
      if (knownBounds === null) knownBounds = parsed.sessionWindowBounds;
      return parsed;
    } catch {
      continue;
    }
  }
  console.warn('No valid state file found, using defaults');
  return defaultState();
}

/**
 * The sessions window bounds, a field owned by the main process. The renderer saves the
 * whole state via store:save and may hold a stale copy (or none), so its payload never
 * wins: main's value is seeded from disk on the first loadState and updated only by
 * saveSessionWindowBounds. `null` until seeded (`undefined` once seeded means "none").
 */
let knownBounds: Bounds | undefined | null = null;

/** The sessions window bounds main knows (its own saves win over the file), without a disk read once seeded. */
export function knownSessionWindowBounds(): Bounds | undefined {
  if (knownBounds === null) loadState();
  return knownBounds ?? undefined;
}

/** Persist the sessions window bounds (main-process owned) on top of the freshest known state. */
export function saveSessionWindowBounds(bounds: Bounds): void {
  const base = lastState ?? loadState();
  knownBounds = bounds;
  saveState({ ...base, sessionWindowBounds: bounds });
}

export function saveState(incoming: PersistedState): void {
  const state = knownBounds && incoming.sessionWindowBounds !== knownBounds
    ? { ...incoming, sessionWindowBounds: knownBounds }
    : incoming;
  if (saveTimer) {
    clearTimeout(saveTimer);
  }
  lastState = state;
  saveTimer = setTimeout(() => {
    writeStateAtomically(state);
    saveTimer = null;
  }, 300);
}

let lastState: PersistedState | null = null;

/**
 * The freshest state main holds: the last one the renderer saved (the file lags it by
 * the save debounce), else the file. For reads at runtime, such as the sessions window's zoom.
 */
export function currentState(): PersistedState {
  return lastState ?? loadState();
}

export function flushState(): void {
  if (lastState) {
    saveStateSync(lastState);
  }
}

export function saveStateSync(state: PersistedState): void {
  writeStateAtomically(state);
}

function writeStateAtomically(state: PersistedState): void {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    const tmpFile = STATE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}
