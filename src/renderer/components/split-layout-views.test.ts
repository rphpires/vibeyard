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
  reloadWebgl: vi.fn(),
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
const sessionWindow = { focusSessionWindow: vi.fn(), closeSessionWindow: vi.fn() };
vi.mock('../session-window.js', () => sessionWindow);

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

const { initSplitLayout, createLayoutView, destroyLayoutView, renderLayout, evacuateLayoutView } = await import('./split-layout.js');
const { quickNewSession } = await import('./tab-bar.js');
const windowState = await import('../session-window-state.js');
const inspector = await import('./session-inspector.js');
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

  it('an empty detached project shows the empty state whose button starts a session in that project', () => {
    const a = project('A', [{ id: 'a4', cliSessionId: null }], 'a4');
    const b = project('B', [], null);
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const otherDoc = document.implementation.createHTMLDocument('sessions');
    const container = otherDoc.createElement('div');
    otherDoc.body.appendChild(container);
    const view = createLayoutView('sessions', container);

    try {
      renderLayout();
      const cta = container.querySelector<HTMLButtonElement>('.empty-state-cta');
      expect(cta).not.toBeNull();
      expect(cta!.ownerDocument).toBe(otherDoc);
      cta!.click();
      expect(quickNewSession).toHaveBeenCalledWith('B', otherDoc);
    } finally {
      destroyLayoutView(view);
    }
  });

  it('the swarm "+" cell of the sessions view starts a session in the detached project', () => {
    const a = project('A', [{ id: 'a5', cliSessionId: null }], 'a5');
    const b = project('B', [{ id: 'b5', cliSessionId: null }, { id: 'b6', cliSessionId: null }], 'b5');
    b.layout = { mode: 'swarm', splitPanes: ['b5', 'b6'], splitDirection: 'horizontal' };
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const otherDoc = document.implementation.createHTMLDocument('sessions');
    const container = otherDoc.createElement('div');
    otherDoc.body.appendChild(container);
    const view = createLayoutView('sessions', container);

    try {
      renderLayout();
      // 2 panes → 2x1 grid: no filler. Add a third pane for a 2x2 grid with one "+".
      b.sessions.push({ id: 'b7', cliSessionId: null });
      b.layout.splitPanes.push('b7');
      renderLayout();
      const add = container.querySelector<HTMLButtonElement>('.swarm-empty-add-btn');
      expect(add).not.toBeNull();
      add!.click();
      expect(quickNewSession).toHaveBeenCalledWith('B', otherDoc);
    } finally {
      destroyLayoutView(view);
    }
  });

  it('evacuateLayoutView moves every pane of the view into the target, hidden, re-homing xterm', () => {
    const a = project('A', [{ id: 'a8', cliSessionId: null }], 'a8');
    const b = project('B', [{ id: 'b8', cliSessionId: null }, { id: 'b9', cliSessionId: null }], 'b8');
    b.layout = { mode: 'split', splitPanes: ['b8', 'b9'], splitDirection: 'horizontal' };
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const otherDoc = document.implementation.createHTMLDocument('sessions');
    const container = otherDoc.createElement('div');
    otherDoc.body.appendChild(container);
    const view = createLayoutView('sessions', container);

    try {
      renderLayout();
      expect(panes.get('b8')!.element.parentElement).toBe(container);
      expect(panes.get('b9')!.element.parentElement).toBe(container);
      terminal.attachToContainer.mockClear();

      evacuateLayoutView(view, mainContainer);

      for (const id of ['b8', 'b9']) {
        const el = panes.get(id)!.element;
        expect(el.parentElement).toBe(mainContainer);
        expect(el.classList.contains('hidden')).toBe(true);
        // Through attachToContainer, which re-runs terminal.open() for the new document.
        expect(terminal.attachToContainer).toHaveBeenCalledWith(id, mainContainer);
        expect(terminal.reloadWebgl).toHaveBeenCalledWith(id);
      }
      // The main view's own pane is untouched.
      expect(terminal.attachToContainer).not.toHaveBeenCalledWith('a8', expect.anything());
      expect(container.querySelector('.terminal-pane')).toBeNull();
      expect(terminal.destroyTerminal).not.toHaveBeenCalled();
    } finally {
      destroyLayoutView(view);
    }
  });

  describe('the sessions view runs on its own window\'s frames', () => {
    // Main's rAF stops while main is minimized or covered; a sessions-window PTY
    // must still spawn and fit, so the sessions view never queues on main's frames.
    function childView() {
      const otherDoc = document.implementation.createHTMLDocument('sessions');
      const childQueue: Array<FrameRequestCallback> = [];
      Object.defineProperty(otherDoc, 'defaultView', {
        value: { requestAnimationFrame: (cb: FrameRequestCallback) => { childQueue.push(cb); return childQueue.length; } },
      });
      const container = otherDoc.createElement('div');
      otherDoc.body.appendChild(container);
      const view = createLayoutView('sessions', container);
      const flushChild = (): void => { while (childQueue.length) childQueue.shift()!(0); };
      return { otherDoc, container, view, flushChild };
    }

    it('a session added to the detached project spawns and fits on the sessions window\'s frame', () => {
      const a = project('A', [{ id: 'fa1', cliSessionId: null }], 'fa1');
      const b = project('B', [], null);
      fakeState.projects = [a, b];
      fakeState.activeProject = a;
      windowState.setDetachedProjectId('B');
      const { otherDoc, view, flushChild } = childView();
      try {
        const session = { id: 'fb1', cliSessionId: null };
        b.sessions.push(session);
        b.activeSessionId = 'fb1';
        handlers['session-added']({ projectId: 'B', session });

        // Nothing waits on main's frames.
        expect(rafQueue.length).toBe(0);
        expect(terminal.spawnTerminal).not.toHaveBeenCalled();
        flushChild();
        expect(terminal.spawnTerminal).toHaveBeenCalledWith('fb1');
        expect(terminal.fitAllVisible).toHaveBeenCalledWith(otherDoc);
      } finally {
        destroyLayoutView(view);
      }
    });

    it('an unspawned tab-mode or split pane of the sessions view spawns on that window\'s frame', () => {
      const a = project('A', [{ id: 'fa2', cliSessionId: null }], 'fa2');
      const b = project('B', [{ id: 'fb2', cliSessionId: null }, { id: 'fb3', cliSessionId: null }], 'fb2');
      fakeState.projects = [a, b];
      fakeState.activeProject = a;
      windowState.setDetachedProjectId('B');
      const { view, flushChild } = childView();
      try {
        renderLayout();
        flushRaf();
        flushChild();
        terminal.spawnTerminal.mockClear();

        // Tab mode
        panes.get('fb2')!.spawned = false;
        renderLayout();
        flushRaf();
        expect(terminal.spawnTerminal).not.toHaveBeenCalled();
        flushChild();
        expect(terminal.spawnTerminal).toHaveBeenCalledWith('fb2');

        // Split mode
        terminal.spawnTerminal.mockClear();
        b.layout = { mode: 'split', splitPanes: ['fb2', 'fb3'], splitDirection: 'horizontal' };
        panes.get('fb3')!.spawned = false;
        renderLayout();
        flushRaf();
        expect(terminal.spawnTerminal).not.toHaveBeenCalledWith('fb3');
        flushChild();
        expect(terminal.spawnTerminal).toHaveBeenCalledWith('fb3');
      } finally {
        destroyLayoutView(view);
      }
    });
  });

  it('the inspector column and inspector-open class apply only to the main view', () => {
    vi.mocked(inspector.isInspectorOpen).mockReturnValue(true);
    const a = project('A', [{ id: 'ia1', cliSessionId: null }, { id: 'ia2', cliSessionId: null }], 'ia1');
    a.layout = { mode: 'swarm', splitPanes: ['ia1', 'ia2'], splitDirection: 'horizontal' };
    const b = project('B', [{ id: 'ib1', cliSessionId: null }, { id: 'ib2', cliSessionId: null }], 'ib1');
    b.layout = { mode: 'swarm', splitPanes: ['ib1', 'ib2'], splitDirection: 'horizontal' };
    fakeState.projects = [a, b];
    fakeState.activeProject = a;
    windowState.setDetachedProjectId('B');
    const otherDoc = document.implementation.createHTMLDocument('sessions');
    const container = otherDoc.createElement('div');
    otherDoc.body.appendChild(container);
    const view = createLayoutView('sessions', container);
    try {
      renderLayout();
      expect(mainContainer.classList.contains('inspector-open')).toBe(true);
      expect(mainContainer.style.gridTemplateColumns).toContain('var(--inspector-width');
      expect(container.classList.contains('inspector-open')).toBe(false);
      expect(container.style.gridTemplateColumns).not.toContain('var(--inspector-width');
    } finally {
      destroyLayoutView(view);
      vi.mocked(inspector.isInspectorOpen).mockReturnValue(false);
      a.layout = { mode: 'tabs', splitPanes: [], splitDirection: 'horizontal' };
      renderLayout();
    }
  });

  describe('main view of the detached active project', () => {
    function detachedActive(mainSelection: string | null) {
      const b = project('B', [{ id: 'pb1', cliSessionId: null }, { id: 'pbk', type: 'kanban', cliSessionId: null }], 'pb1');
      fakeState.projects = [b];
      fakeState.activeProject = b;
      windowState.setDetachedProjectId('B');
      windowState.setMainViewSelection(mainSelection);
      renderLayout();
      return b;
    }

    it('with no project-level tab selected shows the placeholder, not "no sessions"', () => {
      detachedActive(null);
      const ph = mainContainer.querySelector('.session-window-placeholder');
      expect(ph).not.toBeNull();
      expect(ph!.textContent).toContain("This project's sessions are open in another window");
      expect(mainContainer.textContent).not.toContain('No sessions');
      // The kanban pane is not shown while nothing is selected.
      expect(panes.get('pbk')?.element.classList.contains('hidden') ?? true).toBe(true);
      // Its CLI session is never laid out in the main window.
      expect(panes.get('pb1')?.element.parentElement ?? null).not.toBe(mainContainer);
    });

    it('placeholder buttons show the sessions window or bring it back', () => {
      detachedActive(null);
      const [show, back] = Array.from(mainContainer.querySelectorAll<HTMLButtonElement>('.session-window-placeholder button'));
      expect(show.textContent).toBe('Show');
      expect(back.textContent).toBe('Bring back');
      show.click();
      expect(sessionWindow.focusSessionWindow).toHaveBeenCalled();
      back.click();
      expect(sessionWindow.closeSessionWindow).toHaveBeenCalled();
    });

    it('a selected project-level tab is shown instead of the placeholder', () => {
      detachedActive('pbk');
      expect(mainContainer.querySelector('.session-window-placeholder')).toBeNull();
      const kb = panes.get('pbk')!.element;
      expect(kb.parentElement).toBe(mainContainer);
      expect(kb.classList.contains('hidden')).toBe(false);
    });

    it('a project with no project-level tabs at all also shows the placeholder', () => {
      const b = project('B', [{ id: 'pb2', cliSessionId: null }], 'pb2');
      fakeState.projects = [b];
      fakeState.activeProject = b;
      windowState.setDetachedProjectId('B');
      renderLayout();
      expect(mainContainer.querySelector('.session-window-placeholder')).not.toBeNull();
      expect(mainContainer.querySelector('.empty-state-cta')).toBeNull();
    });
  });
});
