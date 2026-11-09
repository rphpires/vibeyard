import { appState, ProjectRecord, SessionRecord } from '../state.js';
import { isUnread, onChange as onUnreadChange } from '../session-unread.js';
import type { ProviderId } from '../../shared/types.js';

/** Config dir for a session's pinned profile (provider-matched), or undefined for default ~/.claude. */
function sessionConfigDir(session: { profileId?: string }, providerId: ProviderId): string | undefined {
  if (!session.profileId) return undefined;
  return appState.profiles.find((p) => p.id === session.profileId && p.providerId === providerId)?.configDir;
}
import {
  createTerminalPane,
  attachToContainer,
  showPane,
  hideAllPanes,
  fitAllVisible,
  setFocused,
  spawnTerminal,
  setPendingPrompt,
  setPendingSystemPrompt,
  setPendingCliName,
  destroyTerminal,
  getTerminalInstance,
  reloadWebgl,
} from './terminal-pane.js';
import {
  createInspectorPane,
  destroyInspectorPane,
  showInspectorPane,
  hideAllInspectorPanes,
  attachInspectorToContainer,
  getInspectorInstance,
  disconnectInspector,
} from './mcp-inspector.js';
import { isInspectorOpen } from './session-inspector.js';
import { requestFrameIn } from '../frame.js';
import {
  createFileViewerPane,
  destroyFileViewerPane,
  showFileViewerPane,
  hideAllFileViewerPanes,
  attachFileViewerToContainer,
  getFileViewerInstance,
} from './file-viewer.js';
import {
  createFileReaderPane,
  destroyFileReaderPane,
  showFileReaderPane,
  hideAllFileReaderPanes,
  attachFileReaderToContainer,
  getFileReaderInstance,
  setFileReaderLine,
} from './file-reader.js';
import {
  getRemoteTerminalInstance,
  destroyRemoteTerminal,
  attachRemoteToContainer,
  showRemotePane,
  hideAllRemotePanes,
} from './remote-terminal-pane.js';
import {
  createBrowserTabPane,
  destroyBrowserTabPane,
  showBrowserTabPane,
  hideAllBrowserTabPanes,
  attachBrowserTabToContainer,
  getBrowserTabInstance,
} from './browser-tab-pane.js';
import {
  createProjectTabPane,
  destroyProjectTabPane,
  showProjectTabPane,
  hideAllProjectTabPanes,
  attachProjectTabToContainer,
  getProjectTabInstance,
} from './project-tab/pane.js';
import {
  createKanbanPane,
  destroyKanbanPane,
  showKanbanPane,
  hideAllKanbanPanes,
  attachKanbanToContainer,
  getKanbanInstance,
} from './kanban/pane.js';
import {
  createTeamPane,
  destroyTeamPane,
  showTeamPane,
  hideAllTeamPanes,
  attachTeamToContainer,
  getTeamInstance,
} from './team/pane.js';
import { quickNewSession } from './tab-bar.js';
import { isCliSession, sessionLocation } from '../session-utils.js';
import { isInRelativeOrder } from './pane-order.js';
import { shouldFocusPane, type PaneFocusMemo } from './pane-focus.js';
import {
  projectForViewKind,
  viewActiveSessionId,
  viewOwnsLayout,
  viewShowsSession,
  viewTabs,
  type ViewKind,
} from '../session-window-state.js';
import { closeSessionWindow, focusSessionWindow } from '../session-window.js';
import { t } from '../i18n.js';

/**
 * One place sessions are laid out: the main window's `#terminal-container`, or the
 * sessions window's container (a second document in this same JS context). Pane
 * registries stay global per session id; a view only decides which container a
 * pane is attached to, and touches nothing outside its own container.
 */
export interface LayoutView {
  kind: ViewKind;
  container: HTMLElement;
  doc: Document;
}

interface ViewState {
  lastFocusedPane: PaneFocusMemo | null;
  onMouseDown: (e: MouseEvent) => void;
}

const views = new Set<LayoutView>();
const viewStates = new WeakMap<LayoutView, ViewState>();

