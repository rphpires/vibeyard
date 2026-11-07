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
import { getDetachedProjectId, runWithCommandSource, viewShowsSession } from './session-window-state.js';
import { isCliSession } from './session-utils.js';
import {
  commandTargetDoc,
  commandTargetProjectId,
  commandTargetSession,
  commandTargetView,
  revealNavTarget,
  runInMainWindow,
  type CommandSource,
} from './reveal.js';

export function initKeybindings(): void {
  // Session commands act on the window they came from: a native-menu click carries its
  // window as `source`; a key press has none and goes by which window has focus (the
  // sessions window forwards its keydown here). See reveal.ts.
  const target = (source?: CommandSource) => ({
    projectId: commandTargetProjectId(source),
    view: commandTargetView(source),
  });
  const newSession = (source?: CommandSource): void => {
    const projectId = commandTargetProjectId(source);
    if (projectId) quickNewSession(projectId, commandTargetDoc(source));
  };
  const closeSession = (source?: CommandSource): void => {
    const projectId = commandTargetProjectId(source);
    const session = commandTargetSession(source);
    if (projectId && session) closeTab(projectId, session.id);
  };
  const cycle = (direction: 1 | -1, source?: CommandSource): void => {
    const { projectId, view } = target(source);
    if (projectId) appState.cycleSession(direction, projectId, view);
  };
  const gotoIndex = (index: number, source?: CommandSource): void => {
    const { projectId, view } = target(source);
    if (projectId) appState.gotoSession(index, projectId, view);
  };
  const toggleSwarm = (source?: CommandSource): void => {
    const { projectId, view } = target(source);
    // The main view of the detached project is always tabs: that layout is the sessions window's.
    if (!projectId || (view === 'main' && projectId === getDetachedProjectId())) return;
    appState.toggleSwarm(projectId);
  };
  // The session inspector panel lives in the main window only.
  const inspector = (source?: CommandSource): void => {
    if (commandTargetView(source) === 'sessions') return;
    const session = commandTargetSession(source);
    if (session) toggleInspector(session.id);
  };
  /** A main-window-only command: run it there, bringing that window forward if needed. */
  const inMain = (fn: () => void) => (source?: CommandSource): void => runInMainWindow(fn, source);

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
  shortcutManager.registerHandler('new-project', () => inMain(promptNewProject)());
  for (let i = 1; i <= 9; i++) {
    shortcutManager.registerHandler(`goto-session-${i}`, () => gotoIndex(i - 1));
  }
  shortcutManager.registerHandler('next-session', () => cycle(1));
  shortcutManager.registerHandler('prev-session', () => cycle(-1));
  shortcutManager.registerHandler('tab-back', () => revealNavTarget(appState.navigateBack()));
  shortcutManager.registerHandler('tab-forward', () => revealNavTarget(appState.navigateForward()));
  shortcutManager.registerHandler('toggle-sidebar', () => inMain(toggleSidebar)());
  shortcutManager.registerHandler('toggle-split', () => toggleSwarm());
  shortcutManager.registerHandler('project-terminal', () => inMain(toggleProjectTerminal)());
  shortcutManager.registerHandler('project-terminal-alt', () => inMain(toggleProjectTerminal)());
  shortcutManager.registerHandler('debug-panel', () => inMain(toggleDebugPanel)());
  shortcutManager.registerHandler('git-panel', () => inMain(toggleGitPanel)());
  shortcutManager.registerHandler('quick-open', () => inMain(showQuickOpen)());
  shortcutManager.registerHandler('session-search', () => inMain(showSessionSearchPalette)());
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
      // across windows, so otherwise the target view's own active CLI tab.
      const focused = getFocusedSessionId();
      const project = appState.projects.find((p) => p.id === commandTargetProjectId());
      const focusedTab = focused ? project?.sessions.find((s) => s.id === focused) : undefined;
      const sessionId = focusedTab && viewShowsSession(commandTargetView(), project!.id, focusedTab)
        ? focusedTab.id
        : isCliSession(session) ? session.id : focused;
      if (sessionId) showSearchBar(sessionId, TerminalSearchBackend(sessionId));
    }
  });
  shortcutManager.registerHandler('goto-line', () => {
    const session = commandTargetSession();
    if (session?.type === 'file-reader') {
      showGoToLineBar(session.id);
    }
  });
  shortcutManager.registerHandler('help', () => inMain(() => showPreferencesModal('help'))());
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
