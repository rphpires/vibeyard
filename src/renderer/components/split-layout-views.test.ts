// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Two layout views (main + sessions) in two containers. Pane modules are mocked
// with the same "no-op when already in the container" contract the real attach*
// helpers have, so appendChild spies show whether a render touched a placed pane.
// split-layout.test.ts keeps its fake `document` stub, so this lives on its own.

const handlers: Record<string, (data?: unknown) => void> = {};
const fakeState = {
  projects: [] as Array<Record<string, unknown>>,
  activeProject: undefined as Record<string, unknown> | undefined,
  profiles: [] as Array<{ id: string; providerId: string; configDir: string }>,
  on: vi.fn((event: string, cb: (data?: unknown) => void) => { handlers[event] = cb; }),
  setActiveSession: vi.fn(),
  consumePendingInitialPrompt: vi.fn(),
  consumePendingSystemPrompt: vi.fn(),
  consumePendingCliName: vi.fn(),
};
vi.mock('../state.js', () => ({ appState: fakeState }));
vi.mock('../session-unread.js', () => ({ isUnread: vi.fn(() => false), onChange: vi.fn() }));

const panes = new Map<string, { element: HTMLElement; spawned: boolean; exited: boolean }>();
function makePane(id: string, kind: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `${kind} hidden`;
  el.dataset.sessionId = id;
  panes.set(id, { element: el, spawned: true, exited: false });
  return el;
}
function attach(id: string, target: HTMLElement): void {
  const el = panes.get(id)?.element;
  if (el && el.parentElement !== target) target.appendChild(el);
}
function hideWithin(within?: HTMLElement): void {
  for (const { element } of panes.values()) {
    if (!within || within.contains(element)) element.classList.add('hidden');
  }
}
const show = (id: string): void => { panes.get(id)?.element.classList.remove('hidden'); };

const terminal = {
  createTerminalPane: vi.fn((id: string) => { makePane(id, 'terminal-pane'); }),
  attachToContainer: vi.fn(attach),
  showPane: vi.fn(show),
  hideAllPanes: vi.fn(hideWithin),
  fitAllVisible: vi.fn(),
  setFocused: vi.fn(),
  spawnTerminal: vi.fn(),
  setPendingPrompt: vi.fn(),
  setPendingSystemPrompt: vi.fn(),
  setPendingCliName: vi.fn(),
  destroyTerminal: vi.fn(),
  getTerminalInstance: vi.fn((id: string) => panes.get(id)),
};
vi.mock('./terminal-pane.js', () => terminal);

const kanban = {
  createKanbanPane: vi.fn((id: string) => { makePane(id, 'kanban-pane'); }),
  destroyKanbanPane: vi.fn(),
  showKanbanPane: vi.fn(show),
  hideAllKanbanPanes: vi.fn(hideWithin),
  attachKanbanToContainer: vi.fn(attach),
  getKanbanInstance: vi.fn((id: string) => panes.get(id)),
};
vi.mock('./kanban/pane.js', () => kanban);

vi.mock('./mcp-inspector.js', () => ({
  createInspectorPane: vi.fn(), destroyInspectorPane: vi.fn(), showInspectorPane: vi.fn(),
  hideAllInspectorPanes: vi.fn(), attachInspectorToContainer: vi.fn(), getInspectorInstance: vi.fn(),
  disconnectInspector: vi.fn(),
}));
vi.mock('./session-inspector.js', () => ({ isInspectorOpen: vi.fn(() => false) }));
vi.mock('./file-viewer.js', () => ({
  createFileViewerPane: vi.fn(), destroyFileViewerPane: vi.fn(), showFileViewerPane: vi.fn(),
  hideAllFileViewerPanes: vi.fn(), attachFileViewerToContainer: vi.fn(), getFileViewerInstance: vi.fn(),
}));
vi.mock('./file-reader.js', () => ({
  createFileReaderPane: vi.fn(), destroyFileReaderPane: vi.fn(), showFileReaderPane: vi.fn(),
  hideAllFileReaderPanes: vi.fn(), attachFileReaderToContainer: vi.fn(), getFileReaderInstance: vi.fn(),
  setFileReaderLine: vi.fn(),
}));
vi.mock('./remote-terminal-pane.js', () => ({
  getRemoteTerminalInstance: vi.fn(), destroyRemoteTerminal: vi.fn(), attachRemoteToContainer: vi.fn(),
  showRemotePane: vi.fn(), hideAllRemotePanes: vi.fn(),
}));
vi.mock('./browser-tab-pane.js', () => ({
  createBrowserTabPane: vi.fn(), destroyBrowserTabPane: vi.fn(), showBrowserTabPane: vi.fn(),
  hideAllBrowserTabPanes: vi.fn(), attachBrowserTabToContainer: vi.fn(), getBrowserTabInstance: vi.fn(),
}));
vi.mock('./project-tab/pane.js', () => ({
  createProjectTabPane: vi.fn(), destroyProjectTabPane: vi.fn(), showProjectTabPane: vi.fn(),
  hideAllProjectTabPanes: vi.fn(), attachProjectTabToContainer: vi.fn(), getProjectTabInstance: vi.fn(),
}));
vi.mock('./team/pane.js', () => ({
  createTeamPane: vi.fn(), destroyTeamPane: vi.fn(), showTeamPane: vi.fn(),
  hideAllTeamPanes: vi.fn(), attachTeamToContainer: vi.fn(), getTeamInstance: vi.fn(),
}));
vi.mock('./tab-bar.js', () => ({ quickNewSession: vi.fn() }));