/** Register a view on `container` (its document is the container's). It is laid out by every renderLayout(). */
export function createLayoutView(kind: ViewKind, container: HTMLElement): LayoutView {
  const view: LayoutView = { kind, container, doc: container.ownerDocument };

  // Click delegation for swarm mode: clicking a dimmed pane makes it active
  const onMouseDown = (e: MouseEvent): void => {
    const project = projectForView(view);
    if (!project || layoutModeFor(view, project) !== 'swarm') return;

    const paneEl = (e.target as HTMLElement).closest('.terminal-pane') as HTMLElement | null;
    if (!paneEl) return;

    const sessionId = paneEl.dataset.sessionId;
    if (sessionId && sessionId !== project.activeSessionId) {
      appState.setActiveSession(project.id, sessionId);
    }
  };
  container.addEventListener('mousedown', onMouseDown);

  viewStates.set(view, { lastFocusedPane: null, onMouseDown });
  views.add(view);
  return view;
}

/** Unregister a view. Its panes are left where they are; whoever owns them re-homes them. */
export function destroyLayoutView(view: LayoutView): void {
  const state = viewStates.get(view);
  if (state) view.container.removeEventListener('mousedown', state.onMouseDown);
  viewStates.delete(view);
  views.delete(view);
}

/**
 * Move every pane laid out in `view` into `target`, hidden — the sessions window is
 * closing (or swapping projects) and its panes must not stay in a document that goes
 * away: a closed document silently loses the WebGL context and every DOM listener on
 * the pane. Goes through the attach* helpers so xterm is re-opened in `target`'s
 * document. Synchronous on purpose (callers run it from `pagehide`); never fits —
 * the panes are hidden, and renderLayout() decides what the main window shows.
 */
export function evacuateLayoutView(view: LayoutView, target: HTMLElement): void {
  hideViewPanes(view);
  // Only the project this view shows has panes in it.
  for (const session of projectForView(view)?.sessions ?? []) {
    const el = paneElementFor(session);
    if (!el || !view.container.contains(el)) continue;
    // Attach only (no show*): the pane stays hidden as hideViewPanes left it.
    (paneAttachFor[session.type ?? ''] ?? attachToContainer)(session.id, target);
    if (isCliSession(session)) reloadWebgl(session.id);
  }
  removeSwarmWrapper(view);
  removeEmptyState(view);
  view.container.querySelectorAll('.swarm-empty-cell').forEach((el) => el.remove());
  const state = viewStates.get(view);
  if (state) state.lastFocusedPane = null;
}

/** The project a view shows right now. */
function projectForView(view: LayoutView): ProjectRecord | undefined {
  return projectForViewKind(view.kind, appState);
}

/** `project.layout` belongs to the view with its sessions; the main view of a detached project is always tabs. */
function layoutModeFor(view: LayoutView, project: ProjectRecord): ProjectRecord['layout']['mode'] {
  return viewOwnsLayout(view.kind, project.id) ? project.layout.mode : 'tabs';
}

/** What one renderView() works from. */
interface ViewRender {
  view: LayoutView;
  project: ProjectRecord;
  /** The view's tabs (`viewTabs`), in tab order. */
  tabs: SessionRecord[];
  /** The split/swarm panes this view shows, in order. */
  panes: string[];
}

/** Split/swarm pane ids this view shows (an id with no session is kept, as before: its attach is a no-op). */
function panesForView(view: LayoutView, project: ProjectRecord): string[] {
  return project.layout.splitPanes.filter((id) => {
    const session = project.sessions.find((s) => s.id === id);
    return !session || viewShowsSession(view.kind, project.id, session);
  });
}

/** The inspector panel lives only in the main window; the sessions view never makes room for it. */
function inspectorOpenFor(view: LayoutView): boolean {
  return view.kind === 'main' && isInspectorOpen();
}

/** Set the container's layout class while preserving the inspector-open class if active. */
function setContainerClass(view: LayoutView, cls: string): void {
  const hasInspector = inspectorOpenFor(view);
  view.container.className = cls;
  if (hasInspector) view.container.classList.add('inspector-open');
}

const paneInstanceFor: Record<string, (id: string) => { element: HTMLElement } | undefined> = {
  'file-reader': getFileReaderInstance,
  'diff-viewer': getFileViewerInstance,
  'mcp-inspector': getInspectorInstance,
  'remote-terminal': getRemoteTerminalInstance,
  'browser-tab': getBrowserTabInstance,
  'project-tab': getProjectTabInstance,
  kanban: getKanbanInstance,
  team: getTeamInstance,
};

