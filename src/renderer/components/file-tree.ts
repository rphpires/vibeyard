import { appState, ProjectRecord } from '../state.js';
import { openFileReaderChecked } from '../open-file-reader.js';
import { pathToFileURL } from '../file-url.js';
import { showContextMenu, MenuOption } from './board/board-context-menu.js';
import { showConfirmModal, showPropertiesDialog } from './modal.js';
import { FILE_PATH_DRAG_TYPE } from '../drag-types.js';
import { estimateTokens, TOKEN_COUNT_MAX_CHARS } from '../../shared/token-estimate.js';
import { dirname, isPathUnder } from '../../shared/platform.js';
import { projectFolderLocation } from '../../shared/project-folder.js';
import type { DirEntry } from '../../shared/types.js';
import { isMac, isWin } from '../platform.js';

export type { DirEntry };

/** A listing that could not be read (a remote dir over a failed ssh call). */
type Listing = DirEntry[] | null;

interface EntryCache {
  entries: Map<string, DirEntry[]>;
  inflight: Map<string, Promise<Listing>>;
  /** Dirs whose last listing failed: not retried by re-renders, only by the poll or an expand. */
  failed: Set<string>;
}

function newCache(): EntryCache {
  return { entries: new Map(), inflight: new Map(), failed: new Set() };
}

/**
 * Where a tree's folders live, chosen once per tree. Every place the local
 * disk and an SSH host differ (listing, watching, row actions) asks this, so
 * shared tree code never branches on the location itself.
 */
interface TreeBackend {
  /** SSH host of a remote project; undefined for the local disk. */
  readonly host?: string;
  /** Listings; per remote project (its own poll keeps it fresh), shared locally (the fs watcher does). */
  readonly cache: EntryCache;
  /** List each dir: one `fs.listDir` each locally, one ssh call for all of them remotely. */
  list(dirs: string[]): Promise<Record<string, Listing>>;
  watch(dir: string): void;
  unwatch(dir: string): void;
  /** What clicking a file does; undefined when it cannot be opened here. */
  openFile?(projectId: string, entry: DirEntry): void;
  menu(projectId: string, entry: DirEntry): MenuOption[];
}

const localBackend: TreeBackend = {
  cache: newCache(),
  async list(dirs) {
    const lists = await Promise.all(dirs.map((d) => window.vibeyard.fs.listDir(d).catch(() => [])));
    return Object.fromEntries(dirs.map((d, i) => [d, lists[i]]));
  },
  watch: (dir) => window.vibeyard.fs.watchDir(dir),
  unwatch: (dir) => window.vibeyard.fs.unwatchDir(dir),
  openFile: (projectId, entry) => { void openFileReaderChecked(projectId, entry.path); },
  menu: (projectId, entry) => entry.isDirectory
    ? [showInFolderMenuOption(entry), deleteMenuOption(entry)]
    : [
        {
          label: 'Open in Browser',
          action: () => { appState.addBrowserTabSession(projectId, pathToFileURL(entry.path)); },
        },
        showInFolderMenuOption(entry),
        { label: 'Properties', action: () => { showFileProperties(entry); } },
        deleteMenuOption(entry),
      ],
};

/**
 * A remote project's folders live on its host: rows can be dragged into a
 * session (the path is valid there) or have their path copied, but not
 * opened, revealed, inspected or trashed through the local filesystem.
 * There is no watcher on the host; the project's poll re-lists watched dirs.
 */
function sshBackend(host: string): TreeBackend {
  return {
    host,
    cache: newCache(),
    list: (dirs) => window.vibeyard.remote.listDirEntries(host, dirs)
      .catch(() => Object.fromEntries(dirs.map((d) => [d, null]))),
    watch: () => {},
    unwatch: () => {},
    menu: (_projectId, entry) => [copyPathMenuOption(entry)],
  };
}

const expandedFolders = new Map<string, Set<string>>();
const watchedByProject = new Map<string, Set<string>>();
let unsubFileChanged: (() => void) | null = null;

/**
 * One rendered tree. Its backend is fixed when the tree is rendered and
 * carried by everything the render starts, so a listing that resolves after
 * the tree was closed or re-rendered can never fall back to another location;
 * such stale work checks `isLive` and stops.
 */
