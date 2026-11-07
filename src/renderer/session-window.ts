/**
 * The sessions window: a second BrowserWindow (`window.open('about:blank', '<SESSION_WINDOW_FRAME>-<n>')`)
 * whose document lives in this renderer's JS context. Every node in it is built and
 * driven from here; panes are *moved* into it (not mirrored), and moved back before
 * it goes away. No PTY is ever touched by opening, swapping or closing it.
 *
 * Load-bearing (see the plan's "Spike result"):
 * - Panes must leave the child document synchronously, on its `pagehide` or before
 *   `close()`: a pane left in a closed document silently loses its WebGL context and
 *   every DOM listener. `sessionWindow.onClosed` is only an idempotent fallback.
 * - Nothing is fitted against the closed window (its devicePixelRatio is 0): panes come
 *   back hidden and renderLayout() decides what the main window shows.
 * - `window.vibeyard`, timers and appState all belong to the main window; the child's
 *   own `requestAnimationFrame` is used for its fits because a hidden main window stops
 *   firing frames.
 * - Nodes of the child are another realm's: no `instanceof HTMLElement` on them.
 */
import { appState } from './state.js';
import { SESSION_WINDOW_FRAME } from '../shared/session-window.js';
import { getDetachedProjectId, runWithCommandSource, setDetachedProjectId, setMainViewSelection } from './session-window-state.js';
import {
  createLayoutView,
  destroyLayoutView,
  evacuateLayoutView,
  renderLayout,
  type LayoutView,
} from './components/split-layout.js';
import {
  buildTabBarDom,
  createTabBarView,
  destroyTabBarView,
  renderTabBars,
  type TabBarView,
} from './components/tab-bar.js';
import { fitAllVisible } from './components/terminal-pane.js';
import { attachFilePrompt } from './components/file-prompt.js';
import { installDocChrome } from './doc-chrome.js';
import { shortcutManager } from './shortcuts.js';
import { t } from './i18n.js';
import {
  focusSessionWindow,
  isHandleAlive,
  setSessionWindowHandle,
} from './session-window-handle.js';

// The light queries live in session-window-handle.ts (no layout imports); re-exported here.
export {
  focusSessionWindow,
  isSessionWindowFocused,
  getSessionWindowDocument,
  isSessionWindowOpen,
} from './session-window-handle.js';

interface OpenWindow {
  win: Window;
  doc: Document;
  root: HTMLElement;
  layout: LayoutView;
  tabBar: TabBarView;
  dispose: () => void;
}

let current: OpenWindow | null = null;
/**
 * True from a teardown until the main process reports that window closed. Until then the
 * main process refuses a new sessions window, and a late `onClosed` would tear down the
 * new one; so an open in that gap waits for `onClosed` (the latest project wins).
 */
let closing = false;
let pendingOpen: string | null = null;
/**
 * Each open uses a fresh frame name: a closing window keeps its name in this renderer
 * even after the main process reports it closed, and `window.open` with that name
 * would hand back the dying window (with a `<webview>` in it, that crashed Electron).
 */
let openCount = 0;

function mainContainer(): HTMLElement {
  return document.getElementById('terminal-container')!;
}

/** Still the window (and document) we built? A closed or re-navigated one is gone. */
function isAlive(w: OpenWindow): boolean {
  return isHandleAlive(w);
}

function setCurrent(w: OpenWindow | null): void {
  current = w;
  setSessionWindowHandle(w);
}

function updateTitle(): void {
  if (!current) return;
  const project = appState.projects.find((p) => p.id === getDetachedProjectId());
  if (!project) return;
  const title = `${project.name} — Vibeyard`;
  if (current.doc.title !== title) current.doc.title = title;
  window.vibeyard.sessionWindow.setTitle(title);
}

/**
 * Put everything back in the main window: panes (hidden) into `#terminal-container`,
 * views unregistered, project re-attached. Idempotent; synchronous.
 */
function teardown(): void {
  const w = current;
  if (!w) return;
  setCurrent(null);
  closing = true;
  evacuateLayoutView(w.layout, mainContainer());
  destroyLayoutView(w.layout);
  destroyTabBarView(w.tabBar);
  w.dispose();
  setDetachedProjectId(null);
  renderLayout();
  renderTabBars();
}

/**
 * Tear down and have the main process close the child. Every teardown that is not the
 * main process reporting the close goes through here: `closing` is only cleared by that
 * report, so a child left open (its document replaced by an about:blank re-navigation)
 * would stay empty and hold every later open in `pendingOpen` forever. Closing an
 * already-closing window is harmless.
 */
function teardownAndClose(): void {
  if (!current) return;
  teardown();
  window.vibeyard.sessionWindow.close();
}

