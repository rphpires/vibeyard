/**
 * Where a file tree's folders live: this machine's disk, or a remote project's
 * SSH host. A tree picks its backend once (see `renderFileTree`), and shared
 * tree code (listing, watching, every row operation) asks the backend instead
 * of branching on the location itself.
 */
import { openFileReaderChecked } from '../open-file-reader.js';
import type { DirEntry } from '../../shared/types.js';
import type { FileOpResult } from '../../shared/file-names.js';

/** A listing that could not be read (a remote dir over a failed ssh call). */
export type Listing = DirEntry[] | null;

export interface EntryCache {
  entries: Map<string, DirEntry[]>;
  inflight: Map<string, Promise<Listing>>;
  /** Dirs whose last listing failed: not retried by re-renders, only by the poll or an expand. */
  failed: Set<string>;
}

export function newCache(): EntryCache {
  return { entries: new Map(), inflight: new Map(), failed: new Set() };
}

export interface EntryStat {
  size: number;
  mtimeMs: number;
}

export interface TreeBackend {
  /** SSH host of a remote project; undefined for the local disk. */
  readonly host?: string;
  /** Listings; per remote project (its own poll keeps it fresh), shared locally (the fs watcher does). */
  readonly cache: EntryCache;
  /** Delete removes for good (no trash on an SSH host) — the confirm dialog says so. */
  readonly deleteIsPermanent: boolean;
  /** List each dir: one `fs.listDir` each locally, one ssh call for all of them remotely. */
  list(dirs: string[]): Promise<Record<string, Listing>>;
  watch(dir: string): void;
  unwatch(dir: string): void;
  /** Open a file in the reader (a remote file through a read-only local copy). */
  open(projectId: string, entry: DirEntry): Promise<FileOpResult>;
  create(dir: string, name: string, kind: 'file' | 'dir'): Promise<FileOpResult>;
  rename(target: string, newName: string): Promise<FileOpResult>;
  remove(target: string): Promise<FileOpResult>;
  /**
   * Paste entries copied (or cut, `move`) in a tree whose backend is `fromHost`
   * (undefined = local) into `destDir`. Between this machine and a host the
   * entries are transferred and a cut is pasted as a copy.
   */
  paste(sources: string[], fromHost: string | undefined, destDir: string, move: boolean): Promise<FileOpResult>;
  /** Whether a cut made in a tree on `fromHost` is pasted here as a move (same machine), not a copy. */
  movesFrom(fromHost: string | undefined): boolean;
  /** Paste the OS clipboard's files or image; `empty` when it holds neither. */
  pasteClipboard(destDir: string): Promise<FileOpResult>;
  /** Copy local files (dropped from the OS file manager) into `destDir`. */
  importLocal(paths: string[], destDir: string): Promise<FileOpResult>;
  stat(target: string): Promise<EntryStat | null>;
}

const toStat = (r: { ok: boolean; size?: number; mtimeMs?: number }): EntryStat | null =>
  r.ok ? { size: r.size!, mtimeMs: r.mtimeMs! } : null;

export const localBackend: TreeBackend = {
  cache: newCache(),
  deleteIsPermanent: false,
  async list(dirs) {
    const lists = await Promise.all(dirs.map((d) => window.vibeyard.fs.listDir(d).catch(() => [])));
    return Object.fromEntries(dirs.map((d, i) => [d, lists[i]]));
  },
  watch: (dir) => window.vibeyard.fs.watchDir(dir),
  unwatch: (dir) => window.vibeyard.fs.unwatchDir(dir),
  async open(projectId, entry) {
    await openFileReaderChecked(projectId, entry.path);
    return { ok: true };
  },
  create: (dir, name, kind) => window.vibeyard.fs.createEntry(dir, name, kind),
  rename: (target, newName) => window.vibeyard.fs.renameEntry(target, newName),
  remove: (target) => window.vibeyard.fs.deleteEntry(target),
  paste(sources, fromHost, destDir, move) {
    return fromHost
      ? window.vibeyard.remote.download(fromHost, sources, destDir)
      : window.vibeyard.fs.copyEntries(sources, destDir, move);
  },
  movesFrom: (fromHost) => fromHost === undefined,
  pasteClipboard: (destDir) => window.vibeyard.fs.pasteClipboard(destDir),
  importLocal: (paths, destDir) => window.vibeyard.fs.copyEntries(paths, destDir, false),
  stat: async (target) => toStat(await window.vibeyard.fs.stat(target)),
};

export function sshBackend(host: string): TreeBackend {
  const remote = window.vibeyard.remote;
  return {
    host,
    cache: newCache(),
    deleteIsPermanent: true,
    list: (dirs) => remote.listDirEntries(host, dirs)
      .catch(() => Object.fromEntries(dirs.map((d) => [d, null]))),
    // No watcher on the host: the tree's poll re-lists watched dirs.
    watch: () => {},
    unwatch: () => {},
    async open(projectId, entry) {
      const copy = await remote.openCopy(host, entry.path);
      if (copy.ok && copy.paths?.[0]) await openFileReaderChecked(projectId, copy.paths[0]);
      return copy;
    },
    create: (dir, name, kind) => remote.createEntry(host, dir, name, kind),
    rename: (target, newName) => remote.renameEntry(host, target, newName),
    remove: (target) => remote.deleteEntry(host, target),
    paste(sources, fromHost, destDir, move) {
      if (fromHost === host) return remote.copyEntries(host, sources, destDir, move);
      if (fromHost) return Promise.resolve({ ok: false, error: 'Copying between two SSH hosts is not supported' });
      return remote.upload(host, sources, destDir);
    },
    movesFrom: (fromHost) => fromHost === host,
    pasteClipboard: (destDir) => remote.pasteClipboard(host, destDir),
    importLocal: (paths, destDir) => remote.upload(host, paths, destDir),
    stat: async (target) => toStat(await remote.stat(host, target)),
  };
}