interface Tree {
  project: ProjectRecord;
  container: HTMLElement;
  backend: TreeBackend;
}
const activeTrees = new Map<string, Tree>();
/** Remote backends outlive re-renders (their cache is what saves an ssh call); dropped on close. */
const remoteBackends = new Map<string, TreeBackend>();

function isLive(tree: Tree): boolean {
  return activeTrees.get(tree.project.id) === tree;
}

/**
 * How often an open remote tree re-lists its watched folders. There is no file
 * watcher on the host, so polling (one ssh call covering every watched folder)
 * is what keeps it live, like the local tree's watcher. Each poll is a fresh
 * ssh login (Windows OpenSSH has no connection sharing), hence 10 s.
 */
export const REMOTE_POLL_MS = 10_000;
const remotePolls = new Map<string, ReturnType<typeof setTimeout>>();

function getWatchedSet(projectId: string): Set<string> {
  let set = watchedByProject.get(projectId);
  if (!set) {
    set = new Set();
    watchedByProject.set(projectId, set);
  }
  return set;
}

function watchFolder(tree: Tree, folderPath: string): void {
  const set = getWatchedSet(tree.project.id);
  if (set.has(folderPath)) return;
  set.add(folderPath);
  tree.backend.watch(folderPath);
}

/** Schedule the next poll. Self-rescheduling, so two polls never overlap. */
function scheduleRemotePoll(projectId: string): void {
  if (remotePolls.has(projectId)) return;
  remotePolls.set(projectId, setTimeout(() => { void pollRemoteTree(projectId); }, REMOTE_POLL_MS));
}

function stopRemotePoll(projectId: string): void {
  const timer = remotePolls.get(projectId);
  if (timer === undefined) return;
  clearTimeout(timer);
  remotePolls.delete(projectId);
}

function sameListing(a: DirEntry[] | undefined, b: DirEntry[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((e, i) => e.path === b[i].path && e.isDirectory === b[i].isDirectory);
}

/**
 * Re-list every watched folder of a remote tree in one ssh call; patch the
 * ones that changed. The fired timer stays registered while the call runs, so
 * a re-render meanwhile cannot schedule a second, overlapping poll.
 */
async function pollRemoteTree(projectId: string): Promise<void> {
  const self = remotePolls.get(projectId);
  const tree = activeTrees.get(projectId);
  // The sidebar only renders the active project's panel: a tree left behind by
  // a project switch is detached. Stop polling it; the next render restarts.
  if (tree?.backend.host && tree.container.isConnected) {
    const dirs = [...(watchedByProject.get(projectId) ?? [])];
    if (dirs.length > 0 && !document.hidden) await refreshRemoteDirs(tree, dirs);
  }
  if (remotePolls.get(projectId) !== self) return; // stopped (closed) meanwhile
  remotePolls.delete(projectId);
  const now = activeTrees.get(projectId);
  if (now && now.backend === tree?.backend && now.container.isConnected) scheduleRemotePoll(projectId);
}

async function refreshRemoteDirs(tree: Tree, dirs: string[]): Promise<void> {
  const projectId = tree.project.id;
  const { backend } = tree;
  const result = await backend.list(dirs);
  // A re-render keeps the same backend; a close or host change drops it.
  const now = activeTrees.get(projectId);
  if (!now || now.backend !== backend) return;
  for (const dir of dirs) {
    const listed = result[dir];
    if (!listed || !watchedByProject.get(projectId)?.has(dir)) continue;
    const sorted = sortEntries(listed);
    backend.cache.failed.delete(dir);
    if (sameListing(backend.cache.entries.get(dir), sorted)) continue;
    backend.cache.entries.set(dir, sorted);
    reconcileDir(now, dir);
  }
}

/**
 * Stop watching `folderPath` and every watched directory nested beneath it, and
 * drop their cached listings. Used on collapse (keeps expansion state so a
 * re-expand restores the subtree) and on deletion (`clearExpanded`).
 */
function unwatchSubtree(tree: Tree, folderPath: string, clearExpanded = false): void {
  const projectId = tree.project.id;
  const set = watchedByProject.get(projectId);
  if (set) {
    for (const p of [...set]) {
      if (!isPathUnder(p, folderPath)) continue;
      set.delete(p);
      tree.backend.unwatch(p);
    }
  }
  const { entries } = tree.backend.cache;
  for (const p of [...entries.keys()]) {
    if (isPathUnder(p, folderPath)) entries.delete(p);
  }
  if (clearExpanded) {
    const exp = expandedFolders.get(projectId);
    if (exp) for (const p of [...exp]) if (isPathUnder(p, folderPath)) exp.delete(p);
  }
}

// Coalesce filesystem-change bursts: collect the affected directories and
// reconcile each once per animation frame, so an agent writing 50 files in a
// watched folder triggers a single batched DOM pass rather than 50.
const pendingDirs = new Set<string>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(flushPendingDirs);
}