const paneAttachFor: Record<string, (id: string, container: HTMLElement) => void> = {
  'file-reader': attachFileReaderToContainer,
  'diff-viewer': attachFileViewerToContainer,
  'mcp-inspector': attachInspectorToContainer,
  'remote-terminal': attachRemoteToContainer,
  'browser-tab': attachBrowserTabToContainer,
  'project-tab': attachProjectTabToContainer,
  kanban: attachKanbanToContainer,
  team: attachTeamToContainer,
};

/** The pane element backing a session, whatever its type, once it has been created. */
function paneElementFor(session: { id: string; type?: string }): HTMLElement | undefined {
  return (paneInstanceFor[session.type ?? ''] ?? getTerminalInstance)(session.id)?.element;
}

/**
 * Lay `els` out inside `target` in that order — but only when they are not already
 * in it. `appendChild` on a node that is already a child removes and re-inserts it,
 * which blurs whatever is focused inside and collapses an in-progress selection, so
 * every attach* helper leaves a placed pane alone and ordering is corrected here.
 *
 * Only *relative* order is compared: hidden panes stay in the container interleaved
 * with the laid-out ones. Entries that are missing, or that a caller re-homed
 * elsewhere afterwards, are dropped — keeping one would fail the check forever and
 * re-append every pane on every render.
 */
function ensurePaneOrder(target: HTMLElement, els: readonly (HTMLElement | null | undefined)[]): void {
  const wanted = els.filter((el): el is HTMLElement => !!el && el.parentElement === target);
  if (isInRelativeOrder(Array.from(target.children), wanted)) return;
  for (const el of wanted) target.appendChild(el);
}

/**
 * Drop the swarm grid wrapper, leaving its panes detached — callers re-attach
 * whatever must be visible, and a hidden pane is re-homed the next time it is shown.
 */
function removeSwarmWrapper(view: LayoutView): void {
  view.container.querySelector('.swarm-grid-wrapper')?.remove();
}

/**
 * Hide every pane inside this view's container — never another view's. With a single
 * view registered (no sessions window) every pane is its own: hide them all without
 * a contains() walk per pane.
 */
function hideViewPanes(view: LayoutView): void {
  const within = views.size > 1 ? view.container : undefined;
  hideAllPanes(within);
  hideAllInspectorPanes(within);
  hideAllFileViewerPanes(within);
  hideAllFileReaderPanes(within);
  hideAllRemotePanes(within);
  hideAllBrowserTabPanes(within);
  hideAllProjectTabPanes(within);
  hideAllKanbanPanes(within);
  hideAllTeamPanes(within);
}

/** Move DOM focus into a pane, if this render is one that has any business doing so. */
function focusPane(view: LayoutView, project: ProjectRecord, sessionId: string): void {
  const doc = view.doc;
  // Don't steal focus from an active tab rename input
  if (doc.querySelector('#tab-list .tab-name input')) return;

  const state = viewStates.get(view);
  if (!state) return;
  const activeEl = doc.activeElement;
  const target: PaneFocusMemo = { projectId: project.id, sessionId };
  if (!shouldFocusPane(state.lastFocusedPane, target, !activeEl || activeEl === doc.body)) return;

  state.lastFocusedPane = target;
  setFocused(sessionId);
}

export function initSplitLayout(): void {
  createLayoutView('main', document.getElementById('terminal-container')!);

  appState.on('state-loaded', renderLayout);
  appState.on('project-changed', renderLayout);
  appState.on('session-added', onSessionAdded);
  appState.on('session-removed', onSessionRemoved);
  appState.on('session-changed', renderLayout);
  appState.on('layout-changed', renderLayout);

  onUnreadChange(() => {
    for (const view of views) {
      const project = projectForView(view);
      if (project && layoutModeFor(view, project) === 'swarm') {
        updateSwarmPaneStyles(project, panesForView(view, project));
      }
    }
  });

  // Refit on window resize (the main window; the sessions window wires its own)
  window.addEventListener('resize', () => {
    requestAnimationFrame(() => fitAllVisible(document));
  });
}

