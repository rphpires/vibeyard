// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsChange } from '../../shared/types';

vi.mock('../state.js', () => ({
  appState: { addFileReaderSession: vi.fn(), addBrowserTabSession: vi.fn() },
}));
vi.mock('./modal.js', () => ({ showConfirmModal: vi.fn(), showPropertiesDialog: vi.fn() }));
vi.mock('./board/board-context-menu.js', () => ({ showContextMenu: vi.fn() }));
vi.mock('../open-file-reader.js', () => ({ openFileReaderChecked: vi.fn() }));
vi.mock('../file-url.js', () => ({ pathToFileURL: (p: string) => `file://${p}` }));

import { renderFileTree, closeFileTree, toggleFolder, _resetForTesting, DirEntry, isExpanded, FILE_MANAGER, REMOTE_POLL_MS } from './file-tree.js';
import { openFileReaderChecked } from '../open-file-reader.js';
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
    expect(options.map((o) => o.label)).toEqual([`Open in ${FILE_MANAGER}`, 'Delete']);

    options[0].action();
    expect((globalThis as any).vibeyard.fs.showInFolder).toHaveBeenCalledWith('/proj/src');
  });

  it('reveals a file in the file manager', async () => {
    dirContents.set('/proj', [entry('a.ts', '/proj', false)]);
    const container = document.createElement('div');
    renderFileTree({ id: 'p1', path: '/proj' } as any, container);
    await settle();

    const options = openMenu(container, '/proj/a.ts');
    expect(options.map((o) => o.label)).toEqual([
      'Open in Browser', `Reveal in ${FILE_MANAGER}`, 'Properties', 'Delete',
    ]);

    options[1].action();
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

  it('offers only Copy Path, and a file click opens nothing', async () => {
    dirContents.set('/srv/app', [entry('src', '/srv/app', true), entry('a.ts', '/srv/app', false)]);
    useRemote();
    const container = document.createElement('div');
    renderFileTree(remoteProject(), container);
    await settle();

    expect(openMenu(container, '/srv/app/src').map((o) => o.label)).toEqual(['Copy Path']);
    expect(openMenu(container, '/srv/app/a.ts').map((o) => o.label)).toEqual(['Copy Path']);
    (container.querySelector('[data-entry-path="/srv/app/a.ts"]') as HTMLElement).dispatchEvent(new Event('click'));
    expect(vi.mocked(openFileReaderChecked)).not.toHaveBeenCalled();
  });
});
