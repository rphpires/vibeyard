// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tab bar views: the main window's #tab-bar (index.html nodes) and a sessions
// window's tab bar built by buildTabBarDom, each filtered through viewTabs.

const { fakeState, closeTabsByMode, showModal } = vi.hoisted(() => ({
  closeTabsByMode: vi.fn(),
  showModal: vi.fn(),
  fakeState: {
  projects: [] as Array<Record<string, any>>,
  activeProjectId: null as string | null,
  get activeProject() { return this.projects.find((p) => p.id === this.activeProjectId); },
  preferences: {} as Record<string, unknown>,
  profiles: [] as unknown[],
  on: vi.fn(),
  addSession: vi.fn(),
  addBrowserTabSession: vi.fn(),
  addMcpInspectorSession: vi.fn(),
  setActiveSession: vi.fn(),
  reorderSession: vi.fn(),
  renameSession: vi.fn(),
  toggleSwarm: vi.fn(),
  },
}));
vi.mock('../../state.js', () => ({ appState: fakeState, MAX_SESSION_NAME_LENGTH: 60 }));
vi.mock('../../session-activity.js', () => ({ getStatus: vi.fn(() => 'idle'), onChange: vi.fn() }));
vi.mock('../../session-unread.js', () => ({ isUnread: vi.fn(() => false), onChange: vi.fn() }));
vi.mock('../../github-unread.js', () => ({ hasUnreadInProject: vi.fn(() => false), onChange: vi.fn() }));
vi.mock('../../git-status.js', () => ({
  onChange: vi.fn(), getGitStatus: vi.fn(), getActiveGitPath: vi.fn(), refreshGitStatus: vi.fn(),
}));
vi.mock('../share-dialog.js', () => ({ showShareDialog: vi.fn() }));
vi.mock('../../sharing/peer-host.js', () => ({ isSharing: vi.fn(() => false) }));
vi.mock('../../sharing/share-manager.js', () => ({ endShare: vi.fn(), onShareChange: vi.fn() }));
vi.mock('../session-inspector.js', () => ({
  openInspector: vi.fn(), isInspectorOpen: vi.fn(() => false), getInspectedSessionId: vi.fn(), closeInspector: vi.fn(),
}));
vi.mock('../../provider-availability.js', () => ({
  hasMultipleAvailableProviders: vi.fn(() => false),
  getProviderCapabilities: vi.fn(() => null),
  loadProviderAvailability: vi.fn(() => Promise.resolve()),
  getProviderAvailabilitySnapshot: vi.fn(() => ({ providers: [], availability: new Map() })),
}));
vi.mock('../resume-with-provider-menu.js', () => ({ buildResumeWithProviderItems: vi.fn(() => []) }));
vi.mock('../../session-close.js', () => ({ closeTab: vi.fn(), closeTabsByMode }));
vi.mock('../modal.js', () => ({ showModal, closeModal: vi.fn(), setModalError: vi.fn() }));
vi.mock('../join-dialog.js', () => ({ showJoinDialog: vi.fn() }));
vi.mock('../path-autocomplete.js', () => ({ attachPathAutocomplete: vi.fn(() => ({ refresh: vi.fn() })) }));
vi.mock('../../run-location.js', () => ({ resolveRunLocation: vi.fn() }));

import { setDetachedProjectId, setMainViewSelection, _resetForTesting as resetDetached } from '../../session-window-state.js';
import { showShareDialog } from '../share-dialog.js';
import { showJoinDialog } from '../join-dialog.js';
import { renderTabList, render } from './tab-list.js';
import { createTabBarView, destroyTabBarView, buildTabBarDom, type TabBarView } from './index.js';
import { quickNewSession, promptNewSession } from './session-menu.js';
import { getActiveContextMenu, hideTabContextMenu } from './menu.js';