function onSessionAdded(data: unknown): void {
  const { projectId, session } = data as { projectId: string; session: { id: string; type?: string; cliSessionId: string | null; providerId?: string; args?: string; envVars?: string; profileId?: string; cwd?: string; diffFilePath?: string; diffArea?: string; worktreePath?: string; fileReaderPath?: string; fileReaderLine?: number; browserTabUrl?: string; sshHost?: string; runPath?: string } };
  // Resolve the session's own project, not the active one: external control
  // (vibeyard-ctl new-session) adds sessions to projects that are not in focus,
  // and the pane must get that project's cwd/id and its pending prompt.
  const project = appState.getProject(projectId);
  if (!project) return;
  // Only projects some view shows are laid out. A pane for a background project is
  // created hidden and detached; renderLayout attaches it when the project is shown.
  const showing = [...views].filter((v) => projectForView(v)?.id === project.id);
  const relayout = (): void => { for (const view of showing) renderView(view); };

  if (session.type === 'file-reader') {
    createFileReaderPane(session.id, session.fileReaderPath || '', session.fileReaderLine);
    relayout();
  } else if (session.type === 'diff-viewer') {
    createFileViewerPane(session.id, session.diffFilePath || '', session.diffArea || '', session.worktreePath);
    relayout();
  } else if (session.type === 'mcp-inspector') {
    createInspectorPane(session.id);
    relayout();
  } else if (session.type === 'remote-terminal') {
    // Remote terminal pane is created by share-manager before session-added fires
    relayout();
  } else if (session.type === 'browser-tab') {
    createBrowserTabPane(session.id, session.browserTabUrl);
    relayout();
  } else if (session.type === 'project-tab') {
    createProjectTabPane(session.id, projectId);
    relayout();
  } else if (session.type === 'kanban') {
    createKanbanPane(session.id, projectId);
    relayout();
  } else if (session.type === 'team') {
    createTeamPane(session.id, projectId);
    relayout();
  } else {
    // Create and spawn immediately
    const cliProviderId = (session.providerId as ProviderId) || 'claude';
    const configDir = sessionConfigDir(session, cliProviderId);
    const loc = sessionLocation(project, session);
    createTerminalPane(session.id, loc.cwd, session.cliSessionId, !!session.cliSessionId, session.args || '', cliProviderId, project.id, session.envVars || '', configDir, loc.host);
    const pending = appState.consumePendingInitialPrompt(project.id, session.id);
    if (pending) {
      setPendingPrompt(session.id, pending);
    }
    const pendingSys = appState.consumePendingSystemPrompt(project.id, session.id);
    if (pendingSys) {
      setPendingSystemPrompt(session.id, pendingSys);
    }
    const pendingCliName = appState.consumePendingCliName(project.id, session.id);
    if (pendingCliName) {
      setPendingCliName(session.id, pendingCliName);
    }
    relayout();

    // Spawn after layout is rendered so terminal has dimensions. A background
    // project's pane spawns too (the prompt is a startup arg, so the agent
    // starts working now); it is fitted when its project is first shown.
    // On the frame of the window showing it: main's frames stop while main is
    // minimized or covered, and the sessions window must not wait on them.
    const shownIn = showing.find((v) => viewShowsSession(v.kind, project.id, session as SessionRecord));
    requestFrameIn(shownIn?.doc ?? document, () => {
      spawnTerminal(session.id);
      for (const view of showing) {
        if (viewShowsSession(view.kind, project.id, session as SessionRecord)) fitAllVisible(view.doc);
      }
    });
  }
}

function onSessionRemoved(data: unknown): void {
  const { sessionId } = data as { projectId: string; sessionId: string };
  if (getFileReaderInstance(sessionId)) {
    destroyFileReaderPane(sessionId);
  } else if (getFileViewerInstance(sessionId)) {
    destroyFileViewerPane(sessionId);
  } else if (getInspectorInstance(sessionId)) {
    disconnectInspector(sessionId);
    destroyInspectorPane(sessionId);
  } else if (getRemoteTerminalInstance(sessionId)) {
    destroyRemoteTerminal(sessionId);
  } else if (getBrowserTabInstance(sessionId)) {
    destroyBrowserTabPane(sessionId);
  } else if (getProjectTabInstance(sessionId)) {
    destroyProjectTabPane(sessionId);
  } else if (getKanbanInstance(sessionId)) {
    destroyKanbanPane(sessionId);
  } else if (getTeamInstance(sessionId)) {
    destroyTeamPane(sessionId);
  } else {
    destroyTerminal(sessionId);
  }
  renderLayout();
}

/** Lay out every registered view. */
export function renderLayout(): void {
  for (const view of views) renderView(view);
}

