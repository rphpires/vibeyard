// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsChange } from '../../shared/types';

vi.mock('../state.js', () => ({
  appState: { addFileReaderSession: vi.fn(), addBrowserTabSession: vi.fn() },
}));
vi.mock('./modal.js', () => ({
  showConfirmModal: vi.fn(), showConfirmDialog: vi.fn(), showPropertiesDialog: vi.fn(),
  showModal: vi.fn(), closeModal: vi.fn(), setModalError: vi.fn(),
}));
vi.mock('./board/board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('../open-file-reader.js', () => ({ openFileReaderChecked: vi.fn() }));
vi.mock('../file-url.js', () => ({ pathToFileURL: (p: string) => `file://${p}` }));

import { renderFileTree, closeFileTree, toggleFolder, _resetForTesting, DirEntry, isExpanded, FILE_MANAGER, REMOTE_POLL_MS } from './file-tree.js';
import { openFileReaderChecked } from '../open-file-reader.js';
import { showConfirmModal, showModal, setModalError } from './modal.js';
import { _resetTreeClipboardForTesting } from './file-tree-actions.js';
import { showContextMenu, MenuOption } from './board/board-context-menu.js';

// --- Fake filesystem backing window.vibeyard.fs ---
let dirContents: Map<string, DirEntry[]>;
let fsChangeCb: ((changes: FsChange[]) => void) | null = null;
const watchedDirs = new Set<string>();

function entry(name: string, dir: string, isDirectory: boolean): DirEntry {
  return { name, path: `${dir}/${name}`, isDirectory };
}

beforeEach(() => {
  _resetForTesting();
  dirContents = new Map();
  fsChangeCb = null;
  watchedDirs.clear();
  (globalThis as any).window = globalThis;
  (globalThis as any).vibeyard = {
    fs: {
      listDir: vi.fn((dir: string) => Promise.resolve(dirContents.get(dir) ?? [])),
      showInFolder: vi.fn(() => Promise.resolve({ ok: true })),
      watchDir: vi.fn((dir: string) => { watchedDirs.add(dir); }),
      unwatchDir: vi.fn((dir: string) => { watchedDirs.delete(dir); }),
      onFsChange: vi.fn((cb: (c: FsChange[]) => void) => { fsChangeCb = cb; return () => { fsChangeCb = null; }; }),
    },
  };
});

// Resolve microtasks (listDir promises) and drain queued rAF callbacks until the
// reconcile pipeline (async loadEntries + DOM patch) has fully settled.
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    const cbs: FrameRequestCallback[] = (globalThis as any).__rafQueue ?? [];
    (globalThis as any).__rafQueue = [];
    for (const cb of cbs) cb(0);
    await Promise.resolve();
  }
}

// jsdom provides rAF, but we want deterministic control — stub it into a queue.
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  ((globalThis as any).__rafQueue ??= []).push(cb);
  return 1;
};

// jsdom does not implement CSS.escape.
if (!(globalThis as any).CSS) (globalThis as any).CSS = { escape: (s: string) => s };

function rows(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.file-tree-row'))
    .map((r) => (r as HTMLElement).dataset.entryPath!)
    .filter(Boolean);
}

function emit(changes: FsChange[]): void {
  fsChangeCb?.(changes);
}

/** Right-click a row and return the menu options handed to showContextMenu. */
function openMenu(container: HTMLElement, entryPath: string): MenuOption[] {
  vi.mocked(showContextMenu).mockClear();
  const row = container.querySelector(`[data-entry-path="${entryPath}"]`) as HTMLElement;
  row.dispatchEvent(new MouseEvent('contextmenu', { clientX: 5, clientY: 6 }));
  return vi.mocked(showContextMenu).mock.calls[0][2];
}