const rafQueue: Array<() => void> = [];
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; });
function flushRaf(): void {
  while (rafQueue.length) rafQueue.shift()!();
}

const mainContainer = document.createElement('div');
mainContainer.id = 'terminal-container';
document.body.appendChild(mainContainer);
const sessionsContainer = document.createElement('div');
document.body.appendChild(sessionsContainer);

const { initSplitLayout, createLayoutView, destroyLayoutView, renderLayout } = await import('./split-layout.js');
const windowState = await import('../session-window-state.js');
initSplitLayout();

type Session = { id: string; type?: string; cliSessionId: null; detached?: boolean };
function project(id: string, sessions: Session[], activeSessionId: string | null) {
  return {
    id, name: id, path: `/work/${id}`, sessions, activeSessionId,
    layout: { mode: 'tabs', splitPanes: [] as string[], splitDirection: 'horizontal' },
  };
}

describe('layout views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rafQueue.length = 0;
    windowState._resetForTesting();
  });

  it('lays out the active project in main and the detached project in the sessions view', () => {
    const a = project('A', [{ id: 'a1', cliSessionId: null }], 'a1');
    const b = project('B', [{ id: 'b1', cliSessionId: null }, { id: 'bk', type: 'kanban', cliSessionId: null }], 'b1');
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const view = createLayoutView('sessions', sessionsContainer);

    try {
      renderLayout();
      flushRaf();

      const a1 = panes.get('a1')!.element;
      const b1 = panes.get('b1')!.element;
      expect(a1.parentElement).toBe(mainContainer);
      expect(b1.parentElement).toBe(sessionsContainer);
      expect(a1.classList.contains('hidden')).toBe(false);
      expect(b1.classList.contains('hidden')).toBe(false);
      // The kanban tab of the detached project belongs to the main view, not this one.
      expect(panes.get('bk')?.element.parentElement ?? null).not.toBe(sessionsContainer);

      // Each view only hides what lives in its own container.
      for (const call of terminal.hideAllPanes.mock.calls) {
        expect([mainContainer, sessionsContainer]).toContain(call[0]);
      }
      // Fits are scoped to each view's document.
      expect(terminal.fitAllVisible).toHaveBeenCalledWith(document);

      const mainAppend = vi.spyOn(mainContainer, 'appendChild');
      const sessionsAppend = vi.spyOn(sessionsContainer, 'appendChild');
      renderLayout();
      flushRaf();

      expect(a1.classList.contains('hidden')).toBe(false);
      expect(b1.classList.contains('hidden')).toBe(false);
      expect(mainAppend).not.toHaveBeenCalled();
      expect(sessionsAppend).not.toHaveBeenCalled();
    } finally {
      destroyLayoutView(view);
      vi.restoreAllMocks();
    }
  });

  it('renders nothing into a sessions view once it is destroyed', () => {
    const a = project('A', [{ id: 'a2', cliSessionId: null }], 'a2');
    const b = project('B', [{ id: 'b2', cliSessionId: null }], 'b2');
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const other = document.createElement('div');
    const view = createLayoutView('sessions', other);
    destroyLayoutView(view);

    renderLayout();
    expect(panes.get('b2')?.element.parentElement ?? null).not.toBe(other);
    expect(panes.get('a2')!.element.parentElement).toBe(mainContainer);
  });

  it('a session added to the detached project relays out and fits only the view showing it', () => {
    const a = project('A', [{ id: 'a3', cliSessionId: null }], 'a3');
    const b = project('B', [], null);
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const otherDoc = document.implementation.createHTMLDocument('sessions');
    const container = otherDoc.createElement('div');
    otherDoc.body.appendChild(container);
    const view = createLayoutView('sessions', container);

    try {
      const session = { id: 'b3', cliSessionId: null };
      b.sessions.push(session);
      b.activeSessionId = 'b3';
      handlers['session-added']({ projectId: 'B', session });
      flushRaf();

      expect(panes.get('b3')!.element.parentElement).toBe(container);
      expect(terminal.spawnTerminal).toHaveBeenCalledWith('b3');
      expect(terminal.fitAllVisible).toHaveBeenCalledWith(otherDoc);
      expect(terminal.fitAllVisible).not.toHaveBeenCalledWith(document);
      expect(terminal.hideAllPanes).not.toHaveBeenCalledWith(mainContainer);
    } finally {
      destroyLayoutView(view);
    }
  });
});
