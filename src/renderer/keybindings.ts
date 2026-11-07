import { appState } from './state.js';
import { closeTab } from './session-close.js';
import { promptNewProject, toggleSidebar, toggleGitPanel } from './components/sidebar.js';
import { quickNewSession } from './components/tab-bar.js';
import { toggleProjectTerminal } from './components/project-terminal.js';
import { toggleDebugPanel } from './components/debug-panel.js';
import { showPreferencesModal } from './components/preferences-modal.js';
import { getFocusedSessionId } from './components/terminal-pane.js';
import { showSearchBar, TerminalSearchBackend, ShellTerminalSearchBackend } from './components/search-bar.js';
import { getActiveShellSessionId } from './components/project-terminal.js';
import { showQuickOpen } from './components/quick-open.js';
import { showSessionSearchPalette } from './components/session-search-palette.js';
import { shortcutManager } from './shortcuts.js';
import { getFileReaderInstance, getFileReaderTextSelector, showGoToLineBar } from './components/file-reader.js';
import { getFileViewerInstance } from './components/file-viewer.js';
import { DomSearchBackend } from './components/dom-search-backend.js';
import { toggleInspector } from './components/session-inspector.js';
import { zoomIn, zoomOut, zoomReset } from './zoom.js';
import { getBrowserTabInstance } from './components/browser-tab/instance.js';
import { runWithCommandSource, viewOwnsLayout, viewShowsSession, type ViewKind } from './session-window-state.js';
import { isCliSession } from './session-utils.js';
import {
  commandTargetDoc,
  commandTargetProjectId,
  commandTargetSession,
  commandTargetView,
  revealNavTarget,
  runInMainWindow,
} from './reveal.js';

