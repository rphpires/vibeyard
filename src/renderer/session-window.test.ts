// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The controller is wiring: split-layout / tab-bar / terminal-pane / doc-chrome are
// mocked (their own tests cover them), the child window is a real jsdom window (an
// iframe's), so the controller works against a second document of another realm.

const handlers: Record<string, Array<(data?: unknown) => void>> = {};
const fakeState = {
  projects: [] as Array<{ id: string; name: string; sessions: unknown[] }>,
  activeProjectId: 'A' as string | null,
  on: vi.fn((event: string, cb: (data?: unknown) => void) => {
    (handlers[event] ??= []).push(cb);
    return () => {};
  }),
};
vi.mock('./state.js', () => ({ appState: fakeState }));

const layout = {
  createLayoutView: vi.fn((kind: string, container: HTMLElement) => ({ kind, container, doc: container.ownerDocument })),
  destroyLayoutView: vi.fn(),
  evacuateLayoutView: vi.fn(),
  renderLayout: vi.fn(),
};
vi.mock('./components/split-layout.js', () => layout);

const tabBar = {
  buildTabBarDom: vi.fn((doc: Document) => {
    const root = doc.createElement('div');
    root.id = 'tab-bar';
    root.innerHTML = '<div id="tab-list"></div><div id="tab-actions"></div>';
    return root;
  }),
  createTabBarView: vi.fn((kind: string, root: HTMLElement) => ({ kind, root, doc: root.ownerDocument })),
  destroyTabBarView: vi.fn(),
  renderTabBars: vi.fn(),
};
vi.mock('./components/tab-bar.js', () => tabBar);

const terminal = { fitAllVisible: vi.fn() };
vi.mock('./components/terminal-pane.js', () => terminal);

const chromeCleanup = vi.fn();
const docChrome = { installDocChrome: vi.fn(() => chromeCleanup) };
vi.mock('./doc-chrome.js', () => docChrome);

const shortcuts = { shortcutManager: { matchEvent: vi.fn(() => false) } };
vi.mock('./shortcuts.js', () => shortcuts);

vi.mock('./i18n.js', () => ({ t: (key: string) => key }));

let onClosedCb: (() => void) | null = null;
const sessionWindowApi = {
  focus: vi.fn(),
  close: vi.fn(),
  setTitle: vi.fn(),
  setZoom: vi.fn(),
  onClosed: vi.fn((cb: () => void) => { onClosedCb = cb; return () => {}; }),
};
const ptyKill = vi.fn();
(window as unknown as { vibeyard: unknown }).vibeyard = {
  sessionWindow: sessionWindowApi,
  pty: { kill: ptyKill },
};

const mainContainer = document.createElement('div');
mainContainer.id = 'terminal-container';
document.body.appendChild(mainContainer);