describe('file tree reconciliation', () => {
  it('adds a new file at the correct sorted position without rebuilding', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('c.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    expect(rows(container)).toEqual(['/proj/a.ts', '/proj/c.ts']);

    // Capture the existing 'a.ts' node — it must survive the reconcile (identity preserved).
    const aNode = container.querySelector('[data-entry-path="/proj/a.ts"]');

    dirContents.set('/proj', [
      entry('a.ts', '/proj', false),
      entry('b.ts', '/proj', false),
      entry('c.ts', '/proj', false),
    ]);
    emit([{ path: '/proj/b.ts', dir: '/proj', type: 'add' }]);
    await settle();

    expect(rows(container)).toEqual(['/proj/a.ts', '/proj/b.ts', '/proj/c.ts']);
    expect(container.querySelector('[data-entry-path="/proj/a.ts"]')).toBe(aNode);
  });

  it('inserts many new files at once in correct sorted order', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('z.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const next = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'z.ts'].map((n) => entry(n, '/proj', false));
    dirContents.set('/proj', next);
    emit(next.slice(1, 5).map((e) => ({ path: e.path, dir: '/proj', type: 'add' as const })));
    await settle();

    expect(rows(container)).toEqual([
      '/proj/a.ts', '/proj/b.ts', '/proj/c.ts', '/proj/d.ts', '/proj/e.ts', '/proj/z.ts',
    ]);
  });

  it('removes a deleted entry', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false), entry('b.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    emit([{ path: '/proj/b.ts', dir: '/proj', type: 'unlink' }]);
    await settle();

    expect(rows(container)).toEqual(['/proj/a.ts']);
  });

  it('preserves an expanded subtree when a sibling changes', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true), entry('z.ts', '/proj', false)]);
    dirContents.set('/proj/src', [entry('deep.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    // Expand /proj/src (the click handler toggles + renders).
    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    srcRow.dispatchEvent(new Event('click'));
    await settle();
    expect(isExpanded('p1', '/proj/src')).toBe(true);
    expect(rows(container)).toContain('/proj/src/deep.ts');

    // A new sibling file appears at the root.
    dirContents.set('/proj', [
      entry('src', '/proj', true),
      entry('y.ts', '/proj', false),
      entry('z.ts', '/proj', false),
    ]);
    emit([{ path: '/proj/y.ts', dir: '/proj', type: 'add' }]);
    await settle();

    // The expanded subtree's deep child is still present (subtree was not rebuilt).
    expect(rows(container)).toContain('/proj/src/deep.ts');
    expect(rows(container)).toContain('/proj/y.ts');
  });

  it('unwatches a removed directory subtree', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    dirContents.set('/proj/src', [entry('deep.ts', '/proj/src', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();
    const srcRow = container.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    srcRow.dispatchEvent(new Event('click'));
    await settle();
    expect(watchedDirs.has('/proj/src')).toBe(true);

    // Delete /proj/src
    dirContents.set('/proj', []);
    emit([{ path: '/proj/src', dir: '/proj', type: 'unlinkDir' }]);
    await settle();

    expect(rows(container)).toEqual([]);
    expect(watchedDirs.has('/proj/src')).toBe(false);
    expect(isExpanded('p1', '/proj/src')).toBe(false);
  });
});

describe('show in file manager menu option', () => {
  it('opens a folder in the file manager', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/src');
    options.find((o) => o.label === `Open in ${FILE_MANAGER}`)!.action();
    expect((globalThis as any).vibeyard.fs.showInFolder).toHaveBeenCalledWith('/proj/src');
  });

  it('reveals a file in the file manager', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/a.ts');
    options.find((o) => o.label === `Reveal in ${FILE_MANAGER}`)!.action();
    expect((globalThis as any).vibeyard.fs.showInFolder).toHaveBeenCalledWith('/proj/a.ts');
  });
});

