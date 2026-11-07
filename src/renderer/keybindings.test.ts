// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shortcut and native-menu routing with A active in the main window and B detached
// into the sessions window (Review Focus 3): session commands act on the window the
// key/menu came from; main-only commands bring the main window forward first.

const h = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {};
  const menu: Record<string, (...a: unknown[]) => void> = {};
  const fakeState = {
    projects: [] as Array<Record<string, any>>,
    activeProjectId: 'A' as string | null,
    get activeProject() { return this.projects.find((p) => p.id === this.activeProjectId); },
    get activeSession() {
      const p = this.activeProject;
      return p?.sessions.find((s: { id: string }) => s.id === p.activeSessionId);
    },
    cycleSession: vi.fn(),
    gotoSession: vi.fn(),
    toggleSwarm: vi.fn(),
    navigateBack: vi.fn((): { projectId: string; sessionId: string } | undefined => undefined),
    navigateForward: vi.fn((): { projectId: string; sessionId: string } | undefined => undefined),
    setActiveProject: vi.fn(),
    setActiveSession: vi.fn(),
  };
  return {
    handlers,
    menu,
    fakeState,
    sw: {
      isSessionWindowFocused: vi.fn(() => false),
      getSessionWindowDocument: vi.fn((): Document | null => null),
      focusSessionWindow: vi.fn(),
      closeSessionWindow: vi.fn(),
    },
    quickNewSession: vi.fn(),
    closeTab: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleInspector: vi.fn(),
    reload: vi.fn(),
    showSearchBar: vi.fn(),
    getActiveShellSessionId: vi.fn((): string | null => null),
    getFocusedSessionId: vi.fn((): string | null => null),
  };
});

vi.mock('./state.js', () => ({ appState: h.fakeState }));
vi.mock('./session-window.js', () => h.sw);
vi.mock('./session-close.js', () => ({ closeTab: h.closeTab }));
vi.mock('./components/sidebar.js', () => ({ promptNewProject: vi.fn(), toggleSidebar: h.toggleSidebar, toggleGitPanel: vi.fn() }));
vi.mock('./components/tab-bar.js', () => ({ quickNewSession: h.quickNewSession }));
vi.mock('./components/project-terminal.js', () => ({ toggleProjectTerminal: vi.fn(), getActiveShellSessionId: h.getActiveShellSessionId }));
vi.mock('./components/debug-panel.js', () => ({ toggleDebugPanel: vi.fn() }));
vi.mock('./components/preferences-modal.js', () => ({ showPreferencesModal: vi.fn() }));
vi.mock('./components/terminal-pane.js', () => ({ getFocusedSessionId: h.getFocusedSessionId }));
vi.mock('./components/search-bar.js', () => ({ showSearchBar: h.showSearchBar, TerminalSearchBackend: vi.fn(), ShellTerminalSearchBackend: vi.fn() }));
vi.mock('./components/quick-open.js', () => ({ showQuickOpen: vi.fn() }));
vi.mock('./components/session-search-palette.js', () => ({ showSessionSearchPalette: vi.fn() }));
vi.mock('./shortcuts.js', () => ({
  shortcutManager: {
    registerHandler: vi.fn((id: string, fn: () => void) => { h.handlers[id] = fn; }),
    matchEvent: vi.fn(),
  },
}));
vi.mock('./components/file-reader.js', () => ({ getFileReaderInstance: vi.fn(), getFileReaderTextSelector: vi.fn(), showGoToLineBar: vi.fn() }));
vi.mock('./components/file-viewer.js', () => ({ getFileViewerInstance: vi.fn() }));
vi.mock('./components/dom-search-backend.js', () => ({ DomSearchBackend: vi.fn() }));
vi.mock('./components/session-inspector.js', () => ({ toggleInspector: h.toggleInspector }));
vi.mock('./zoom.js', () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), zoomReset: vi.fn() }));
vi.mock('./components/browser-tab/instance.js', () => ({
  getBrowserTabInstance: vi.fn(() => ({ webview: { reload: h.reload, reloadIgnoringCache: vi.fn() } })),
}));