/** Lay out one view: the project it shows (`projectIdForView`), restricted to the view's tabs. */
export function renderView(view: LayoutView): void {
  const project = projectForView(view);
  // Detached sessions (tab closed, session kept) are never laid out.
  const tabs = project ? viewTabs(view.kind, project) : [];

  // The main view of the detached project with none of its own tabs selected: its
  // sessions run in the other window, so say so instead of "no sessions".
  if (project && !viewOwnsLayout(view.kind, project.id) && !viewActiveSessionId(view.kind, project)) {
    hideViewPanes(view);
    setContainerClass(view, '');
    showDetachedPlaceholder(view);
    return;
  }

  if (!project || tabs.length === 0) {
    hideViewPanes(view);
    setContainerClass(view, '');
    showEmptyState(view, project);
    return;
  }

  const container = view.container;
  removeEmptyState(view);
  // Filler cells hold nothing, so they are cheap to rebuild. The grid wrapper is
  // not dropped here: it is reused across renders (removing it would detach every
  // pane inside it), and the mode dispatch below decides when it has to go.
  container.querySelectorAll('.swarm-empty-cell').forEach(el => el.remove());

  // Ensure all sessions have their respective instances
  for (const session of project.sessions) {
    if (session.type === 'file-reader') {
      if (!getFileReaderInstance(session.id)) {
        createFileReaderPane(session.id, session.fileReaderPath || '', session.fileReaderLine);
      }
    } else if (session.type === 'diff-viewer') {
      if (!getFileViewerInstance(session.id)) {
        createFileViewerPane(session.id, session.diffFilePath || '', session.diffArea || '', session.worktreePath);
      }
    } else if (session.type === 'mcp-inspector') {
      if (!getInspectorInstance(session.id)) {
        createInspectorPane(session.id);
      }
    } else if (session.type === 'remote-terminal') {
      // Remote terminal instances are created by share-manager, skip here
    } else if (session.type === 'browser-tab') {
      if (!getBrowserTabInstance(session.id)) {
        createBrowserTabPane(session.id, session.browserTabUrl);
      }
    } else if (session.type === 'project-tab') {
      if (!getProjectTabInstance(session.id)) {
        createProjectTabPane(session.id, project.id);
      }
    } else if (session.type === 'kanban') {
      if (!getKanbanInstance(session.id)) {
        createKanbanPane(session.id, project.id);
      }
    } else if (session.type === 'team') {
      if (!getTeamInstance(session.id)) {
        createTeamPane(session.id, project.id);
      }
    } else {
      if (!getTerminalInstance(session.id)) {
        const cliProviderId = session.providerId || 'claude';
        const configDir = sessionConfigDir(session, cliProviderId);
        const loc = sessionLocation(project, session);
        createTerminalPane(session.id, loc.cwd, session.cliSessionId, !!session.cliSessionId, session.args || '', cliProviderId, project.id, session.envVars || '', configDir, loc.host);
      }
    }
  }

  hideViewPanes(view);

  const mode = layoutModeFor(view, project);
  // Tab mode never reads the split/swarm panes.
  const r: ViewRender = { view, project, tabs, panes: mode === 'tabs' ? [] : panesForView(view, project) };
  if (mode === 'swarm' && r.panes.length >= 1) {
    renderSwarmMode(r); // owns the grid wrapper, including dropping it
  } else {
    removeSwarmWrapper(view);
    if (mode === 'split' && r.panes.length > 1) {
      renderSplitMode(r);
    } else {
      renderTabMode(r);
    }
  }

  requestFrameIn(view.doc, () => fitAllVisible(view.doc));
}

/** Attach and show a non-CLI session pane. */
function attachNonCliPane(session: { id: string; type?: string; fileReaderLine?: number }, target: HTMLElement, inSplit: boolean): void {
  if (session.type === 'file-reader') {
    attachFileReaderToContainer(session.id, target);
    showFileReaderPane(session.id, inSplit);
    if (session.fileReaderLine) {
      setFileReaderLine(session.id, session.fileReaderLine);
    }
  } else if (session.type === 'diff-viewer') {
    attachFileViewerToContainer(session.id, target);
    showFileViewerPane(session.id, inSplit);
  } else if (session.type === 'mcp-inspector') {
    attachInspectorToContainer(session.id, target);
    showInspectorPane(session.id, inSplit);
  } else if (session.type === 'remote-terminal') {
    attachRemoteToContainer(session.id, target);
    showRemotePane(session.id, inSplit);
  } else if (session.type === 'browser-tab') {
    attachBrowserTabToContainer(session.id, target);
    showBrowserTabPane(session.id, inSplit);
  } else if (session.type === 'project-tab') {
    attachProjectTabToContainer(session.id, target);
    showProjectTabPane(session.id, inSplit);
  } else if (session.type === 'kanban') {
    attachKanbanToContainer(session.id, target);
    showKanbanPane(session.id, inSplit);
  } else if (session.type === 'team') {
    attachTeamToContainer(session.id, target);
    showTeamPane(session.id, inSplit);
  }
}