function flushPendingDirs(): void {
  flushScheduled = false;
  const dirs = [...pendingDirs];
  pendingDirs.clear();
  for (const dir of dirs) {
    localBackend.cache.entries.delete(dir);
    localBackend.cache.inflight.delete(dir);
    for (const [projectId, paths] of watchedByProject) {
      const tree = activeTrees.get(projectId);
      // Local fs events say nothing about another backend's paths.
      if (tree?.backend !== localBackend || !paths.has(dir)) continue;
      reconcileDir(tree, dir);
    }
  }
}

/** Reconcile the rendered children of `dir` in a tree against the cache (or a fresh listing). */
function reconcileDir(tree: Tree, dir: string): void {
  const selector = `[data-folder-path="${CSS.escape(dir)}"]`;
  const target = tree.container.matches(selector)
    ? tree.container
    : tree.container.querySelector(selector);
  if (target instanceof HTMLElement) {
    const depth = Number(target.dataset.depth ?? '0');
    void reconcileChildren(tree, dir, depth, target);
  }
}

function ensureChangeSubscription(): void {
  if (unsubFileChanged) return;
  unsubFileChanged = window.vibeyard.fs.onFsChange((changes) => {
    if (changes.length === 0) return;
    // flushPendingDirs filters to dirs actually rendered in a tree; collecting
    // every changed dir here (dirs from open reader/viewer panes included) is
    // harmless and avoids an O(changes × projects) membership scan on this path.
    for (const change of changes) pendingDirs.add(change.dir);
    scheduleFlush();
  });
}

function getExpandedSet(projectId: string): Set<string> {
  let set = expandedFolders.get(projectId);
  if (!set) {
    set = new Set();
    expandedFolders.set(projectId, set);
  }
  return set;
}

/** Expanded folders under `root` that are actually shown: every ancestor up to `root` is expanded too. */
function visibleExpanded(projectId: string, root: string): string[] {
  const exp = getExpandedSet(projectId);
  const shown = (p: string): boolean => {
    for (let dir = dirname(p); dir !== root; dir = dirname(dir)) {
      if (!exp.has(dir) || !isPathUnder(dir, root)) return false;
    }
    return true;
  };
  return [...exp].filter((p) => p !== root && isPathUnder(p, root) && shown(p));
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return nameCollator.compare(a.name, b.name);
  });
}

export function toggleFolder(projectId: string, folderPath: string): boolean {
  const set = getExpandedSet(projectId);
  if (set.has(folderPath)) {
    set.delete(folderPath);
    return false;
  }
  set.add(folderPath);
  return true;
}

export function isExpanded(projectId: string, folderPath: string): boolean {
  return getExpandedSet(projectId).has(folderPath);
}

export function clearProjectState(projectId: string): void {
  expandedFolders.delete(projectId);
  closeFileTree(projectId);
}

export function closeFileTree(projectId: string): void {
  const tree = activeTrees.get(projectId);
  const watched = watchedByProject.get(projectId);
  if (watched) {
    if (tree) for (const p of watched) tree.backend.unwatch(p);
    watched.clear();
  }
  stopRemotePoll(projectId);
  // A remote listing is only kept fresh while its tree polls; reopening re-lists.
  remoteBackends.delete(projectId);
  activeTrees.delete(projectId);
}

