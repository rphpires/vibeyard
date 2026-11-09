import type { ProjectRecord } from '../state.js';
import { FILE_PATH_DRAG_TYPE, NATIVE_FILES_DRAG_TYPE, droppedFilePaths } from '../drag-types.js';
import { basename, dirname, isPathUnder } from '../../shared/platform.js';
import { projectFolderLocation } from '../../shared/project-folder.js';
import type { DirEntry } from '../../shared/types.js';
import { isMac } from '../platform.js';
import { localBackend, sshBackend, type Listing, type TreeBackend } from './file-tree-backends.js';
import {
  type TreeHandle, entryMenu, rootMenu, showMenuAt, openEntry, targetDir, pasteInto, importDropped,
  copyToTreeClipboard, confirmDelete, promptRename, isCutPending, onTreeClipboardChange,
} from './file-tree-actions.js';

export type { DirEntry };
export { FILE_MANAGER } from './file-tree-actions.js';

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
  /** What the menus, dialogs and shortcuts act through (`handle.root` is the project folder). */
  handle: TreeHandle;
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
  selectedByProject.clear();
  focusedTree = null;
  if (unsubClipboard) {
    unsubClipboard();
    unsubClipboard = null;
  }
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
  if (selectedByProject.get(projectId) === entry.path) row.classList.add('selected');
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
  if (isCutPending(entry.path, backend.host)) row.classList.add('cut');
  row.addEventListener('contextmenu', (e) => {
    selectPath(projectId, entry.path);
    showMenuAt(e, entryMenu(tree.handle, entry));
  });

  if (entry.isDirectory) {
    const subContainer = document.createElement('div');
    subContainer.className = 'file-tree-children';

    if (isExpanded(projectId, entry.path)) {
      void renderChildren(tree, entry.path, depth + 1, subContainer);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      selectPath(projectId, entry.path);
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
    selectPath(projectId, entry.path);
    openEntry(tree.handle, entry);
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
  const tree: Tree = { project, container, backend, handle: makeHandle(project.id, loc.path, backend, container) };
  activeTrees.set(project.id, tree);
  wireContainer(tree);
  if (backend.host) {
    // Folders left expanded load in one ssh call, not one login per level.
    startLoads(tree, [loc.path, ...visibleExpanded(project.id, loc.path)]);
    scheduleRemotePoll(project.id);
  }
  void renderChildren(tree, loc.path, 0, container);
  // A sidebar re-render replaced the focused tree: keep its shortcuts working.
  // The sidebar attaches the new container after this call, hence the frame.
  if (focusedTree === project.id) {
    requestAnimationFrame(() => {
      const idle = !document.activeElement || document.activeElement === document.body;
      if (idle && container.isConnected && focusedTree === project.id) container.focus({ preventScroll: true });
    });
  }
}

// ---------------------------------------------------------------------------
// Selection, shortcuts, drop
// ---------------------------------------------------------------------------

/** The selected row's path per project: survives re-renders, target of the keyboard shortcuts. */
const selectedByProject = new Map<string, string>();
/** Project whose tree had keyboard focus (restored when a re-render replaces the container). */
let focusedTree: string | null = null;
let unsubClipboard: (() => void) | null = null;

function rowFor(container: HTMLElement, path: string): HTMLElement | null {
  return container.querySelector(`.file-tree-row[data-entry-path="${CSS.escape(path)}"]`);
}

function selectPath(projectId: string, path: string | null): void {
  const container = activeTrees.get(projectId)?.container;
  container?.querySelectorAll('.file-tree-row.selected').forEach((r) => r.classList.remove('selected'));
  if (path === null) {
    selectedByProject.delete(projectId);
    return;
  }
  selectedByProject.set(projectId, path);
  if (container) rowFor(container, path)?.classList.add('selected');
}

/** The selected entry, read back from its row (null when nothing, or nothing still shown, is selected). */
function selectedEntry(tree: Tree): DirEntry | null {
  const path = selectedByProject.get(tree.project.id);
  const row = path ? rowFor(tree.container, path) : null;
  if (!path || !row) return null;
  return { name: basename(path), path, isDirectory: row.classList.contains('is-dir') };
}

function makeHandle(projectId: string, root: string, backend: TreeBackend, container: HTMLElement): TreeHandle {
  return {
    projectId,
    root,
    backend,
    refresh(dirs) {
      // A local tree follows the fs watcher; a remote one re-lists now instead of at the next poll.
      const now = activeTrees.get(projectId);
      if (!backend.host || now?.backend !== backend) return;
      const watched = watchedByProject.get(projectId);
      const shown = [...new Set(dirs)].filter((d) => watched?.has(d));
      if (shown.length > 0) void refreshRemoteDirs(now, shown);
    },
    select: (path) => selectPath(projectId, path),
    setBusy: (busy) => { (activeTrees.get(projectId)?.container ?? container).classList.toggle('file-tree-busy', busy); },
  };
}

function ensureClipboardSubscription(): void {
  if (unsubClipboard) return;
  unsubClipboard = onTreeClipboardChange(() => {
    for (const tree of activeTrees.values()) {
      tree.container.querySelectorAll<HTMLElement>('.file-tree-row[data-entry-path]').forEach((row) => {
        row.classList.toggle('cut', isCutPending(row.dataset.entryPath!, tree.backend.host));
      });
    }
  });
}

function onTreeKeydown(tree: Tree, e: KeyboardEvent): void {
  const t = tree.handle;
  const entry = selectedEntry(tree);
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'v') {
    void pasteInto(t, entry ? targetDir(entry) : t.root);
  } else if (mod && (key === 'c' || key === 'x') && entry) {
    copyToTreeClipboard(t, [entry], key === 'x');
  } else if ((e.key === 'Delete' || (isMac && mod && e.key === 'Backspace')) && entry) {
    confirmDelete(t, entry);
  } else if (e.key === 'F2' && entry) {
    promptRename(t, entry);
  } else if (e.key === 'Enter' && entry) {
    rowFor(tree.container, entry.path)?.click();
  } else if (e.key === 'Escape' && entry) {
    selectPath(tree.project.id, null);
  } else {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}

/** The folder a drop over `target` lands in: a folder row, a file row's folder, else the project folder. */
function dropDir(tree: Tree, target: EventTarget | null): { dir: string; el: HTMLElement } {
  const row = target instanceof Element ? target.closest<HTMLElement>('.file-tree-row[data-entry-path]') : null;
  if (!row || !tree.container.contains(row)) return { dir: tree.handle.root, el: tree.container };
  const path = row.dataset.entryPath!;
  if (row.classList.contains('is-dir')) return { dir: path, el: row };
  const parent = dirname(path);
  const parentRow = parent === tree.handle.root ? null : rowFor(tree.container, parent);
  return { dir: parent, el: parentRow ?? tree.container };
}

function clearDropTarget(container: HTMLElement): void {
  container.classList.remove('drop-target');
  container.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

/** Container-level wiring: empty-area menu, shortcuts, OS-file drop, focus tracking. Once per container. */
function wireContainer(tree: Tree): void {
  const { container } = tree;
  const projectId = tree.project.id;
  container.tabIndex = 0;
  ensureClipboardSubscription();
  // Listeners read the live tree, so a re-render handing over the same container stays correct.
  const live = () => activeTrees.get(projectId);
  if (container.dataset.treeWired) return;
  container.dataset.treeWired = '1';

  container.addEventListener('contextmenu', (e) => {
    const t = live();
    if (t?.container === container) showMenuAt(e, rootMenu(t.handle));
  });
  container.addEventListener('keydown', (e) => {
    const t = live();
    if (t?.container === container) onTreeKeydown(t, e);
  });
  container.addEventListener('focusin', () => { focusedTree = projectId; });
  container.addEventListener('focusout', () => {
    // A focusout caused by a re-render removing this container keeps the flag.
    setTimeout(() => {
      if (container.isConnected && !container.contains(document.activeElement) && focusedTree === projectId) focusedTree = null;
    }, 0);
  });

  container.addEventListener('dragover', (e) => {
    const t = live();
    if (!t || t.container !== container || !e.dataTransfer?.types.includes(NATIVE_FILES_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { el } = dropDir(t, e.target);
    if (!el.classList.contains('drop-target')) {
      clearDropTarget(container);
      el.classList.add('drop-target');
    }
  });
  container.addEventListener('dragleave', (e) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !container.contains(next)) clearDropTarget(container);
  });
  container.addEventListener('drop', (e) => {
    clearDropTarget(container);
    const t = live();
    if (!t || t.container !== container || !e.dataTransfer?.types.includes(NATIVE_FILES_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    importDropped(t.handle, droppedFilePaths(e.dataTransfer), dropDir(t, e.target).dir);
  });
}
