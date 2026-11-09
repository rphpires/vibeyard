/**
 * IPC for file-tree operations (new, rename, delete, copy/move, paste from the
 * OS clipboard, upload/download, open a remote file), local (`fs:*`) and on an
 * SSH host (`remote:*`). This is their sandbox:
 *
 * - A local path must be inside a known local project (`knownProjectRoots`),
 *   judged on its real path (symlinks resolved), so a link inside a project
 *   cannot aim a write, move or delete outside it.
 * - A host path must be inside one of that host's remote projects
 *   (`containingRemoteRoot`, `..`-normalized); the remote scripts then
 *   re-check on the host with symlinks resolved (`guard` in `remote-file-ops.ts`).
 * - A project folder itself may be pasted into, never renamed, moved or deleted.
 * - The only local paths outside a project an operation may read are the
 *   sources of a copy that the user really dropped (granted by the preload's
 *   `getDroppedFilePath`, which only a genuine drop's File can produce) or put
 *   on the OS clipboard (read here, in main). A renderer cannot name an
 *   arbitrary file (say `~/.ssh/id_rsa`) to copy into a project or upload.
 *
 * The older read-only `fs:*` handlers (`ipc-handlers.ts`) still check paths
 * lexically; this module is stricter because its operations write and delete.
 */