function renderTabMode({ view, project }: ViewRender): void {
  const container = view.container;
  setContainerClass(view, '');
  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';

  // The view's own active tab: while the project is detached, the main view keeps a
  // selection of its own and project.activeSessionId belongs to the sessions view.
  const activeId = viewActiveSessionId(view.kind, project);
  if (!activeId) return;

  const activeSession = project.sessions.find(s => s.id === activeId);
  if (activeSession && !isCliSession(activeSession)) {
    attachNonCliPane(activeSession, container, false);
    return;
  }

  attachToContainer(activeId, container);
  showPane(activeId, false);

  focusPane(view, project, activeId);

  const instance = getTerminalInstance(activeId);
  if (instance && !instance.spawned && !instance.exited) {
    requestFrameIn(view.doc, () => {
      spawnTerminal(activeId);
      fitAllVisible(view.doc);
    });
  }
}

/** Attach, show, and ensure-spawn for each pane in the list. */
function showPanes({ view, project, panes }: ViewRender, target: HTMLElement = view.container): void {
  const laidOut: (HTMLElement | undefined)[] = [];

  for (const paneId of panes) {
    const session = project.sessions.find(s => s.id === paneId);
    let el: HTMLElement | undefined;

    if (session && !isCliSession(session)) {
      attachNonCliPane(session, target, true);
      el = paneElementFor(session);
    } else {
      attachToContainer(paneId, target);
      showPane(paneId, true);

      const instance = getTerminalInstance(paneId);
      if (instance && !instance.spawned && !instance.exited) {
        requestFrameIn(view.doc, () => spawnTerminal(paneId));
      }
      el = instance?.element;
    }

    laidOut.push(el);
  }

  ensurePaneOrder(target, laidOut);
}

function focusActivePane({ view, project, panes }: ViewRender): void {
  const paneId = project.activeSessionId && panes.includes(project.activeSessionId)
    ? project.activeSessionId
    : panes[0];
  if (paneId) focusPane(view, project, paneId);
}

function renderSplitMode(r: ViewRender): void {
  const container = r.view.container;
  setContainerClass(r.view, `split-${r.project.layout.splitDirection}`);
  container.style.gridTemplateColumns = '';
  container.style.gridTemplateRows = '';
  showPanes(r);
  focusActivePane(r);
}

function renderSwarmMode(r: ViewRender): void {
  const { view, project, tabs } = r;
  const container = view.container;
  const count = r.panes.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);

  const activeSession = tabs.find(s => s.id === project.activeSessionId);
  const nonCliSession = (activeSession && !isCliSession(activeSession))
    ? activeSession
    : [...tabs].reverse().find(s => !isCliSession(s));

  const hasInspector = inspectorOpenFor(view);

  setContainerClass(view, 'swarm-mode');

  const needsWrapper = nonCliSession || hasInspector;

  if (needsWrapper) {
    const colParts: string[] = ['1fr'];
    if (nonCliSession) colParts.push('1fr');
    if (hasInspector) colParts.push('var(--inspector-width, 350px)');

    container.style.gridTemplateColumns = colParts.join(' ');
    container.style.gridTemplateRows = '1fr';

    // Reuse the wrapper across renders: rebuilding it would detach — and so blur
    // and de-select — every pane inside it on every state change.
    let gridWrapper = container.querySelector<HTMLElement>('.swarm-grid-wrapper');
    if (!gridWrapper) {
      gridWrapper = view.doc.createElement('div');
      gridWrapper.className = 'swarm-grid-wrapper';
      container.appendChild(gridWrapper);
    }
    gridWrapper.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gridWrapper.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    showPanes(r, gridWrapper);
    appendEmptyCells(view, cols * rows - count, gridWrapper);

    if (nonCliSession) attachNonCliPane(nonCliSession, container, true);

    // Grid placement follows DOM order: wrapper, then the non-CLI pane, then the
    // inspector. Hidden panes are display:none and stay wherever they were left.
    ensurePaneOrder(container, [
      gridWrapper,
      nonCliSession ? paneElementFor(nonCliSession) : null,
      hasInspector ? container.querySelector<HTMLElement>('#session-inspector') : null,
    ]);
  } else {
    removeSwarmWrapper(view);
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    showPanes(r);
    appendEmptyCells(view, cols * rows - count, container);
  }

  updateSwarmPaneStyles(project, r.panes);
  focusActivePane(r);
}