/** @internal Test-only: clear the module-level entry cache. */
export function _resetForTesting(): void {
  localBackend.cache.entries.clear();
  localBackend.cache.inflight.clear();
  remoteBackends.clear();
  for (const id of [...remotePolls.keys()]) stopRemotePoll(id);
  expandedFolders.clear();
  watchedByProject.clear();
  activeTrees.clear();
  pendingDirs.clear();
  flushScheduled = false;
  if (unsubFileChanged) {
    unsubFileChanged();
    unsubFileChanged = null;
  }
}

/** Start listing each of `dirs` that is neither cached, loading, nor known to fail, in one backend call. */
function startLoads(tree: Tree, dirs: string[]): void {
  const { cache } = tree.backend;
  const todo = dirs.filter((d) => !cache.entries.has(d) && !cache.inflight.has(d) && !cache.failed.has(d));
  if (todo.length === 0) return;
  const batch = tree.backend.list(todo);
  for (const dir of todo) {
    const promise: Promise<Listing> = batch.then((result) => {
      // Superseded when an fs event dropped this load and started a fresh one.
      const current = cache.inflight.get(dir) === promise;
      if (current) cache.inflight.delete(dir);
      // A poll that finished first holds a newer listing: keep it.
      const newer = cache.entries.get(dir);
      if (newer) return newer;
      const entries = result[dir] ?? null;
      if (entries === null) {
        if (current) cache.failed.add(dir);
        return null;
      }
      const sorted = sortEntries(entries);
      if (current) cache.entries.set(dir, sorted);
      return sorted;
    });
    cache.inflight.set(dir, promise);
  }
}

async function loadEntries(tree: Tree, folderPath: string): Promise<Listing> {
  const { cache } = tree.backend;
  const cached = cache.entries.get(folderPath);
  if (cached) return cached;
  if (cache.failed.has(folderPath)) return null;
  startLoads(tree, [folderPath]);
  return cache.inflight.get(folderPath)!;
}

function makeRow(depth: number, entry: DirEntry, projectId: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'file-tree-row' + (entry.isDirectory ? ' is-dir' : ' is-file');
  row.style.paddingLeft = `${20 + depth * 14}px`;
  row.title = entry.path;

  const chevron = document.createElement('span');
  chevron.className = 'file-tree-chevron';
  if (entry.isDirectory) {
    chevron.textContent = '▸';
    if (isExpanded(projectId, entry.path)) chevron.classList.add('expanded');
  } else {
    chevron.classList.add('is-placeholder');
  }

  const icon = document.createElement('span');
  icon.className = 'file-tree-icon';
  icon.textContent = entry.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}';

  const label = document.createElement('span');
  label.className = 'file-tree-label';
  label.textContent = entry.name;

  row.appendChild(chevron);
  row.appendChild(icon);
  row.appendChild(label);
  return row;
}

function appendEmpty(container: HTMLElement, depth: number, text = '(empty)'): void {
  const empty = document.createElement('div');
  empty.className = 'file-tree-empty';
  empty.style.paddingLeft = `${20 + depth * 14}px`;
  empty.textContent = text;
  container.appendChild(empty);
}

/**
 * Build the DOM nodes for one entry: a row, plus (for directories) its adjacent
 * `.file-tree-children` subcontainer. The row carries `data-entry-path` so the
 * reconciler can locate it; a directory row's subcontainer is always its
 * immediate next sibling.
 */