describe('remote (SSH) project tree', () => {
  const remoteProject = () => ({ id: 'r1', path: '/srv/app', remoteHost: 'box' } as any);
  const fromDirContents = (dirs: string[]) => Object.fromEntries(dirs.map((d) => [d, dirContents.get(d) ?? []]));
  const allFail = (dirs: string[]) => Object.fromEntries(dirs.map((d) => [d, null]));

  /** Back window.vibeyard.remote with `result`, optionally held until `gate` resolves. */
  function useRemote(result: (dirs: string[]) => Record<string, DirEntry[] | null> = fromDirContents, gate?: Promise<void>) {
    const listDirEntries = vi.fn(async (_host: string, dirs: string[]) => {
      await gate;
      return result(dirs);
    });
    (globalThis as any).vibeyard.remote = { listDirEntries };
    return listDirEntries;
  }

  async function withFakeTimers(fn: () => Promise<void>): Promise<void> {
    vi.useFakeTimers();
    try { await fn(); } finally { vi.useRealTimers(); }
  }

  it('lists over ssh and never touches the local fs', async () => {
    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    const listDirEntries = useRemote();
    const container = document.createElement('div');
    renderFileTree(remoteProject(), container);
    await settle();

    expect(rows(container)).toEqual(['/srv/app/a.ts']);
    expect(listDirEntries).toHaveBeenCalledWith('box', ['/srv/app']);
    expect((globalThis as any).vibeyard.fs.listDir).not.toHaveBeenCalled();
    expect((globalThis as any).vibeyard.fs.watchDir).not.toHaveBeenCalled();
  });

  it('polls watched folders and patches in a new file', () => withFakeTimers(async () => {
    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    const listDirEntries = useRemote();
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderFileTree(remoteProject(), container);
    await settle();
    const aNode = container.querySelector('[data-entry-path="/srv/app/a.ts"]');

    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false), entry('b.ts', '/srv/app', false)]);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();

    expect(rows(container)).toEqual(['/srv/app/a.ts', '/srv/app/b.ts']);
    expect(container.querySelector('[data-entry-path="/srv/app/a.ts"]')).toBe(aNode);
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    expect(listDirEntries).toHaveBeenCalledTimes(3);

    // Closing the tree stops the poll.
    closeFileTree('r1');
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 2);
    expect(listDirEntries).toHaveBeenCalledTimes(3);
    container.remove();
  }));

  it('does not poll a detached tree', () => withFakeTimers(async () => {
    const listDirEntries = useRemote();
    renderFileTree(remoteProject(), document.createElement('div'));
    await settle();
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 3);
    expect(listDirEntries).toHaveBeenCalledTimes(1);
  }));

  it('a listing that lands after close never falls back to the local fs', async () => {
    dirContents.set('/srv/app', [entry('src', '/srv/app', true)]);
    dirContents.set('/srv/app/src', [entry('x.ts', '/srv/app/src', false)]);
    let release!: () => void;
    useRemote(fromDirContents, new Promise<void>((r) => { release = r; }));
    // /srv/app/src was left expanded, so the render would recurse into it.
    toggleFolder('r1', '/srv/app/src');
    renderFileTree(remoteProject(), document.createElement('div'));
    closeFileTree('r1');
    release();
    await settle();

    const fs = (globalThis as any).vibeyard.fs;
    expect(fs.listDir).not.toHaveBeenCalled();
    expect(fs.watchDir).not.toHaveBeenCalled();
  });

  it('loads shown expanded folders in one ssh call, skipping ones under a collapsed parent', async () => {
    dirContents.set('/srv/app', [entry('src', '/srv/app', true), entry('docs', '/srv/app', true)]);
    dirContents.set('/srv/app/src', [entry('lib', '/srv/app/src', true)]);
    dirContents.set('/srv/app/src/lib', [entry('x.ts', '/srv/app/src/lib', false)]);
    const listDirEntries = useRemote();
    toggleFolder('r1', '/srv/app/src');
    toggleFolder('r1', '/srv/app/src/lib');
    toggleFolder('r1', '/srv/app/docs/old'); // its parent docs is collapsed: not shown
    const container = document.createElement('div');
    renderFileTree(remoteProject(), container);
    await settle();

    expect(rows(container)).toContain('/srv/app/src/lib/x.ts');
    expect(listDirEntries).toHaveBeenCalledTimes(1);
    expect(listDirEntries.mock.calls[0][1]).toEqual(['/srv/app', '/srv/app/src', '/srv/app/src/lib']);
  });

  it('a failed folder is not re-listed by re-renders, only retried by the poll', () => withFakeTimers(async () => {
    const listDirEntries = useRemote(allFail);
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderFileTree(remoteProject(), container);
    await settle();
    expect(container.textContent).toBe('(could not list over SSH)');

    renderFileTree(remoteProject(), container);
    renderFileTree(remoteProject(), container);
    await settle();
    expect(listDirEntries).toHaveBeenCalledTimes(1);

    // The host comes back: the poll recovers the folder.
    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    listDirEntries.mockImplementation(async (_h: string, dirs: string[]) => fromDirContents(dirs));
    await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS);
    await settle();
    expect(rows(container)).toEqual(['/srv/app/a.ts']);
    container.remove();
  }));
});