function project(id: string, sessions: Array<{ id: string; type?: string; detached?: boolean }>) {
  return {
    id,
    name: id,
    path: `/${id}`,
    sessions: sessions.map((s) => ({ id: s.id, name: s.id, ...s })),
    activeSessionId: sessions[0]?.id ?? null,
    layout: { mode: 'tabs', splitPanes: [] },
  };
}

const tabIds = (view: TabBarView): string[] =>
  Array.from(view.tabListEl.querySelectorAll<HTMLElement>('.tab-item')).map((t) => t.dataset.sessionId!);

let views: TabBarView[] = [];
function view(kind: 'main' | 'sessions', doc: Document = document): TabBarView {
  const root = buildTabBarDom(doc);
  doc.body.appendChild(root);
  const v = createTabBarView(kind, root);
  views.push(v);
  return v;
}

beforeEach(() => {
  for (const v of views) destroyTabBarView(v);
  views = [];
  hideTabContextMenu();
  document.body.innerHTML = '';
  resetDetached();
  vi.clearAllMocks();
  (window as any).vibeyard = { remote: { listHosts: vi.fn(() => Promise.resolve([])) } };
  fakeState.projects = [
    project('A', [{ id: 'a1' }]),
    project('B', [
      { id: 'ov', type: 'project-tab' },
      { id: 'cli1' },
      { id: 'kb', type: 'kanban' },
      { id: 'file1', type: 'file-reader' },
      { id: 'tm', type: 'team' },
      { id: 'web1', type: 'browser-tab' },
      { id: 'gone', detached: true },
    ]),
  ];
  fakeState.activeProjectId = 'B';
});

describe('renderTabList per view', () => {
  it('with B detached, the sessions view lists only B\'s CLI/file/browser tabs', () => {
    setDetachedProjectId('B');
    fakeState.activeProjectId = 'A';
    const sessions = view('sessions');
    renderTabList(sessions);
    expect(tabIds(sessions)).toEqual(['cli1', 'file1', 'web1']);
  });

  it('with B detached and active, the main view lists only B\'s Overview/Kanban/Team', () => {
    setDetachedProjectId('B');
    const main = view('main');
    renderTabList(main);
    expect(tabIds(main)).toEqual(['ov', 'kb', 'tm']);
  });

  it('without a detached project the main view lists every tab, as before', () => {
    const main = view('main');
    renderTabList(main);
    expect(tabIds(main)).toEqual(['ov', 'cli1', 'kb', 'file1', 'tm', 'web1']);
  });

  it('a sessions view with no project renders an empty list', () => {
    const sessions = view('sessions');
    renderTabList(sessions);
    expect(tabIds(sessions)).toEqual([]);
  });

  it('render() redraws every registered view, and stops drawing a destroyed one', () => {
    setDetachedProjectId('B');
    const main = view('main');
    const sessions = view('sessions');
    main.tabListEl.innerHTML = '';
    sessions.tabListEl.innerHTML = '';
    render();
    expect(tabIds(main)).toEqual(['ov', 'kb', 'tm']);
    expect(tabIds(sessions)).toEqual(['cli1', 'file1', 'web1']);
    destroyTabBarView(sessions);
    sessions.tabListEl.innerHTML = '';
    render();
    expect(tabIds(sessions)).toEqual([]);
  });

  it('builds tabs with the view\'s own document', () => {
    const other = document.implementation.createHTMLDocument('sessions');
    setDetachedProjectId('B');
    const sessions = view('sessions', other);
    renderTabList(sessions);
    const tab = sessions.tabListEl.querySelector('.tab-item')!;
    expect(tab.ownerDocument).toBe(other);
  });
});

describe('buildTabBarDom', () => {
  it('builds the list and actions without the git status bar or the project-terminal toggle', () => {
    const root = buildTabBarDom(document);
    expect(root.querySelector('#tab-list')).not.toBeNull();
    expect(root.querySelector('#btn-add-session')).not.toBeNull();
    expect(root.querySelector('#btn-add-session-menu')).not.toBeNull();
    expect(root.querySelector('#btn-add-browser-tab')).not.toBeNull();
    expect(root.querySelector('#btn-more')).not.toBeNull();
    expect(root.querySelector('#git-status')).toBeNull();
    expect(root.querySelector('#btn-toggle-terminal')).toBeNull();
  });
});