import { ipcMain, BrowserWindow, dialog, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { loadState } from './store';
import { knownProjectRoots, isWithinRoots, knownRemoteRoots, containingRemoteRoot, normalizeRemotePath } from './project-roots';
import { createLocalEntry, renameLocalEntry, copyLocalEntries, writeLocalFile } from './local-file-ops';
import { readClipboardPasteable } from './clipboard-files';
import {
  remoteCreate, remoteRename, remoteDelete, remoteCopy, remoteStat,
  uploadToRemote, writeRemoteFile, downloadFromRemote, fetchRemoteCopy, type RemoteTarget,
} from './remote-file-ops';
import { isValidSshHost } from '../shared/ssh-host';
import { pastedImageName, type FileOpResult } from '../shared/file-names';

/** How long a dropped file stays readable for a copy. */
const DROP_GRANT_MS = 10 * 60_000;
const dropGrants = new Map<string, number>();

/** Called (via the preload) for each file of a real drop: its path may be copied for a while. */
function grantDroppedPath(p: unknown): void {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return;
  const now = Date.now();
  for (const [k, until] of dropGrants) if (until < now) dropGrants.delete(k);
  dropGrants.set(path.resolve(p), now + DROP_GRANT_MS);
}

function isGranted(resolved: string): boolean {
  return (dropGrants.get(resolved) ?? 0) >= Date.now();
}

/** What an operation returns: the paths it created, nothing, or `'empty'` (a clipboard paste found nothing to paste). */
type OpOutcome = string[] | void | 'empty';

/**
 * Register a file-op channel: the handler's paths become `{ ok, paths }`,
 * `'empty'` becomes `{ ok, empty }`, and a throw becomes `{ ok: false, error }`.
 */
function handle(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<OpOutcome>): void {
  ipcMain.handle(channel, async (e, ...args): Promise<FileOpResult> => {
    try {
      const out = await fn(e, ...args);
      if (out === 'empty') return { ok: true, empty: true };
      return { ok: true, ...(out ? { paths: out } : {}) };
    } catch (err) {
      console.warn(`${channel} failed:`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function realOr(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return p; }
}

/** Path checks against one snapshot of the projects (state.json is read once per call). */
function sandbox() {
  const projects = loadState().projects;
  let localRoots: string[] | null = null;
  const roots = () => (localRoots ??= knownProjectRoots(projects).map(realOr));

  /**
   * Resolve local `p` to its real path and refuse it outside every project.
   * `strict` (the entry itself is renamed/moved/deleted): the entry's own name
   * is kept (a link is acted on, not followed), its folder is resolved, and a
   * project folder itself is refused.
   */
  function local(p: unknown, strict = false): string {
    if (typeof p !== 'string' || !p) throw new Error('Invalid path');
    const resolved = path.resolve(p);
    const real = strict ? path.join(realOr(path.dirname(resolved)), path.basename(resolved)) : realOr(resolved);
    if (strict && roots().includes(realOr(resolved))) throw new Error('A project folder cannot be changed here');
    if (!isWithinRoots(real, roots())) throw new Error('Path is not within a known project');
    return real;
  }

  /** A copy source: a project entry, or a file the user dropped or copied in the OS. */
  function copySource(p: unknown): string {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Invalid path');
    const resolved = path.resolve(p);
    return isGranted(resolved) ? resolved : local(resolved);
  }

  /** Check host path `p` against the host's remote projects (`strict`: and refuse a project folder itself). */
  function remote(host: unknown, p: unknown, strict = false): RemoteTarget {
    if (typeof host !== 'string' || !isValidSshHost(host)) throw new Error('Invalid SSH host');
    if (typeof p !== 'string') throw new Error('Invalid path');
    const root = containingRemoteRoot(p, knownRemoteRoots(projects, host));
    if (!root) throw new Error('Path is not within a remote project on this host');
    const n = normalizeRemotePath(p);
    if (strict && n === root) throw new Error('A project folder cannot be changed here');
    return { host, root, path: n };
  }

  return { local, copySource, remote };
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Nothing to paste');
  return value;
}

/** Every host path of one operation must share a project: a script's guard checks against one root. */
function sameProject(targets: RemoteTarget[]): void {
  if (targets.some((t) => t.root !== targets[0].root)) throw new Error('Paste between two remote projects is not supported');
}

const kindOf = (kind: unknown): 'file' | 'dir' => (kind === 'dir' ? 'dir' : 'file');

export function registerFileOpsHandlers(): void {
  ipcMain.on('fs:grantDropped', (_e, p: unknown) => grantDroppedPath(p));

  // ---- local ----
  handle('fs:createEntry', async (_e, dir, name, kind) => [await createLocalEntry(sandbox().local(dir), name, kindOf(kind))]);
  handle('fs:renameEntry', async (_e, target, newName) => [await renameLocalEntry(sandbox().local(target, true), newName)]);
  handle('fs:deleteEntry', async (_e, target) => { await shell.trashItem(sandbox().local(target, true)); });

  handle('fs:copyEntries', async (_e, sources, destDir, move) => {
    const sb = sandbox();
    const dest = sb.local(destDir);
    // Moving deletes the source, so it must be a project entry; a copy only reads it.
    const srcs = list(sources).map((s) => (move ? sb.local(s, true) : sb.copySource(s)));
    return copyLocalEntries(srcs, dest, !!move);
  });

  handle('fs:pasteClipboard', async (_e, destDir) => {
    const dest = sandbox().local(destDir);
    const clip = await readClipboardPasteable();
    if (clip.kind === 'none') return 'empty';
    return clip.kind === 'files' ? copyLocalEntries(clip.paths, dest, false) : [await writeLocalFile(dest, pastedImageName(), clip.png)];
  });

  // ---- remote ----
  handle('remote:createEntry', async (_e, host, dir, name, kind) => [await remoteCreate(sandbox().remote(host, dir), name, kindOf(kind))]);
  handle('remote:renameEntry', async (_e, host, target, newName) => [await remoteRename(sandbox().remote(host, target, true), newName)]);
  handle('remote:deleteEntry', async (_e, host, target) => { await remoteDelete(sandbox().remote(host, target, true)); });

  handle('remote:copyEntries', async (_e, host, sources, destDir, move) => {
    const sb = sandbox();
    const dest = sb.remote(host, destDir);
    const srcs = list(sources).map((s) => sb.remote(host, s, !!move));
    sameProject([dest, ...srcs]);
    return remoteCopy(dest, srcs.map((s) => s.path), !!move);
  });

  ipcMain.handle('remote:stat', async (_e, host: unknown, target: unknown) => {
    try {
      return { ok: true as const, ...(await remoteStat(sandbox().remote(host, target))) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  /** Upload local files (a drop, or a tree copy from a local project) into a host folder. */
  handle('remote:upload', async (_e, host, localPaths, destDir) => {
    const sb = sandbox();
    const dest = sb.remote(host, destDir);
    return uploadToRemote(dest, list(localPaths).map((p) => sb.copySource(p)));
  });

  handle('remote:pasteClipboard', async (_e, host, destDir) => {
    const dest = sandbox().remote(host, destDir);
    const clip = await readClipboardPasteable();
    if (clip.kind === 'none') return 'empty';
    return clip.kind === 'files' ? uploadToRemote(dest, clip.paths) : [await writeRemoteFile(dest, pastedImageName(), clip.png)];
  });

  /**
   * Download host entries into a local folder: a project folder (a tree paste
   * from a remote project into a local one), or one the user picks when
   * `localDestDir` is omitted ("Download…"). `{ ok: true }` without paths = cancelled.
   */
  handle('remote:download', async (e, host, remotePaths, localDestDir) => {
    const sb = sandbox();
    const srcs = list(remotePaths).map((p) => sb.remote(host, p));
    sameProject(srcs);
    let dest: string;
    if (localDestDir === undefined) {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts: Electron.OpenDialogOptions = { title: 'Download to…', properties: ['openDirectory', 'createDirectory'] };
      const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (pick.canceled || pick.filePaths.length === 0) return;
      dest = pick.filePaths[0];
    } else {
      dest = sb.local(localDestDir);
    }
    return downloadFromRemote(srcs[0], srcs.map((s) => s.path), dest);
  });

  /** A read-only local copy of a host file for the file reader; `paths[0]` is the copy. */
  handle('remote:openCopy', async (_e, host, remotePath) => [await fetchRemoteCopy(sandbox().remote(host, remotePath))]);
}