describe('file operations', () => {
  const ok = (paths?: string[]) => Promise.resolve({ ok: true, ...(paths ? { paths } : {}) });
  const pick = (options: MenuOption[], label: string) => {
    const o = options.find((x) => x.label === label);
    if (!o) throw new Error(`no "${label}" in ${options.map((x) => x.label).join(', ')}`);
    return o;
  };
  const local = () => ({ id: 'p1', path: '/proj' } as any);
  const remote = () => ({ id: 'r1', path: '/srv/app', remoteHost: 'box' } as any);
  let fs: any;
  let rem: any;
  let clip: any;

  beforeEach(() => {
    vi.mocked(showConfirmModal).mockReset();
    vi.mocked(showModal).mockReset();
    vi.mocked(openFileReaderChecked).mockReset();
    _resetTreeClipboardForTesting();
    const api = (globalThis as any).vibeyard;
    fs = Object.assign(api.fs, {
      createEntry: vi.fn(() => ok(['/proj/new.ts'])),
      renameEntry: vi.fn(() => ok()),
      copyEntries: vi.fn(() => ok(['/proj/a (1).ts'])),
      pasteClipboard: vi.fn(() => Promise.resolve({ ok: true, empty: true })),
      deleteEntry: vi.fn(() => ok()),
      getDroppedFilePath: vi.fn((f: { path: string }) => f.path),
    });
    rem = api.remote = {
      listDirEntries: vi.fn(async (_h: string, dirs: string[]) => Object.fromEntries(dirs.map((d) => [d, dirContents.get(d) ?? []]))),
      copyEntries: vi.fn(() => ok(['/srv/app/src/a.ts'])),
      deleteEntry: vi.fn(() => ok()),
      upload: vi.fn(() => ok(['/srv/app/a.ts'])),
      download: vi.fn(() => ok(['/proj/x.ts'])),
      pasteClipboard: vi.fn(() => Promise.resolve({ ok: true, empty: true })),
      openCopy: vi.fn(() => ok(['/home/me/.vibeyard/remote-files/box/srv/app/a.ts'])),
    };
    clip = api.clipboard = { write: vi.fn(() => Promise.resolve()) };
  });

  async function tree(project: any): Promise<HTMLElement> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderFileTree(project, container);
    await settle();
    return container;
  }

  it('offers the full menu locally and the remote variant on a host', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true), entry('a.ts', '/proj', false)]);
    const c = await tree(local());
    expect(openMenu(c, '/proj/src').map((o) => o.label)).toEqual([
      'New File…', 'New Folder…', 'Cut', 'Copy', 'Paste', 'Copy Path', 'Rename…', `Open in ${FILE_MANAGER}`, 'Delete',
    ]);
    expect(openMenu(c, '/proj/a.ts').map((o) => o.label)).toEqual([
      'Open', 'Open in Browser', 'Cut', 'Copy', 'Paste', 'Copy Path', 'Rename…', `Reveal in ${FILE_MANAGER}`, 'Properties', 'Delete',
    ]);

    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    const r = await tree(remote());
    expect(openMenu(r, '/srv/app/a.ts').map((o) => o.label)).toEqual([
      'Open (read-only copy)', 'Cut', 'Copy', 'Paste', 'Copy Path', 'Rename…', 'Download…', 'Properties', 'Delete',
    ]);
  });

  it('the empty area offers New and Paste into the project folder', async () => {
    const c = await tree(local());
    vi.mocked(showContextMenu).mockClear();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const options = vi.mocked(showContextMenu).mock.calls[0][2];
    expect(options.map((o) => o.label)).toEqual(['New File…', 'New Folder…', 'Paste', 'Copy Path']);
  });

  it('Copy then Paste copies the entry, writing its path to the OS clipboard', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true), entry('a.ts', '/proj', false)]);
    const c = await tree(local());
    pick(openMenu(c, '/proj/a.ts'), 'Copy').action();
    expect(clip.write).toHaveBeenCalledWith('/proj/a.ts', 'explicit');

    pick(openMenu(c, '/proj/src'), 'Paste').action();
    await settle();
    expect(fs.pasteClipboard).toHaveBeenCalledWith('/proj/src');
    expect(fs.copyEntries).toHaveBeenCalledWith(['/proj/a.ts'], '/proj/src', false);
  });

  it('files or an image on the OS clipboard win over the tree clipboard', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    fs.pasteClipboard.mockImplementation(() => ok(['/proj/pasted-image.png']));
    const c = await tree(local());
    pick(openMenu(c, '/proj/a.ts'), 'Copy').action();
    pick(openMenu(c, '/proj/a.ts'), 'Paste').action();
    await settle();
    expect(fs.pasteClipboard).toHaveBeenCalledWith('/proj');
    expect(fs.copyEntries).not.toHaveBeenCalled();
  });

  it('Cut dims the row; pasting on the host moves it, re-lists, and clears the clipboard', async () => {
    dirContents.set('/srv/app', [entry('src', '/srv/app', true), entry('a.ts', '/srv/app', false)]);
    const c = await tree(remote());
    pick(openMenu(c, '/srv/app/a.ts'), 'Cut').action();
    const row = () => c.querySelector('[data-entry-path="/srv/app/a.ts"]')!;
    expect(row().classList.contains('cut')).toBe(true);

    rem.listDirEntries.mockClear();
    pick(openMenu(c, '/srv/app/src'), 'Paste').action();
    await settle();
    expect(rem.copyEntries).toHaveBeenCalledWith('box', ['/srv/app/a.ts'], '/srv/app/src', true);
    // The root (watched) is re-listed right away; the collapsed src is not.
    expect(rem.listDirEntries).toHaveBeenCalledWith('box', ['/srv/app']);
    expect(row()?.classList.contains('cut') ?? false).toBe(false);
  });

  it('pasting a local copy into a remote tree uploads it', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    const c = await tree(local());
    pick(openMenu(c, '/proj/a.ts'), 'Copy').action();
    closeFileTree('p1');

    const r = await tree(remote());
    r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    pick(vi.mocked(showContextMenu).mock.calls.at(-1)![2], 'Paste').action();
    await settle();
    expect(rem.upload).toHaveBeenCalledWith('box', ['/proj/a.ts'], '/srv/app');
  });

  it('deleting on the host warns it is permanent, then deletes', async () => {
    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    const c = await tree(remote());
    pick(openMenu(c, '/srv/app/a.ts'), 'Delete').action();
    const [title, message, onConfirm] = vi.mocked(showConfirmModal).mock.calls[0];
    expect(title).toBe('Delete file');
    expect(message).toMatch(/Permanently delete "a.ts" on box\? This cannot be undone/);
    onConfirm();
    await settle();
    expect(rem.deleteEntry).toHaveBeenCalledWith('box', '/srv/app/a.ts');
  });

  it('keyboard: a click selects; F2 renames, Delete deletes, Ctrl/Cmd+C copies', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    const c = await tree(local());
    const row = c.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(row.classList.contains('selected')).toBe(true);

    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    expect(vi.mocked(showModal).mock.calls[0][0]).toBe('Rename folder');
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(vi.mocked(showConfirmModal).mock.calls[0][1]).toMatch(/Move "src" and its contents to the Trash/);
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, metaKey: true, bubbles: true }));
    expect(clip.write).toHaveBeenCalledWith('/proj/src', 'explicit');
  });

  it('dropping OS files on a folder copies them into it', async () => {
    dirContents.set('/proj', [entry('src', '/proj', true)]);
    const c = await tree(local());
    const target = c.querySelector('[data-entry-path="/proj/src"]') as HTMLElement;
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as any;
    drop.dataTransfer = { types: ['Files'], files: [{ path: 'C:/Users/me/shot.png' }] };
    target.dispatchEvent(drop);
    await settle();
    expect(fs.copyEntries).toHaveBeenCalledWith(['C:/Users/me/shot.png'], '/proj/src', false);
  });

  it('a remote file click opens a read-only local copy', async () => {
    dirContents.set('/srv/app', [entry('a.ts', '/srv/app', false)]);
    const c = await tree(remote());
    (c.querySelector('[data-entry-path="/srv/app/a.ts"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(rem.openCopy).toHaveBeenCalledWith('box', '/srv/app/a.ts');
    expect(openFileReaderChecked).toHaveBeenCalledWith('r1', '/home/me/.vibeyard/remote-files/box/srv/app/a.ts');
  });

  it('New Folder validates the name and creates it', async () => {
    const c = await tree(local());
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    pick(vi.mocked(showContextMenu).mock.calls.at(-1)![2], 'New Folder…').action();
    const onConfirm = vi.mocked(showModal).mock.calls[0][2];
    await onConfirm({ name: 'a/b' });
    expect(setModalError).toHaveBeenCalledWith('name', expect.stringMatching(/cannot contain/));
    await onConfirm({ name: 'lib' });
    expect(fs.createEntry).toHaveBeenCalledWith('/proj', 'lib', 'dir');
  });
});
