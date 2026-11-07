import type { ProjectRecord, SessionRecord } from '../shared/types.js';
import { tabSessions } from './session-utils.js';

/** Which window a view renders in: the main window or the separate sessions window. */
export type ViewKind = 'main' | 'sessions';

/** Tab types that stay in the main window even when their project is detached. */
export const PROJECT_LEVEL_TAB_TYPES = ['project-tab', 'kanban', 'team'] as const;

type DetachedChangeCallback = (projectId: string | null) => void;

let detachedProjectId: string | null = null;
const listeners: DetachedChangeCallback[] = [];

export function getDetachedProjectId(): string | null {
  return detachedProjectId;
}

export function setDetachedProjectId(id: string | null): void {
  if (id === detachedProjectId) return;
  detachedProjectId = id;
  for (const cb of [...listeners]) cb(id);
}

export function onDetachedChange(cb: DetachedChangeCallback): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

function isProjectLevel(session: Pick<SessionRecord, 'type'>): boolean {
  return !!session.type && (PROJECT_LEVEL_TAB_TYPES as readonly string[]).includes(session.type);
}

/** Whether `kind`'s view shows this session's tab. */
export function viewShowsSession(kind: ViewKind, projectId: string, session: SessionRecord): boolean {
  if (projectId !== detachedProjectId) return kind === 'main';
  return (kind === 'main') === isProjectLevel(session);
}

/** Tabs (detached-flag sessions excluded) the given view shows for a project. */
export function viewTabs(kind: ViewKind, project: ProjectRecord): SessionRecord[] {
  return tabSessions(project).filter((s) => viewShowsSession(kind, project.id, s));
}

/** The project a view is currently showing. */
export function projectIdForView(kind: ViewKind, activeProjectId: string | null): string | null {
  return kind === 'sessions' ? getDetachedProjectId() : activeProjectId;
}

/** @internal Test-only: reset all module state */
export function _resetForTesting(): void {
  detachedProjectId = null;
  listeners.length = 0;
}