describe('view buttons act on the view\'s project', () => {
  it('quickNewSession(\'B\') adds to B even with A active', () => {
    fakeState.activeProjectId = 'A';
    quickNewSession('B');
    expect(fakeState.addSession).toHaveBeenCalledWith('B', expect.any(String));
  });

  it('quickNewSession() still defaults to the active project', () => {
    fakeState.activeProjectId = 'A';
    quickNewSession();
    expect(fakeState.addSession).toHaveBeenCalledWith('A', expect.any(String));
  });

  it('the sessions view\'s New session and browser buttons target the detached project', () => {
    setDetachedProjectId('B');
    fakeState.activeProjectId = 'A';
    const sessions = view('sessions');
    sessions.root.querySelector<HTMLElement>('#btn-add-session')!.click();
    expect(fakeState.addSession).toHaveBeenCalledWith('B', expect.any(String));
    sessions.root.querySelector<HTMLElement>('#btn-add-browser-tab')!.click();
    expect(fakeState.addBrowserTabSession).toHaveBeenCalledWith('B');
  });

  it('promptNewSession mounts its dialog in the given document, for the given project', async () => {
    fakeState.activeProjectId = 'A';
    const other = document.implementation.createHTMLDocument('sessions');
    await promptNewSession(undefined, { projectId: 'B', doc: other });
    expect(showModal).toHaveBeenCalledTimes(1);
    const [, fields, , opts] = showModal.mock.calls[0];
    expect(opts).toMatchObject({ doc: other });
    const runOn = (fields as Array<{ id: string; options?: Array<{ value: string }> }>).find((f) => f.id === 'run-on')!;
    expect(runOn.options![0].value).toBe('[project]');
  });
});

describe('menus and drag in a view', () => {
  it('the tab context menu opens in the view\'s document and closes all within the view\'s tabs', () => {
    const other = document.implementation.createHTMLDocument('sessions');
    setDetachedProjectId('B');
    const sessions = view('sessions', other);
    renderTabList(sessions);
    const tab = sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="file1"]')!;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const menu = getActiveContextMenu()!;
    expect(menu.ownerDocument).toBe(other);
    expect(other.body.contains(menu)).toBe(true);
    const closeAll = Array.from(menu.querySelectorAll<HTMLElement>('.tab-context-menu-item'))
      .find((el) => el.textContent === 'Close All')!;
    closeAll.click();
    const [projectId, mode, , tabs] = closeTabsByMode.mock.calls[0];
    expect([projectId, mode]).toEqual(['B', 'all']);
    expect((tabs as Array<{ id: string }>).map((s) => s.id)).toEqual(['cli1', 'file1', 'web1']);
    // A click in the view's document dismisses the menu.
    sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="file1"]')!.click();
    expect(getActiveContextMenu()).toBeNull();
  });

  it('Move Right skips tabs that belong to the other window', () => {
    setDetachedProjectId('B');
    const sessions = view('sessions');
    renderTabList(sessions);
    const tab = sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="cli1"]')!;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const moveRight = Array.from(getActiveContextMenu()!.querySelectorAll<HTMLElement>('.tab-context-menu-item'))
      .find((el) => el.textContent === 'Move Right')!;
    moveRight.click();
    // cli1 goes after file1: project index of file1 (3) once cli1 (1) is lifted out → 3.
    expect(fakeState.reorderSession).toHaveBeenCalledWith('B', 'cli1', 3);
  });

  it('dropping a tab reorders within the view\'s tabs, mapped to project.sessions', () => {
    setDetachedProjectId('B');
    const sessions = view('sessions');
    renderTabList(sessions);
    const target = sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="web1"]')!;
    target.getBoundingClientRect = () => ({ left: 0, width: 100, right: 100, top: 0, bottom: 10, height: 10 } as DOMRect);
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { clientX: number };
    Object.defineProperty(drop, 'clientX', { value: 10 });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'cli1' } });
    target.dispatchEvent(drop);
    // Before web1 (project index 5); cli1 (1) sits before it, so the target shifts to 4.
    expect(fakeState.reorderSession).toHaveBeenCalledWith('B', 'cli1', 4);
  });

  it('ignores a drop of a tab the view does not show', () => {
    setDetachedProjectId('B');
    const sessions = view('sessions');
    renderTabList(sessions);
    const target = sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="web1"]')!;
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'clientX', { value: 10 });
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => 'kb' } });
    target.dispatchEvent(drop);
    expect(fakeState.reorderSession).not.toHaveBeenCalled();
  });
});