function build(win: Window): OpenWindow {
  const doc = win.document;
  doc.title = 'Vibeyard';
  doc.documentElement.lang = document.documentElement.lang;
  const removeChrome = installDocChrome(doc, document);

  const root = doc.createElement('div');
  root.className = 'session-window';

  const tabBarRoot = buildTabBarDom(doc);
  const back = doc.createElement('button');
  back.className = 'btn-secondary btn-sm session-window-return';
  back.textContent = t('sessionWindow.returnToMain');
  back.addEventListener('click', () => closeSessionWindow());
  const actions = tabBarRoot.querySelector('[id="tab-actions"]') ?? tabBarRoot;
  actions.appendChild(back);

  const panes = doc.createElement('div');
  // The id carries the layout styles (split/swarm grids); className belongs to the
  // layout view, which overwrites it on every render.
  panes.id = 'terminal-container';

  root.append(tabBarRoot, panes);
  doc.body.appendChild(root);

  // Fits run on the child's frames: a hidden/minimized main window stops its own.
  const scheduleFit = (): void => {
    win.requestAnimationFrame(() => { if (isAlive(w)) fitAllVisible(doc); });
  };
  // Shortcuts pressed here act on this window's project (see reveal.ts).
  const onKeydown = (e: KeyboardEvent): void => {
    runWithCommandSource('sessions', () => { shortcutManager.matchEvent(e); });
  };
  // Panes must be out before the document dies (see module docstring).
  const onPagehide = (): void => { if (current === w) teardownAndClose(); };
  win.addEventListener('resize', scheduleFit);
  win.addEventListener('pagehide', onPagehide);
  doc.addEventListener('keydown', onKeydown);
  // Stylesheets load async; the first fit before xterm.css lands measures wrong.
  for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))) {
    link.addEventListener('load', scheduleFit);
  }
  // "Ask AI" on a selection in a file reader / diff pane of this window.
  const detachFilePrompt = attachFilePrompt(doc);

  const w: OpenWindow = {
    win,
    doc,
    root,
    layout: createLayoutView('sessions', panes),
    tabBar: createTabBarView('sessions', tabBarRoot),
    dispose: () => {
      removeChrome();
      win.removeEventListener('resize', scheduleFit);
      win.removeEventListener('pagehide', onPagehide);
      doc.removeEventListener('keydown', onKeydown);
      detachFilePrompt();
    },
  };
  return w;
}

/**
 * Mark `projectId` detached. If its active tab is one the main window keeps (Overview,
 * Kanban, Team), the main view goes on showing it: its selection starts there.
 */
function detach(projectId: string): void {
  setDetachedProjectId(projectId);
  const project = appState.projects.find((p) => p.id === projectId);
  setMainViewSelection(project?.activeSessionId ?? null);
}

/**
 * Show `projectId`'s sessions in the sessions window, opening it if needed. With the
 * window already open on another project, that project's panes go back to the main
 * window (hidden) and this one's move in.
 */
export function openSessionWindow(projectId: string): void {
  if (!appState.projects.some((p) => p.id === projectId)) return;

  if (current && !isAlive(current)) teardownAndClose();

  if (current) {
    if (getDetachedProjectId() !== projectId) {
      evacuateLayoutView(current.layout, mainContainer());
      detach(projectId);
      renderLayout();
      renderTabBars();
    }
    updateTitle();
    focusSessionWindow();
    return;
  }

  if (closing) {
    pendingOpen = projectId;
    return;
  }

  const win = window.open('about:blank', `${SESSION_WINDOW_FRAME}-${++openCount}`);
  if (!win) {
    // The main process refused: a sessions window it still tracks (orphaned, e.g.
    // from before a renderer reload). Close it so the next click opens a fresh one.
    console.warn('[session-window] window.open refused; closing a stale sessions window');
    window.vibeyard.sessionWindow.close();
    return;
  }

  setCurrent(build(win));
  detach(projectId);
  renderLayout();
  renderTabBars();
  updateTitle();
}

/** Bring the sessions window back into the main window. Idempotent. */
export function closeSessionWindow(): void {
  pendingOpen = null;
  // Panes out first, while the child document is still alive.
  teardownAndClose();
}

export function initSessionWindow(): void {
  // Fallback for a close that skipped pagehide (or a main-process close): idempotent.
  window.vibeyard.sessionWindow.onClosed(() => {
    teardown();
    closing = false;
    const projectId = pendingOpen;
    pendingOpen = null;
    if (projectId) openSessionWindow(projectId);
  });

  appState.on('project-removed', (id) => {
    if (current && id === getDetachedProjectId()) closeSessionWindow();
  });
  // Renames arrive as project-changed.
  appState.on('project-changed', () => updateTitle());

  // A reload of the main renderer would orphan the child (its DOM is driven from here).
  window.addEventListener('beforeunload', () => closeSessionWindow());
}