function createEntry(tree: Tree, depth: number, entry: DirEntry): HTMLElement[] {
  const projectId = tree.project.id;
  const { backend } = tree;
  const row = makeRow(depth, entry, projectId);
  row.dataset.entryPath = entry.path;
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, backend.menu(projectId, entry));
  });

  if (entry.isDirectory) {
    const subContainer = document.createElement('div');
    subContainer.className = 'file-tree-children';

    if (isExpanded(projectId, entry.path)) {
      void renderChildren(tree, entry.path, depth + 1, subContainer);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowExpanded = toggleFolder(projectId, entry.path);
      row.querySelector('.file-tree-chevron')!.classList.toggle('expanded', nowExpanded);
      if (nowExpanded) {
        // An explicit expand retries a folder that failed to list, and loads
        // its remembered-expanded subfolders with it in one backend call.
        backend.cache.failed.delete(entry.path);
        startLoads(tree, [entry.path, ...visibleExpanded(projectId, entry.path)]);
        void renderChildren(tree, entry.path, depth + 1, subContainer);
      } else {
        unwatchSubtree(tree, entry.path);
        subContainer.innerHTML = '';
      }
    });
    return [row, subContainer];
  }

  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(FILE_PATH_DRAG_TYPE, entry.path);
    e.dataTransfer.setData('text/plain', entry.path);
  });
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    backend.openFile?.(projectId, entry);
  });
  return [row];
}

/** Full (re)build of a folder's children. Used for initial render and expand. */
async function renderChildren(
  tree: Tree,
  folderPath: string,
  depth: number,
  container: HTMLElement
): Promise<void> {
  container.dataset.folderPath = folderPath;
  container.dataset.depth = String(depth);
  watchFolder(tree, folderPath);
  // An ssh listing takes a moment; say so instead of showing a blank folder.
  if (tree.backend.host && !tree.backend.cache.entries.has(folderPath)) {
    container.innerHTML = '';
    appendEmpty(container, depth, 'Loading…');
  }
  const entries = await loadEntries(tree, folderPath);
  // Closed or re-rendered meanwhile: this container is no longer on screen.
  if (!isLive(tree)) return;
  container.innerHTML = '';

  if (entries === null) {
    appendEmpty(container, depth, '(could not list over SSH)');
    return;
  }
  if (entries.length === 0) {
    appendEmpty(container, depth);
    return;
  }

  for (const entry of entries) {
    for (const node of createEntry(tree, depth, entry)) container.appendChild(node);
  }
}

/**
 * Incrementally update a folder's children against the current disk state:
 * remove vanished entries (unwatching their subtree), insert new entries at the
 * correct sorted position, and leave unchanged rows — and their expanded
 * subtrees, scroll, and selection — untouched. Far cheaper and less disruptive
 * than rebuilding, which is what makes live agent edits feel smooth.
 */
async function reconcileChildren(
  tree: Tree,
  folderPath: string,
  depth: number,
  container: HTMLElement
): Promise<void> {
  const entries = await loadEntries(tree, folderPath);
  if (!isLive(tree)) return;
  // Keep what is on screen when a listing fails; the next poll retries.
  if (entries === null) return;
  const newByPath = new Map(entries.map((e) => [e.path, e] as const));

  // Index the rows currently rendered in this container (rows only; their
  // subcontainers are reached via nextElementSibling).
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    if (child instanceof HTMLElement && child.dataset.entryPath) {
      existing.set(child.dataset.entryPath, child);
    }
  }

  if (entries.length === 0) {
    for (const [p, row] of existing) {
      if (row.classList.contains('is-dir')) unwatchSubtree(tree, p, true);
    }
    container.innerHTML = '';
    appendEmpty(container, depth);
    return;
  }
  const emptyEl = container.querySelector(':scope > .file-tree-empty');
  if (emptyEl) emptyEl.remove();

  // Remove rows that vanished, or whose kind flipped (file <-> dir) — those get
  // recreated by the insertion pass below.
  for (const [p, row] of existing) {
    const next = newByPath.get(p);
    const kindMatches = next && next.isDirectory === row.classList.contains('is-dir');
    if (kindMatches) continue;
    const isDir = row.classList.contains('is-dir');
    const sub = isDir ? row.nextElementSibling : null;
    if (isDir) unwatchSubtree(tree, p, true);
    row.remove();
    if (sub instanceof HTMLElement && sub.classList.contains('file-tree-children')) sub.remove();
    existing.delete(p);
  }

  // Insert added entries before the first following entry that already exists,
  // preserving sorted order without disturbing unchanged rows. Anchors are
  // precomputed in one backward pass so a burst of N new files in a folder is
  // O(N) rather than O(N²).
  const anchors: (HTMLElement | null)[] = new Array(entries.length);
  let nextExisting: HTMLElement | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    anchors[i] = nextExisting;
    const found = existing.get(entries[i].path);
    if (found) nextExisting = found;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (existing.has(entry.path)) continue;
    const nodes = createEntry(tree, depth, entry);
    for (const node of nodes) container.insertBefore(node, anchors[i]);
    existing.set(entry.path, nodes[0]);
  }
}

