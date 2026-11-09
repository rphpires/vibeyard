/**
 * What a user can do to file-tree entries: the context menus, the New /
 * Rename / Delete / Properties dialogs, Copy / Cut / Paste and dropping files
 * from the OS file manager. Every action goes through the tree's backend, so
 * the same menu works in a local project and on an SSH host.
 *
 * Copy/Cut keep the entries in a tree-internal clipboard and also write their
 * paths to the OS clipboard as text. That text write is load-bearing: it
 * replaces any screenshot or Explorer file list there, so the next Paste
 * (which prefers the OS clipboard's files/image) takes the tree's entries
 * instead of something copied earlier. Copying files or a screenshot in
 * another app afterwards makes that win again, as in any file manager.
 */
import { appState } from '../state.js';
import { pathToFileURL } from '../file-url.js';
import { showContextMenu, MenuOption } from './board/board-context-menu.js';
import { showConfirmModal, showConfirmDialog, showModal, closeModal, setModalError, showPropertiesDialog } from './modal.js';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../../shared/token-estimate.js';
import { entryNameError, type FileOpResult } from '../../shared/file-names.js';
import { dirname } from '../../shared/platform.js';
import type { DirEntry } from '../../shared/types.js';
import { isMac, isWin } from '../platform.js';
import type { TreeBackend } from './file-tree-backends.js';

/** What the actions need from a rendered tree. */
export interface TreeHandle {
  projectId: string;
  /** The project folder: the paste/new target of the tree's empty area. */
  root: string;
  backend: TreeBackend;
  /** Make `dirs` show the result of an operation now (a remote tree re-lists; a local one follows the fs watcher). */
  refresh(dirs: string[]): void;
  select(path: string | null): void;
  setBusy(busy: boolean): void;
}

// ---------------------------------------------------------------------------
// Tree clipboard
// ---------------------------------------------------------------------------

interface TreeClipboard {
  paths: string[];
  /** Backend the entries live on (undefined = local disk). */
  host?: string;
  move: boolean;
}

let clipboard: TreeClipboard | null = null;
const clipboardListeners = new Set<() => void>();

/** Notified when entries are copied, cut or pasted (cut rows are dimmed). */
export function onTreeClipboardChange(cb: () => void): () => void {
  clipboardListeners.add(cb);
  return () => { clipboardListeners.delete(cb); };
}

function setClipboard(next: TreeClipboard | null): void {
  clipboard = next;
  for (const cb of clipboardListeners) cb();
}

/** Whether `path` (on `host`) is waiting to be moved by a Paste. */
export function isCutPending(path: string, host: string | undefined): boolean {
  return !!clipboard?.move && clipboard.host === host && clipboard.paths.includes(path);
}

/** @internal Test-only. */
export function _resetTreeClipboardForTesting(): void {
  clipboard = null;
  clipboardListeners.clear();
}

export function copyToTreeClipboard(t: TreeHandle, entries: DirEntry[], move: boolean): void {
  if (entries.length === 0) return;
  const paths = entries.map((e) => e.path);
  setClipboard({ paths, host: t.backend.host, move });
  void window.vibeyard.clipboard.write(paths.join('\n'), 'explicit');
}

// ---------------------------------------------------------------------------
// Running an operation
// ---------------------------------------------------------------------------

function showOpError(title: string, error: string | undefined): void {
  showConfirmDialog(title, error || 'The operation failed.', { confirmLabel: 'OK', onConfirm: () => {} });
}

/** Run `op` with the tree marked busy; report a failure, refresh `dirs` on success. */
async function perform(t: TreeHandle, title: string, dirs: string[], op: () => Promise<FileOpResult>): Promise<FileOpResult> {
  t.setBusy(true);
  let res: FileOpResult;
  try {
    res = await op();
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    t.setBusy(false);
  }
  if (!res.ok) showOpError(title, res.error);
  else if (!res.empty && dirs.length > 0) t.refresh(dirs);
  return res;
}

/** The folder a paste/new on `entry` targets: the folder itself, or a file's folder. */
export function targetDir(entry: DirEntry): string {
  return entry.isDirectory ? entry.path : dirname(entry.path);
}

