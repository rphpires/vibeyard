import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProjectRecord, SessionRecord, SessionType } from '../shared/types.js';
import {
  getDetachedProjectId,
  setDetachedProjectId,
  onDetachedChange,
  viewShowsSession,
  viewTabs,
  projectIdForView,
  PROJECT_LEVEL_TAB_TYPES,
  _resetForTesting,
} from './session-window-state.js';

function sess(id: string, type?: SessionType, detached = false): SessionRecord {
  return { id, name: id, type, cliSessionId: null, createdAt: '', detached } as unknown as SessionRecord;
}

describe('session-window-state', () => {
  beforeEach(() => _resetForTesting());

  it('exposes project-level tab types', () => {
    expect([...PROJECT_LEVEL_TAB_TYPES]).toEqual(['project-tab', 'kanban', 'team']);
  });

  it('without a detached project the main view shows everything', () => {
    expect(getDetachedProjectId()).toBeNull();
    expect(viewShowsSession('main', 'p', sess('a'))).toBe(true);
    expect(viewShowsSession('sessions', 'p', sess('a'))).toBe(false);
  });

  it('splits sessions for the detached project', () => {
    setDetachedProjectId('p');
    for (const t of [undefined, 'file-reader', 'browser-tab'] as const) {
      expect(viewShowsSession('sessions', 'p', sess('a', t))).toBe(true);
      expect(viewShowsSession('main', 'p', sess('a', t))).toBe(false);
    }
    for (const t of ['project-tab', 'kanban', 'team'] as const) {
      expect(viewShowsSession('main', 'p', sess('a', t))).toBe(true);
      expect(viewShowsSession('sessions', 'p', sess('a', t))).toBe(false);
    }
  });

  it('does not affect other projects', () => {
    setDetachedProjectId('p');
    expect(viewShowsSession('main', 'q', sess('a'))).toBe(true);
    expect(viewShowsSession('sessions', 'q', sess('a'))).toBe(false);
  });

  it('viewTabs excludes detached sessions and applies the filter', () => {
    setDetachedProjectId('p');
    const project = {
      id: 'p',
      sessions: [sess('cli'), sess('hidden', undefined, true), sess('kb', 'kanban'), sess('f', 'file-reader')],
    } as unknown as ProjectRecord;
    expect(viewTabs('sessions', project).map((s) => s.id)).toEqual(['cli', 'f']);
    expect(viewTabs('main', project).map((s) => s.id)).toEqual(['kb']);
  });

  it('projectIdForView', () => {
    expect(projectIdForView('main', 'x')).toBe('x');
    expect(projectIdForView('main', null)).toBeNull();
    expect(projectIdForView('sessions', 'x')).toBeNull();
    setDetachedProjectId('p');
    expect(projectIdForView('sessions', 'x')).toBe('p');
  });

  it('onDetachedChange fires once per change, not on equal set, and unsubscribes', () => {
    const cb = vi.fn();
    const off = onDetachedChange(cb);
    setDetachedProjectId('p');
    setDetachedProjectId('p');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('p');
    setDetachedProjectId(null);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    setDetachedProjectId('q');
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
