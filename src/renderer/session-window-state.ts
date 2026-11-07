import type { ProjectRecord, SessionRecord } from '../shared/types.js';
import { tabSessions } from './session-utils.js';

/** Which window a view renders in: the main window or the separate sessions window. */
export type ViewKind = 'main' | 'sessions';

/** Tab types that stay in the main window even when their project is detached. */
export const PROJECT_LEVEL_TAB_TYPES = ['project-tab', 'kanban', 'team'] as const;

type DetachedChangeCallback = (projectId: string | null) => void;

let detachedProjectId: string | null = null;
/**
 * The project-level tab (Overview/Kanban/Team) the main view shows for the detached
 * project. Transient, never persisted: the project's `activeSessionId` belongs to the
 * sessions view while it is detached. Cleared on every detach change.
 */
let mainViewSelection: string | null = null;
const listeners: DetachedChangeCallback[] = [];

export function getDetachedProjectId(): string | null {
  return detachedProjectId;
}

export function setDetachedProjectId(id: string | null): void {
  if (id === detachedProjectId) return;
  detachedProjectId = id;
  mainViewSelection = null;
  for (const cb of [...listeners]) cb(id);
}

export function onDetachedChange(cb: DetachedChangeCallback): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/** Overview/Kanban/Team: tabs that stay in the main window when their project is detached. */
export function isProjectLevelSession(session: Pick<SessionRecord, 'type'>): boolean {
  return !!session.type && (PROJECT_LEVEL_TAB_TYPES as readonly string[]).includes(session.type);
}

/** Whether `kind`'s view shows this session's tab. */
export function viewShowsSession(kind: ViewKind, projectId: string, session: SessionRecord): boolean {
  if (projectId !== detachedProjectId) return kind === 'main';
  return (kind === 'main') === isProjectLevelSession(session);
}

/** Tabs (detached-flag sessions excluded) the given view shows for a project. */
export function viewTabs(kind: ViewKind, project: ProjectRecord): SessionRecord[] {
  return tabSessions(project).filter((s) => viewShowsSession(kind, project.id, s));
}

/**
 * Whether `kind`'s view owns `projectId`'s layout (split/swarm). The detached project's
 * main view is always tabs: its layout is the sessions window's, so Swarm toggles from
 * the main window (shortcut, menu, More menu) do nothing for it.
 */
export function viewOwnsLayout(kind: ViewKind, projectId: string): boolean {
  return !(kind === 'main' && projectId === detachedProjectId);
}

/** The project a view is currently showing. */
export function projectIdForView(kind: ViewKind, activeProjectId: string | null): string | null {
  return kind === 'sessions' ? getDetachedProjectId() : activeProjectId;
}

/** The view whose tab bar shows this session of `projectId`. */
export function viewKindFor(projectId: string, session: SessionRecord): ViewKind {
  return viewShowsSession('sessions', projectId, session) ? 'sessions' : 'main';
}

/** Select a project-level tab of the detached project in the main view (see `mainViewSelection`). */
export function setMainViewSelection(sessionId: string | null): void {
  mainViewSelection = sessionId;
}

/**
 * The tab `kind`'s view shows as active for `project` — the one every "act on the
 * current tab" path reads, instead of `project.activeSessionId`:
 * - project not detached: the main view's is `activeSessionId`; the sessions view has none.
 * - detached, sessions view: `activeSessionId`, or its first tab while that points at
 *   a tab the main window owns (e.g. Overview was active when the project was detached).
 * - detached, main view: its own selection, or none (the main window shows a placeholder).
 */
export function viewActiveSessionId(kind: ViewKind, project: ProjectRecord): string | null {
  if (project.id !== detachedProjectId) return kind === 'main' ? project.activeSessionId : null;
  const tabs = viewTabs(kind, project);
  const wanted = kind === 'main' ? mainViewSelection : project.activeSessionId;
  if (wanted && tabs.some((s) => s.id === wanted)) return wanted;
  return kind === 'main' ? null : tabs[0]?.id ?? null;
}

/**
 * The tabs on screen as a view's active tab: the main view's for the active project,
 * then the sessions view's for the detached project. What unread marks and
 * notifications treat as "the user is looking at it".
 */
export function onScreenTabIds(projects: readonly ProjectRecord[], activeProjectId: string | null): string[] {
  const ids: string[] = [];
  for (const kind of ['main', 'sessions'] as const) {
    const projectId = projectIdForView(kind, activeProjectId);
    const project = projectId ? projects.find((p) => p.id === projectId) : undefined;
    const id = project ? viewActiveSessionId(kind, project) : null;
    if (id) ids.push(id);
  }
  return ids;
}

let commandSource: ViewKind | null = null;

/**
 * Run `fn` (a keydown's shortcut dispatch) knowing which window's document the key
 * came from. Commands read it through currentCommandSource() before falling back to
 * focus: document.hasFocus() can be true for both windows at once.
 */
export function runWithCommandSource(source: ViewKind, fn: () => void): void {
  const previous = commandSource;
  commandSource = source;
  try {
    fn();
  } finally {
    commandSource = previous;
  }
}

/** The window of the key press being handled right now, or null outside one. */
export function currentCommandSource(): ViewKind | null {
  return commandSource;
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  detachedProjectId = null;
  mainViewSelection = null;
  commandSource = null;
  listeners.length = 0;
}