describe('the active tab of each view', () => {
  const activeIds = (v: TabBarView): string[] =>
    Array.from(v.tabListEl.querySelectorAll<HTMLElement>('.tab-item.active')).map((t) => t.dataset.sessionId!);

  it('with B detached and active: main highlights its own selection, sessions highlights activeSessionId', () => {
    setDetachedProjectId('B');
    fakeState.projects[1].activeSessionId = 'cli1';
    const main = view('main');
    const sessions = view('sessions');
    render();
    expect(activeIds(main)).toEqual([]);
    expect(activeIds(sessions)).toEqual(['cli1']);
    setMainViewSelection('kb');
    render();
    expect(activeIds(main)).toEqual(['kb']);
    expect(activeIds(sessions)).toEqual(['cli1']);
  });

  it('clicking a main-view tab of the detached project selects it even when activeSessionId already points at it', () => {
    setDetachedProjectId('B');
    fakeState.projects[1].activeSessionId = 'kb';
    const main = view('main');
    renderTabList(main);
    main.tabListEl.querySelector<HTMLElement>('[data-session-id="kb"]')!.click();
    expect(fakeState.setActiveSession).toHaveBeenCalledWith('B', 'kb');
  });
});

describe('menu actions follow the view', () => {
  it('More → swarm toggles the sessions view project, not the active one', () => {
    setDetachedProjectId('B');
    fakeState.activeProjectId = 'A';
    const other = document.implementation.createHTMLDocument('sessions');
    const sessions = view('sessions', other);
    sessions.root.querySelector<HTMLElement>('#btn-more')!.click();
    Array.from(getActiveContextMenu()!.querySelectorAll<HTMLElement>('.tab-context-menu-item'))[0].click();
    expect(fakeState.toggleSwarm).toHaveBeenCalledWith('B');
  });

  it('More → join opens the dialog in the view document, for its project', () => {
    setDetachedProjectId('B');
    fakeState.activeProjectId = 'A';
    const other = document.implementation.createHTMLDocument('sessions');
    const sessions = view('sessions', other);
    sessions.root.querySelector<HTMLElement>('#btn-more')!.click();
    const items = Array.from(getActiveContextMenu()!.querySelectorAll<HTMLElement>('.tab-context-menu-item'));
    items[items.length - 1].click();
    expect(showJoinDialog).toHaveBeenCalledWith({ projectId: 'B', doc: other });
  });

  it('tab menu → share opens the share dialog in the view document', () => {
    setDetachedProjectId('B');
    const other = document.implementation.createHTMLDocument('sessions');
    const sessions = view('sessions', other);
    renderTabList(sessions);
    const tab = sessions.tabListEl.querySelector<HTMLElement>('[data-session-id="cli1"]')!;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const share = Array.from(getActiveContextMenu()!.querySelectorAll<HTMLElement>('.tab-context-menu-item'))
      .find((el) => /share/i.test(el.textContent ?? '') && !/stop/i.test(el.textContent ?? ''));
    expect(share).toBeDefined();
    share!.click();
    expect(showShareDialog).toHaveBeenCalledWith('cli1', other);
  });
});