export function initKeybindings(): void {
  // Session commands act on the window they came from: a native-menu click carries its
  // window as `source`; a key press has none and goes by which window has focus (the
  // sessions window forwards its keydown here). See reveal.ts.
  const target = (source?: ViewKind) => ({
    projectId: commandTargetProjectId(source),
    view: commandTargetView(source),
  });
  const newSession = (source?: ViewKind): void => {
    const projectId = commandTargetProjectId(source);
    if (projectId) quickNewSession(projectId, commandTargetDoc(source));
  };
  const closeSession = (source?: ViewKind): void => {
    const projectId = commandTargetProjectId(source);
    const session = commandTargetSession(source);
    if (projectId && session) closeTab(projectId, session.id);
  };
  const cycle = (direction: 1 | -1, source?: ViewKind): void => {
    const { projectId, view } = target(source);
    if (projectId) appState.cycleSession(direction, projectId, view);
  };
  const gotoIndex = (index: number, source?: ViewKind): void => {
    const { projectId, view } = target(source);
    if (projectId) appState.gotoSession(index, projectId, view);
  };
  const toggleSwarm = (source?: ViewKind): void => {
    const { projectId, view } = target(source);
    if (!projectId || !viewOwnsLayout(view, projectId)) return;
    appState.toggleSwarm(projectId);
  };
  // The session inspector panel lives in the main window only.
  const inspector = (source?: ViewKind): void => {
    if (commandTargetView(source) === 'sessions') return;
    const session = commandTargetSession(source);
    if (session) toggleInspector(session.id);
  };
  /** A main-window-only command: run it there, bringing that window forward if needed. */
  const inMain = (fn: () => void) => (source?: ViewKind): void => runInMainWindow(fn, source);

  // Menu IPC listeners — handle clicks on Electron menu items.
  // Accelerators are display-only (registerAccelerator: false), so these
  // only fire on actual menu clicks, not keyboard shortcuts.
  window.vibeyard.menu.onNewProject(inMain(promptNewProject));
  window.vibeyard.menu.onNewSession((source) => newSession(source));
  window.vibeyard.menu.onToggleSplit((source) => toggleSwarm(source));
  window.vibeyard.menu.onNextSession((source) => cycle(1, source));
  window.vibeyard.menu.onPrevSession((source) => cycle(-1, source));
  window.vibeyard.menu.onGotoSession((index, source) => gotoIndex(index, source));
  window.vibeyard.menu.onToggleDebug(inMain(toggleDebugPanel));
  window.vibeyard.menu.onToggleInspector((source) => inspector(source));
  window.vibeyard.menu.onCloseSession((source) => closeSession(source));

  // Register shortcut handlers — the single authority for keyboard shortcuts.
  shortcutManager.registerHandler('new-session', () => newSession());
  shortcutManager.registerHandler('new-session-alt', () => newSession());
  shortcutManager.registerHandler('new-project', () => runInMainWindow(promptNewProject));
  for (let i = 1; i <= 9; i++) {
    shortcutManager.registerHandler(`goto-session-${i}`, () => gotoIndex(i - 1));
  }
  shortcutManager.registerHandler('next-session', () => cycle(1));
  shortcutManager.registerHandler('prev-session', () => cycle(-1));
  shortcutManager.registerHandler('tab-back', () => revealNavTarget(appState.navigateBack()));
  shortcutManager.registerHandler('tab-forward', () => revealNavTarget(appState.navigateForward()));
  shortcutManager.registerHandler('toggle-sidebar', () => runInMainWindow(toggleSidebar));
  shortcutManager.registerHandler('toggle-split', () => toggleSwarm());
  shortcutManager.registerHandler('project-terminal', () => runInMainWindow(toggleProjectTerminal));
  shortcutManager.registerHandler('project-terminal-alt', () => runInMainWindow(toggleProjectTerminal));
  shortcutManager.registerHandler('debug-panel', () => runInMainWindow(toggleDebugPanel));
  shortcutManager.registerHandler('git-panel', () => runInMainWindow(toggleGitPanel));
  shortcutManager.registerHandler('quick-open', () => runInMainWindow(showQuickOpen));
  shortcutManager.registerHandler('session-search', () => runInMainWindow(showSessionSearchPalette));
  shortcutManager.registerHandler('find-in-terminal', () => {
    // The project shell lives in the main window. Its document keeps an activeElement
    // after the sessions window takes focus, so only a key pressed in main counts.
    const shellPanel = document.getElementById('project-terminal-panel');
    if (commandTargetView() === 'main' && shellPanel && !shellPanel.classList.contains('hidden') &&
        shellPanel.contains(document.activeElement)) {
      const shellSessionId = getActiveShellSessionId();
      if (shellSessionId) {
        showSearchBar(shellSessionId, ShellTerminalSearchBackend(shellSessionId));
        return;
      }
    }

    const session = commandTargetSession();
    if (!session) return;

    if (session.type === 'file-reader') {
      const instance = getFileReaderInstance(session.id);
      if (!instance) return;
      const body = instance.element.querySelector('.file-reader-body') as HTMLElement;
      if (!body) return;
      showSearchBar(session.id, new DomSearchBackend(body, getFileReaderTextSelector(session.id)));
    } else if (session.type === 'diff-viewer') {
      const instance = getFileViewerInstance(session.id);
      if (!instance) return;
      const body = instance.element.querySelector('.file-viewer-body') as HTMLElement;
      if (!body) return;
      showSearchBar(session.id, new DomSearchBackend(body, '.diff-line'));
    } else {
      // The focused pane (split/swarm) when it belongs to the target view; it is global
      // across windows, so otherwise the target view's own active CLI tab (and nothing
      // when that tab is not a terminal: a focused pane outside the view is the other window's).
      const focused = getFocusedSessionId();
      const found = focused ? appState.findSessionWithProject(focused) : undefined;
      const focusedInView = found?.project.id === commandTargetProjectId() &&
        viewShowsSession(commandTargetView(), found.project.id, found.session);
      const sessionId = focusedInView ? found!.session.id : isCliSession(session) ? session.id : undefined;
      if (sessionId) showSearchBar(sessionId, TerminalSearchBackend(sessionId));
    }
  });
  shortcutManager.registerHandler('goto-line', () => {
    const session = commandTargetSession();
    if (session?.type === 'file-reader') {
      showGoToLineBar(session.id);
    }
  });
  shortcutManager.registerHandler('help', () => runInMainWindow(() => showPreferencesModal('help')));
  shortcutManager.registerHandler('close-session', () => closeSession());
  shortcutManager.registerHandler('toggle-inspector', () => inspector());
  shortcutManager.registerHandler('zoom-in', zoomIn);
  shortcutManager.registerHandler('zoom-out', zoomOut);
  shortcutManager.registerHandler('zoom-reset', zoomReset);
  shortcutManager.registerHandler('browser-reload', () => {
    const session = commandTargetSession();
    if (session?.type !== 'browser-tab') return;
    getBrowserTabInstance(session.id)?.webview.reload();
  });
  shortcutManager.registerHandler('browser-hard-reload', () => {
    const session = commandTargetSession();
    if (session?.type !== 'browser-tab') return;
    getBrowserTabInstance(session.id)?.webview.reloadIgnoringCache();
  });

  document.addEventListener('keydown', (e) => {
    runWithCommandSource('main', () => { shortcutManager.matchEvent(e); });
  });
}