function appendEmptyCells(view: LayoutView, count: number, target: HTMLElement): void {
  for (let i = 0; i < count; i++) {
    const cell = view.doc.createElement('div');
    cell.className = 'swarm-empty-cell';

    const btn = view.doc.createElement('button');
    btn.className = 'swarm-empty-add-btn';
    btn.textContent = '+';
    btn.title = 'New session';
    btn.addEventListener('click', () => quickNewSession(projectForView(view)?.id, view.doc));

    cell.appendChild(btn);
    target.appendChild(cell);
  }
}

function updateSwarmPaneStyles(project: ProjectRecord, panes: readonly string[]): void {
  for (const paneId of panes) {
    const instance = getTerminalInstance(paneId);
    if (instance) {
      const isActive = paneId === project.activeSessionId;
      instance.element.classList.toggle('swarm-dimmed', !isActive);
      instance.element.classList.toggle('swarm-unread', !isActive && isUnread(paneId));
    }
  }
}

const plusIcon =
  '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="2.5" x2="7" y2="11.5"/><line x1="2.5" y1="7" x2="11.5" y2="7"/></svg>';

function showEmptyState(view: LayoutView, project: ProjectRecord | undefined): void {
  removeEmptyState(view);
  const doc = view.doc;
  const el = doc.createElement('div');
  el.className = 'empty-state';
  if (!project) {
    el.innerHTML = `
      <div>No project selected</div>
      <div class="hint">Create a project with the + button in the sidebar</div>
    `;
  } else {
    const title = doc.createElement('div');
    title.className = 'empty-state-title';
    title.textContent = 'Ready when you are';

    const hint = doc.createElement('div');
    hint.className = 'hint';
    const name = doc.createElement('span');
    name.className = 'empty-state-project';
    name.textContent = project.name;
    hint.append('No sessions running in ', name, ' yet.');

    const cta = doc.createElement('button');
    cta.className = 'btn-primary empty-state-cta';
    cta.innerHTML = `${plusIcon}<span>Start a session</span>`;
    // The view's project, not the active one: in the sessions window they differ.
    cta.addEventListener('click', () => quickNewSession(project.id, doc));

    el.append(title, hint, cta);
  }
  view.container.appendChild(el);
}

/** Main window, detached project: "its sessions are in the other window" + Show / Bring back. */
function showDetachedPlaceholder(view: LayoutView): void {
  // Already shown: refresh its text (the locale may have changed), keep the nodes.
  const shown = view.container.querySelector<HTMLElement>('.session-window-placeholder');
  if (shown) {
    setDetachedPlaceholderText(shown);
    return;
  }
  removeEmptyState(view);
  const doc = view.doc;
  const el = doc.createElement('div');
  el.className = 'empty-state session-window-placeholder';

  const title = doc.createElement('div');
  title.className = 'empty-state-title';

  const actions = doc.createElement('div');
  actions.className = 'session-window-placeholder-actions';
  const show = doc.createElement('button');
  show.className = 'btn-primary';
  show.addEventListener('click', () => focusSessionWindow());
  const back = doc.createElement('button');
  back.className = 'btn-secondary';
  back.addEventListener('click', () => closeSessionWindow());
  actions.append(show, back);

  el.append(title, actions);
  setDetachedPlaceholderText(el);
  view.container.appendChild(el);
}

function setDetachedPlaceholderText(el: HTMLElement): void {
  el.querySelector('.empty-state-title')!.textContent = t('sessionWindow.placeholder');
  el.querySelector('.btn-primary')!.textContent = t('sessionWindow.show');
  el.querySelector('.btn-secondary')!.textContent = t('sessionWindow.bringBack');
}

function removeEmptyState(view: LayoutView): void {
  view.container.querySelector('.empty-state')?.remove();
}
