// Project and session lookup shared by the vibeyard-ctl command handlers.
import type { ProjectRecord, SessionRecord } from '../shared/types.js';

function normalizePath(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
}

/** A project by id, or by folder path (trailing separators ignored). The Temporary project has no path to match. */
export function findProject(projects: ProjectRecord[], ref: string): ProjectRecord | undefined {
  const want = normalizePath(ref);
  return projects.find((p) => p.id === ref || (p.path !== '' && normalizePath(p.path) === want));
}

export function findSession(projects: ProjectRecord[], sessionId: string): { project: ProjectRecord; session: SessionRecord } | undefined {
  for (const project of projects) {
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session) return { project, session };
  }
  return undefined;
}