async function showFileProperties(entry: DirEntry): Promise<void> {
  const [statResult, readResult] = await Promise.all([
    window.vibeyard.fs.stat(entry.path),
    window.vibeyard.fs.readFile(entry.path),
  ]);

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
  rows.push({ label: 'Path', value: entry.path, mono: true });
  rows.push({ label: 'Type', value: fileTypeLabel(entry.name) });
  rows.push({ label: 'Size', value: statResult.ok ? formatBytes(statResult.size) : '—' });
  rows.push({ label: 'Modified', value: statResult.ok ? formatMtime(statResult.mtimeMs) : '—' });

  if (readResult.ok) {
    const lines = readResult.content.length === 0 ? 0 : readResult.content.split('\n').length;
    rows.push({ label: 'Lines', value: lines.toLocaleString() });
    if (readResult.content.length > TOKEN_COUNT_MAX_CHARS) {
      rows.push({ label: 'Tokens', value: 'too large to count' });
    } else {
      rows.push({ label: 'Tokens', value: `~ ${estimateTokens(readResult.content).toLocaleString()}` });
    }
  } else {
    const why = readResult.reason === 'binary' ? 'binary file' : 'unreadable';
    rows.push({ label: 'Lines', value: `— (${why})` });
    rows.push({ label: 'Tokens', value: `— (${why})` });
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

/** Name of the OS file manager, used in the reveal menu labels. Exported for tests. */
export const FILE_MANAGER = isMac ? 'Finder' : isWin ? 'File Explorer' : 'File Manager';

/**
 * A folder opens in the file manager showing its own contents; a file is
 * revealed inside its parent folder, selected. Main picks the two apart.
 */
function showInFolderMenuOption(entry: DirEntry): MenuOption {
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

function copyPathMenuOption(entry: DirEntry): MenuOption {
  return {
    label: 'Copy Path',
    action: () => { void navigator.clipboard.writeText(entry.path); },
  };
}

function deleteMenuOption(entry: DirEntry): MenuOption {
  return {
    label: 'Delete',
    danger: true,
    action: () => confirmAndTrash(entry),
  };
}

function confirmAndTrash(entry: DirEntry): void {
  const kind = entry.isDirectory ? 'folder' : 'file';
  const message = entry.isDirectory
    ? `Move "${entry.name}" and its contents to the Trash?`
    : `Move "${entry.name}" to the Trash?`;
  showConfirmModal(
    `Delete ${kind}`,
    message,
    async () => {
      const result = await window.vibeyard.fs.trashItem(entry.path);
      if (!result.ok) {
        console.warn(`Failed to trash ${entry.path}: ${result.error ?? 'unknown error'}`);
      }
    },
    { confirmLabel: 'Delete', danger: true },
  );
}

export function renderFileTree(project: ProjectRecord, container: HTMLElement): void {
  ensureChangeSubscription();
  container.innerHTML = '';
  const loc = projectFolderLocation(project);
  if (!loc) {
    closeFileTree(project.id);
    return;
  }
  const kept = remoteBackends.get(project.id);
  const backend = !loc.host ? localBackend : kept?.host === loc.host ? kept : sshBackend(loc.host);
  // The project moved (local <-> remote, or another host): release the old
  // tree's watches, poll and cache against the location they were made on.
  const prev = activeTrees.get(project.id);
  if (prev && prev.backend !== backend) closeFileTree(project.id);
  if (backend.host) remoteBackends.set(project.id, backend);
  const tree: Tree = { project, container, backend };
  activeTrees.set(project.id, tree);
  if (backend.host) {
    // Folders left expanded load in one ssh call, not one login per level.
    startLoads(tree, [loc.path, ...visibleExpanded(project.id, loc.path)]);
    scheduleRemotePoll(project.id);
  }
  void renderChildren(tree, loc.path, 0, container);
}
