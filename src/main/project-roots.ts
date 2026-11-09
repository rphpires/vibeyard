import * as path from 'path';
import { localProjectFolder } from '../shared/project-folder';

interface RootSource {
  path: string;
  remoteHost?: string;
  temporary?: boolean;
  sessions?: Array<{ runPath?: string; sshHost?: string }>;
}

/**
 * Local directories the main-process fs sandbox trusts: each local project's
 * path, plus the own folder of every local ad-hoc session (the Temporary
 * project's sessions). Empty paths (the folder-less Temporary project) are
 * skipped — `'' + sep` is the filesystem root on POSIX and would admit every
 * path — and so are paths that live on an SSH host (remote projects and
 * remote sessions name directories that are not on this machine).
 */
export function knownProjectRoots(projects: RootSource[]): string[] {
  const roots: string[] = [];
  for (const p of projects) {
    const folder = localProjectFolder(p);
    if (folder) roots.push(path.resolve(folder));
    for (const s of p.sessions ?? []) {
      if (s.runPath && !s.sshHost) roots.push(path.resolve(s.runPath));
    }
  }
  return roots;
}

/** Whether `resolvedPath` is one of `roots` or inside one. */
export function isWithinRoots(resolvedPath: string, roots: string[]): boolean {
  return roots.some((root) => resolvedPath === root || resolvedPath.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/**
 * The folders of the remote projects on `host`: the only places on that host
 * a file-tree operation may touch. Normalized POSIX paths without a trailing
 * slash (`/` stays `/`).
 */
export function knownRemoteRoots(projects: RootSource[], host: string): string[] {
  return projects
    .filter((p) => p.remoteHost === host && !p.temporary && p.path.startsWith('/'))
    .map((p) => normalizeRemotePath(p.path));
}

/** POSIX-normalize a host path (`..` resolved, no trailing slash except for `/`). */
export function normalizeRemotePath(p: string): string {
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

/**
 * The root of `roots` that host path `p` is in (after normalizing away `..`),
 * the longest when they nest; null for a relative path or one outside them all.
 */
export function containingRemoteRoot(p: string, roots: string[]): string | null {
  if (!p.startsWith('/')) return null;
  const n = normalizeRemotePath(p);
  const inside = roots.filter((root) => n === root || n.startsWith(root === '/' ? '/' : root + '/'));
  return inside.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Whether host path `p` is inside one of `roots`. With `strict`, a root itself
 * does not count: a project folder may be listed or pasted into, never
 * renamed, moved or deleted.
 */
export function isWithinRemoteRoots(p: string, roots: string[], strict = false): boolean {
  const root = containingRemoteRoot(p, roots);
  return root !== null && !(strict && normalizeRemotePath(p) === root);
}