let frames: HTMLIFrameElement[] = [];
function newChildWindow(): Window {
  const iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  frames.push(iframe);
  const win = iframe.contentWindow!;
  // jsdom without pretendToBeVisual has no rAF; run frames synchronously.
  (win as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (cb) => { cb(0); return 1; };
  return win;
}
const openSpy = vi.fn((_url?: string, _name?: string) => newChildWindow());
window.open = openSpy as unknown as typeof window.open;

const windowState = await import('./session-window-state.js');
const sw = await import('./session-window.js');
sw.initSessionWindow();

function emit(event: string, data?: unknown): void {
  for (const cb of handlers[event] ?? []) cb(data);
}
function childWin(): Window {
  return openSpy.mock.results[openSpy.mock.results.length - 1].value as Window;
}

describe('session window controller', () => {
  beforeEach(() => {
    fakeState.projects = [
      { id: 'A', name: 'A', sessions: [] },
      { id: 'B', name: 'B', sessions: [] },
      { id: 'C', name: 'C', sessions: [] },
    ];
    fakeState.activeProjectId = 'A';
  });

  afterEach(() => {
    // Simulate the main process reporting the child closed, then reset.
    onClosedCb?.();
    vi.clearAllMocks();
    windowState.setDetachedProjectId(null);
    for (const f of frames) f.remove();
    frames = [];
  });

  it('opens the window, builds its layout and detaches the project', () => {
    sw.openSessionWindow('B');

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('about:blank', 'vibeyard-sessions');
    expect(windowState.getDetachedProjectId()).toBe('B');
    expect(sessionWindowApi.setTitle).toHaveBeenCalledWith('B — Vibeyard');

    const doc = childWin().document;
    expect(docChrome.installDocChrome).toHaveBeenCalledWith(doc, document);
    const root = doc.querySelector('.session-window');
    expect(root).not.toBeNull();
    const tabBarRoot = root!.querySelector('#tab-bar')!;
    const panes = root!.querySelector<HTMLElement>('[id="terminal-container"]')!;
    expect(tabBarRoot).not.toBeNull();
    expect(panes).not.toBeNull();
    // Tab bar first, panes below.
    expect(root!.firstElementChild).toBe(tabBarRoot);

    const back = tabBarRoot.querySelector<HTMLButtonElement>('#tab-actions .session-window-return')!;
    expect(back).not.toBeNull();
    expect(back.textContent).toContain('sessionWindow.returnToMain');

    expect(layout.createLayoutView).toHaveBeenCalledWith('sessions', panes);
    expect(tabBar.createTabBarView).toHaveBeenCalledWith('sessions', tabBarRoot);
    expect(layout.renderLayout).toHaveBeenCalled();
    expect(tabBar.renderTabBars).toHaveBeenCalled();
  });

  it('a second open swaps the project without opening another window', () => {
    sw.openSessionWindow('B');
    const view = layout.createLayoutView.mock.results[0].value;
    layout.renderLayout.mockClear();

    sw.openSessionWindow('C');

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(windowState.getDetachedProjectId()).toBe('C');
    // B's panes go back to the main window (hidden) before C's move in.
    expect(layout.evacuateLayoutView).toHaveBeenCalledWith(view, mainContainer);
    expect(layout.renderLayout).toHaveBeenCalled();
    expect(sessionWindowApi.setTitle).toHaveBeenLastCalledWith('C — Vibeyard');
    expect(sessionWindowApi.focus).toHaveBeenCalled();
  });

  it('onClosed returns the panes to the main window and re-attaches the project, killing no PTY', () => {
    sw.openSessionWindow('B');
    const view = layout.createLayoutView.mock.results[0].value;
    const tabView = tabBar.createTabBarView.mock.results[0].value;
    layout.renderLayout.mockClear();

    onClosedCb!();

    expect(windowState.getDetachedProjectId()).toBeNull();
    expect(layout.evacuateLayoutView).toHaveBeenCalledWith(view, mainContainer);
    expect(layout.destroyLayoutView).toHaveBeenCalledWith(view);
    expect(tabBar.destroyTabBarView).toHaveBeenCalledWith(tabView);
    expect(chromeCleanup).toHaveBeenCalled();
    expect(layout.renderLayout).toHaveBeenCalled();
    expect(ptyKill).not.toHaveBeenCalled();
    expect(sw.isSessionWindowOpen()).toBe(false);

    // Idempotent.
    onClosedCb!();
    expect(layout.evacuateLayoutView).toHaveBeenCalledTimes(1);

    // A later open starts a fresh window.
    sw.openSessionWindow('B');
    expect(openSpy).toHaveBeenCalledTimes(2);
  });

  it('moves the panes back synchronously on the child\'s pagehide, before it is gone', () => {
    sw.openSessionWindow('B');
    const view = layout.createLayoutView.mock.results[0].value;

    childWin().dispatchEvent(new Event('pagehide'));

    expect(layout.evacuateLayoutView).toHaveBeenCalledWith(view, mainContainer);
    expect(windowState.getDetachedProjectId()).toBeNull();
    onClosedCb!();
    expect(layout.evacuateLayoutView).toHaveBeenCalledTimes(1);
  });

  it('closeSessionWindow moves the panes back first, then closes; idempotent', () => {
    sw.closeSessionWindow();
    expect(sessionWindowApi.close).not.toHaveBeenCalled();

    sw.openSessionWindow('B');
    sw.closeSessionWindow();
    expect(layout.evacuateLayoutView).toHaveBeenCalledTimes(1);
    expect(sessionWindowApi.close).toHaveBeenCalledTimes(1);
    expect(windowState.getDetachedProjectId()).toBeNull();

    sw.closeSessionWindow();
    expect(sessionWindowApi.close).toHaveBeenCalledTimes(1);
  });

  it('the "Return to main window" button closes the window', () => {
    sw.openSessionWindow('B');
    childWin().document.querySelector<HTMLButtonElement>('.session-window-return')!.click();
    expect(sessionWindowApi.close).toHaveBeenCalled();
    expect(windowState.getDetachedProjectId()).toBeNull();
  });

  it('removing the detached project closes the window; another project does not', () => {
    sw.openSessionWindow('B');
    emit('project-removed', 'C');
    expect(sessionWindowApi.close).not.toHaveBeenCalled();
    emit('project-removed', 'B');
    expect(sessionWindowApi.close).toHaveBeenCalled();
  });

  it('renaming the detached project updates the title', () => {
    sw.openSessionWindow('B');
    fakeState.projects[1].name = 'Bee';
    emit('project-changed');
    expect(sessionWindowApi.setTitle).toHaveBeenLastCalledWith('Bee — Vibeyard');
  });

  it('a resize of the child window refits the panes of its document', () => {
    sw.openSessionWindow('B');
    const win = childWin();
    terminal.fitAllVisible.mockClear();
    win.dispatchEvent(new Event('resize'));
    expect(terminal.fitAllVisible).toHaveBeenCalledWith(win.document);
  });

  it('keydown in the child document reaches the shortcut manager', () => {
    sw.openSessionWindow('B');
    const doc = childWin().document;
    const e = new (childWin() as unknown as typeof globalThis).KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true });
    doc.body.dispatchEvent(e);
    expect(shortcuts.shortcutManager.matchEvent).toHaveBeenCalledWith(e);
  });

  it('treats a closed child as gone and opens a fresh one', () => {
    sw.openSessionWindow('B');
    const first = childWin();
    Object.defineProperty(first, 'closed', { value: true, configurable: true });

    sw.openSessionWindow('C');
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(windowState.getDetachedProjectId()).toBe('C');
  });

  it('closes the window when the main document unloads', () => {
    sw.openSessionWindow('B');
    window.dispatchEvent(new Event('beforeunload'));
    expect(sessionWindowApi.close).toHaveBeenCalled();
  });

  it('focusSessionWindow focuses via the main process; isSessionWindowFocused asks the child document', () => {
    expect(sw.isSessionWindowFocused()).toBe(false);
    sw.openSessionWindow('B');
    sw.focusSessionWindow();
    expect(sessionWindowApi.focus).toHaveBeenCalled();
    const doc = childWin().document;
    vi.spyOn(doc, 'hasFocus').mockReturnValue(true);
    expect(sw.isSessionWindowFocused()).toBe(true);
  });

  it('ignores an unknown project', () => {
    sw.openSessionWindow('nope');
    expect(openSpy).not.toHaveBeenCalled();
    expect(windowState.getDetachedProjectId()).toBeNull();
  });
});