export async function pasteInto(t: TreeHandle, dir: string): Promise<void> {
  const fromOs = await perform(t, 'Paste', [dir], () => t.backend.pasteClipboard(dir));
  if (!fromOs.ok || !fromOs.empty) {
    if (fromOs.paths?.[0]) t.select(fromOs.paths[0]);
    return;
  }
  const clip = clipboard;
  if (!clip) return;
  // A cut pasted across machines is a copy: its sources stay, and so does the clipboard.
  const moves = clip.move && t.backend.movesFrom(clip.host);
  const sourceDirs = moves ? clip.paths.map((p) => dirname(p)) : [];
  const res = await perform(t, 'Paste', [dir, ...sourceDirs], () => t.backend.paste(clip.paths, clip.host, dir, clip.move));
  if (!res.ok) return;
  if (moves) setClipboard(null);
  if (res.paths?.[0]) t.select(res.paths[0]);
}

export function importDropped(t: TreeHandle, paths: string[], dir: string): void {
  if (paths.length === 0) return;
  void perform(t, 'Copy', [dir], () => t.backend.importLocal(paths, dir)).then((res) => {
    if (res.ok && res.paths?.[0]) t.select(res.paths[0]);
  });
}

export function openEntry(t: TreeHandle, entry: DirEntry): void {
  void perform(t, 'Open', [], () => t.backend.open(t.projectId, entry));
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

/** A one-field name dialog: validates, runs `op`, keeps the dialog open on failure. */
function promptName(title: string, confirmLabel: string, initial: string, op: (name: string) => Promise<FileOpResult>, done: (res: FileOpResult) => void): void {
  showModal(title, [{ id: 'name', label: 'Name', type: 'text', defaultValue: initial }], async (values) => {
    const name = (values.name ?? '').trim();
    const invalid = entryNameError(name);
    if (invalid) {
      setModalError('name', invalid);
      return;
    }
    const res = await op(name);
    if (!res.ok) {
      setModalError('name', res.error || 'The operation failed.');
      return;
    }
    closeModal();
    done(res);
  }, { confirmLabel });
}

export function promptCreate(t: TreeHandle, dir: string, kind: 'file' | 'dir'): void {
  promptName(kind === 'dir' ? 'New Folder' : 'New File', 'Create', '', (name) => t.backend.create(dir, name, kind), (res) => {
    t.refresh([dir]);
    if (res.paths?.[0]) t.select(res.paths[0]);
  });
}

export function promptRename(t: TreeHandle, entry: DirEntry): void {
  const dir = dirname(entry.path);
  promptName(`Rename ${entry.isDirectory ? 'folder' : 'file'}`, 'Rename', entry.name, (name) => (
    name === entry.name ? Promise.resolve({ ok: true, paths: [entry.path] }) : t.backend.rename(entry.path, name)
  ), (res) => {
    t.refresh([dir]);
    if (res.paths?.[0]) t.select(res.paths[0]);
  });
}

export function confirmDelete(t: TreeHandle, entry: DirEntry): void {
  const kind = entry.isDirectory ? 'folder' : 'file';
  const what = entry.isDirectory ? `"${entry.name}" and its contents` : `"${entry.name}"`;
  const message = t.backend.deleteIsPermanent
    ? `Permanently delete ${what} on ${t.backend.host}? This cannot be undone.`
    : `Move ${what} to the Trash?`;
  showConfirmModal(`Delete ${kind}`, message, () => {
    void perform(t, `Delete ${kind}`, [dirname(entry.path)], () => t.backend.remove(entry.path));
  }, { confirmLabel: 'Delete', danger: true });
}

async function showProperties(t: TreeHandle, entry: DirEntry): Promise<void> {
  const { backend } = t;
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  rows.push({ label: 'Path', value: entry.path, mono: true });
  if (backend.host) rows.push({ label: 'Host', value: backend.host, mono: true });
  rows.push({ label: 'Type', value: entry.isDirectory ? 'folder' : fileTypeLabel(entry.name) });
  // Reading the content for line/token counts is local-only (it would be a full download on a host).
  const [stat, read] = await Promise.all([
    backend.stat(entry.path),
    backend.host || entry.isDirectory ? Promise.resolve(null) : window.vibeyard.fs.readFile(entry.path),
  ]);
  rows.push({ label: 'Size', value: stat ? formatBytes(stat.size) : '—' });
  rows.push({ label: 'Modified', value: stat ? formatMtime(stat.mtimeMs) : '—' });
  if (read) {
    if (read.ok) {
      const lines = read.content.length === 0 ? 0 : read.content.split('\n').length;
      rows.push({ label: 'Lines', value: lines.toLocaleString() });
      rows.push({
        label: 'Tokens',
        value: read.content.length > TOKEN_COUNT_MAX_CHARS ? 'too large to count' : `~ ${estimateTokens(read.content).toLocaleString()}`,
      });
    } else {
      const why = read.reason === 'binary' ? 'binary file' : 'unreadable';
      rows.push({ label: 'Lines', value: `— (${why})` });
      rows.push({ label: 'Tokens', value: `— (${why})` });
    }
  }
  showPropertiesDialog(entry.name, rows);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatMtime(ms: number): string {
  const diffSec = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  let rel: string;
  if (diffSec < 60) rel = `${diffSec}s ago`;
  else if (diffSec < 3600) rel = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) rel = `${Math.floor(diffSec / 3600)}h ago`;
  else if (diffSec < 86400 * 30) rel = `${Math.floor(diffSec / 86400)}d ago`;
  else rel = `${Math.floor(diffSec / (86400 * 30))}mo ago`;
  return `${rel} · ${new Date(ms).toLocaleString()}`;
}

function fileTypeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '(no ext)';
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** Name of the OS file manager, used in the reveal menu labels. Exported for tests. */
export const FILE_MANAGER = isMac ? 'Finder' : isWin ? 'File Explorer' : 'File Manager';

/**
 * A folder opens in the file manager showing its own contents; a file is
 * revealed inside its parent folder, selected. Main picks the two apart.
 */
function revealOption(entry: DirEntry): MenuOption {
  return {
    label: `${entry.isDirectory ? 'Open' : 'Reveal'} in ${FILE_MANAGER}`,
    action: async () => {
      const result = await window.vibeyard.fs.showInFolder(entry.path);
      if (!result.ok) {
        console.warn(`Failed to show ${entry.path} in ${FILE_MANAGER}: ${result.error ?? 'unknown error'}`);
      }
    },
  };
}

function copyPathOption(path: string): MenuOption {
  return { label: 'Copy Path', action: () => { void window.vibeyard.clipboard.write(path, 'explicit'); } };
}

function newOptions(t: TreeHandle, dir: string): MenuOption[] {
  return [
    { label: 'New File…', action: () => promptCreate(t, dir, 'file') },
    { label: 'New Folder…', action: () => promptCreate(t, dir, 'dir') },
  ];
}

/** The context menu of one entry. */
export function entryMenu(t: TreeHandle, entry: DirEntry): MenuOption[] {
  const { backend } = t;
  const options: MenuOption[] = [];
  if (entry.isDirectory) {
    options.push(...newOptions(t, entry.path));
  } else {
    options.push({ label: backend.host ? 'Open (read-only copy)' : 'Open', action: () => openEntry(t, entry) });
    if (!backend.host) {
      options.push({ label: 'Open in Browser', action: () => { appState.addBrowserTabSession(t.projectId, pathToFileURL(entry.path)); } });
    }
  }
  options.push(
    { label: 'Cut', action: () => copyToTreeClipboard(t, [entry], true) },
    { label: 'Copy', action: () => copyToTreeClipboard(t, [entry], false) },
    { label: 'Paste', action: () => { void pasteInto(t, targetDir(entry)); } },
    copyPathOption(entry.path),
    { label: 'Rename…', action: () => promptRename(t, entry) },
  );
  if (backend.host) {
    options.push({
      label: 'Download…',
      action: () => { void perform(t, 'Download', [], () => window.vibeyard.remote.download(backend.host!, [entry.path])); },
    });
  } else {
    options.push(revealOption(entry));
  }
  if (backend.host || !entry.isDirectory) options.push({ label: 'Properties', action: () => { void showProperties(t, entry); } });
  options.push({ label: 'Delete', danger: true, action: () => confirmDelete(t, entry) });
  return options;
}

/** The context menu of the tree's empty area: the project folder itself. */
export function rootMenu(t: TreeHandle): MenuOption[] {
  return [
    ...newOptions(t, t.root),
    { label: 'Paste', action: () => { void pasteInto(t, t.root); } },
    copyPathOption(t.root),
  ];
}

export function showMenuAt(e: MouseEvent, options: MenuOption[]): void {
  e.preventDefault();
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, options);
}
