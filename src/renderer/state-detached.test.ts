import { describe, it, expect, vi, beforeEach } from 'vitest';

// appState routing while a project is detached into the sessions window: the
// project's activeSessionId belongs to the sessions view, the main view keeps its
// own transient selection of project-level tabs (Overview/Kanban/Team).

vi.stubGlobal('window', {
  vibeyard: { store: { load: vi.fn(), save: vi.fn() } },
});

let uuidCounter = 0;
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++uuidCounter}` });

vi.mock('./session-cost.js', () => ({ getCost: vi.fn().mockReturnValue(null), restoreCost: vi.fn() }));
vi.mock('./session-context.js', () => ({ restoreContext: vi.fn() }));
vi.mock('./provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => null),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  getTeamChatProviderMetas: vi.fn(() => []),
}));

import { appState, _resetForTesting } from './state';
import * as ws from './session-window-state.js';

// A is the active project in the main window; B is shown in the sessions window.
function setup() {
  const b = appState.addProject('B', '/b');
  const b1 = appState.addSession(b.id, 'b1')!;
  const b2 = appState.addSession(b.id, 'b2')!;
  const a = appState.addProject('A', '/a');
  appState.setActiveProject(a.id);
  ws.setDetachedProjectId(b.id);
  return { a, b, b1, b2 };
}

beforeEach(() => {
  uuidCounter = 0;
  _resetForTesting();
  ws._resetForTesting();
});

describe('a detached project (sessions window)', () => {
  it('addSession into the detached project keeps the main window on A', () => {
    const { a, b } = setup();
    const s = appState.addSession(b.id, 'b3')!;
    expect(appState.activeProjectId).toBe(a.id);
    expect(b.activeSessionId).toBe(s.id);
  });

  it('addExternalSession --focus into the detached project does not switch the main window', () => {
    const { a, b } = setup();
    const s = appState.addExternalSession(b.id, { name: 'w', createdBy: 'x', focus: true })!;
    expect(appState.activeProjectId).toBe(a.id);
    expect(b.activeSessionId).toBe(s.id);
  });

  it('addExternalSession --focus into a project that is not detached still switches to it', () => {
    const { a } = setup();
    ws.setDetachedProjectId(null);
    const other = appState.addProject('C', '/c');
    appState.setActiveProject(a.id);
    appState.addExternalSession(other.id, { name: 'w', createdBy: 'x', focus: true });
    expect(appState.activeProjectId).toBe(other.id);
  });

  it('opening Overview of the detached project selects it in the main view only', () => {
    const { b, b2 } = setup();
    const ov = appState.openProjectTab(b.id)!;
    expect(appState.activeProjectId).toBe(b.id); // Overview lives in the main window
    expect(b.activeSessionId).toBe(b2.id); // the sessions window keeps its tab
    expect(ws.viewActiveSessionId('main', b)).toBe(ov.id);
    // Activating the existing tab again is routed the same way.
    appState.setActiveSession(b.id, b2.id);
    ws.setMainViewSelection(null);
    appState.openProjectTab(b.id);
    expect(b.activeSessionId).toBe(b2.id);
    expect(ws.viewActiveSessionId('main', b)).toBe(ov.id);
  });

  it('setActiveSession on a project-level tab of the detached project leaves activeSessionId alone', () => {
    const { b, b1 } = setup();
    const kb = appState.openKanbanTab(b.id)!;
    appState.setActiveSession(b.id, b1.id);
    expect(b.activeSessionId).toBe(b1.id);
    appState.setActiveSession(b.id, kb.id);
    expect(b.activeSessionId).toBe(b1.id);
    expect(ws.viewActiveSessionId('main', b)).toBe(kb.id);
  });

  it('cycleSession(1, B) cycles only the sessions-view tabs', () => {
    const { b, b1, b2 } = setup();
    appState.openProjectTab(b.id);
    appState.openKanbanTab(b.id);
    appState.setActiveSession(b.id, b2.id);
    appState.cycleSession(1, b.id);
    expect(b.activeSessionId).toBe(b1.id);
    appState.cycleSession(1, b.id);
    expect(b.activeSessionId).toBe(b2.id);
  });

  it('cycleSession in the main view of the detached project cycles its project-level tabs', () => {
    const { b, b2 } = setup();
    const ov = appState.openProjectTab(b.id)!;
    const kb = appState.openKanbanTab(b.id)!;
    appState.cycleSession(1, b.id, 'main');
    expect(ws.viewActiveSessionId('main', b)).toBe(ov.id);
    appState.cycleSession(1); // no project: the active one (B), in the main view
    expect(ws.viewActiveSessionId('main', b)).toBe(kb.id);
    expect(b.activeSessionId).toBe(b2.id);
  });

  it('gotoSession(0, B) picks the first sessions-view tab', () => {
    const { b, b1 } = setup();
    appState.openProjectTab(b.id);
    appState.gotoSession(0, b.id);
    expect(b.activeSessionId).toBe(b1.id);
  });

  it('toggleSwarm(B) changes the detached project, not the active one', () => {
    const { a, b, b1, b2 } = setup();
    appState.openKanbanTab(b.id);
    appState.setActiveProject(a.id);
    appState.toggleSwarm(b.id);
    expect(b.layout.mode).toBe('swarm');
    expect(b.layout.splitPanes).toEqual([b1.id, b2.id]);
    expect(a.layout.mode).toBe('tabs');
  });
});