const menuApi = new Proxy({}, {
  get: (_t, name: string) => (cb: (...a: unknown[]) => void) => { h.menu[name] = cb; return () => {}; },
});
(window as unknown as { vibeyard: unknown }).vibeyard = { menu: menuApi };

const ws = await import('./session-window-state.js');
const shortcutsModule = await import('./shortcuts.js');
const { initKeybindings } = await import('./keybindings.js');
initKeybindings();

const child = document.implementation.createHTMLDocument('sessions');

beforeEach(() => {
  vi.clearAllMocks();
  ws._resetForTesting();
  h.fakeState.projects = [
    { id: 'A', sessions: [{ id: 'a1' }], activeSessionId: 'a1', layout: { mode: 'tabs' } },
    {
      id: 'B',
      sessions: [{ id: 'kb', type: 'kanban' }, { id: 'b1' }, { id: 'web', type: 'browser-tab' }],
      activeSessionId: 'b1',
      layout: { mode: 'tabs' },
    },
  ];
  h.fakeState.activeProjectId = 'A';
  ws.setDetachedProjectId('B');
  h.sw.getSessionWindowDocument.mockReturnValue(child);
  h.sw.isSessionWindowFocused.mockReturnValue(false);
});

describe('keyboard shortcuts', () => {
  it('from the sessions window, session commands act on the detached project', () => {
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    h.handlers['new-session']();
    expect(h.quickNewSession).toHaveBeenCalledWith('B', child);
    h.handlers['close-session']();
    expect(h.closeTab).toHaveBeenCalledWith('B', 'b1');
    h.handlers['next-session']();
    expect(h.fakeState.cycleSession).toHaveBeenCalledWith(1, 'B', 'sessions');
    h.handlers['goto-session-2']();
    expect(h.fakeState.gotoSession).toHaveBeenCalledWith(1, 'B', 'sessions');
    h.handlers['toggle-split']();
    expect(h.fakeState.toggleSwarm).toHaveBeenCalledWith('B');
  });

  it('from the main window, session commands act on the active project', () => {
    h.handlers['new-session']();
    expect(h.quickNewSession).toHaveBeenCalledWith('A', document);
    h.handlers['close-session']();
    expect(h.closeTab).toHaveBeenCalledWith('A', 'a1');
    h.handlers['prev-session']();
    expect(h.fakeState.cycleSession).toHaveBeenCalledWith(-1, 'A', 'main');
  });

  it('main view of the detached active project: Ctrl+W closes only its own selected tab', () => {
    h.fakeState.activeProjectId = 'B';
    h.handlers['close-session']();
    expect(h.closeTab).not.toHaveBeenCalled();
    ws.setMainViewSelection('kb');
    h.handlers['close-session']();
    expect(h.closeTab).toHaveBeenCalledWith('B', 'kb');
  });

  it('main view of the detached active project never toggles the sessions window\'s layout', () => {
    h.fakeState.activeProjectId = 'B';
    h.handlers['toggle-split']();
    expect(h.fakeState.toggleSwarm).not.toHaveBeenCalled();
  });

  it('browser reload from the sessions window reloads the detached project\'s browser tab', () => {
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    h.fakeState.projects[1].activeSessionId = 'web';
    h.handlers['browser-reload']();
    expect(h.reload).toHaveBeenCalled();
  });

  it('a main-only shortcut from the sessions window focuses the main window and runs there', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    h.handlers['toggle-sidebar']();
    expect(focus).toHaveBeenCalled();
    expect(h.toggleSidebar).toHaveBeenCalled();
    focus.mockClear();
    h.sw.isSessionWindowFocused.mockReturnValue(false);
    h.handlers['toggle-sidebar']();
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('the inspector shortcut does nothing from the sessions window (the panel lives in main)', () => {
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    h.handlers['toggle-inspector']();
    expect(h.toggleInspector).not.toHaveBeenCalled();
    h.sw.isSessionWindowFocused.mockReturnValue(false);
    h.handlers['toggle-inspector']();
    expect(h.toggleInspector).toHaveBeenCalledWith('a1');
  });
});

describe('Back/Forward', () => {
  it('a step onto a sessions-window tab brings that window forward', () => {
    h.fakeState.navigateBack.mockReturnValueOnce({ projectId: 'B', sessionId: 'b1' });
    h.handlers['tab-back']();
    expect(h.sw.focusSessionWindow).toHaveBeenCalled();
  });

  it('a step onto a main-window tab does not', () => {
    h.fakeState.navigateForward.mockReturnValueOnce({ projectId: 'A', sessionId: 'a1' });
    h.handlers['tab-forward']();
    expect(h.sw.focusSessionWindow).not.toHaveBeenCalled();
  });
});

describe('find in terminal', () => {
  function focusedShellPanel(): () => void {
    const panel = document.createElement('div');
    panel.id = 'project-terminal-panel';
    const input = document.createElement('textarea');
    panel.appendChild(input);
    document.body.appendChild(panel);
    input.focus();
    h.getActiveShellSessionId.mockReturnValue('shell1');
    return () => { panel.remove(); h.getActiveShellSessionId.mockReturnValue(null); };
  }

  it('from the sessions window, never the main window project shell (its focus is stale there)', () => {
    const cleanup = focusedShellPanel();
    try {
      h.sw.isSessionWindowFocused.mockReturnValue(true);
      h.handlers['find-in-terminal']();
      expect(h.showSearchBar).toHaveBeenCalledTimes(1);
      expect(h.showSearchBar.mock.calls[0][0]).toBe('b1');
    } finally { cleanup(); }
  });

  it('from the main window, the focused project shell still wins', () => {
    const cleanup = focusedShellPanel();
    try {
      h.handlers['find-in-terminal']();
      expect(h.showSearchBar.mock.calls[0][0]).toBe('shell1');
    } finally { cleanup(); }
  });

  it('prefers the target view CLI tab over the global focused pane', () => {
    h.getFocusedSessionId.mockReturnValue('a1'); // stale: focus was last set in the main window
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    h.handlers['find-in-terminal']();
    expect(h.showSearchBar.mock.calls[0][0]).toBe('b1');
    h.getFocusedSessionId.mockReturnValue(null);
  });
});

describe('a key press knows its window', () => {
  it('a keydown in the main document acts on the main window even if the sessions window claims focus', () => {
    // Under some focus states both documents report hasFocus(); the event's document decides.
    h.sw.isSessionWindowFocused.mockReturnValue(true);
    vi.mocked(shortcutsModule.shortcutManager.matchEvent).mockImplementationOnce(() => {
      h.handlers['new-session']();
      return true;
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true }));
    expect(h.quickNewSession).toHaveBeenCalledWith('A', document);
  });
});

describe('native menu', () => {
  it('routes by the source window the click came from', () => {
    h.menu.onNewSession('sessions');
    expect(h.quickNewSession).toHaveBeenLastCalledWith('B', child);
    h.menu.onNewSession('main');
    expect(h.quickNewSession).toHaveBeenLastCalledWith('A', document);
    h.menu.onGotoSession(0, 'sessions');
    expect(h.fakeState.gotoSession).toHaveBeenCalledWith(0, 'B', 'sessions');
    h.menu.onCloseSession('sessions');
    expect(h.closeTab).toHaveBeenCalledWith('B', 'b1');
    h.menu.onToggleSplit('sessions');
    expect(h.fakeState.toggleSwarm).toHaveBeenCalledWith('B');
  });

  it('a main-only menu item from the sessions window focuses the main window', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    h.menu.onNewProject('sessions');
    expect(focus).toHaveBeenCalled();
    focus.mockRestore();
  });
});
