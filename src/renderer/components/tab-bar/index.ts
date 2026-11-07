import { appState } from '../../state.js';
import { onChange as onStatusChange } from '../../session-activity.js';
import { onChange as onGitStatusChange } from '../../git-status.js';
import { onChange as onUnreadChange } from '../../session-unread.js';
import { onChange as onGithubUnreadChange } from '../../github-unread.js';
import { onDetachedChange, type ViewKind } from '../../session-window-state.js';
import { ICON_TERMINAL, ICON_MENU } from '../../icons.js';
import { onShareChange } from '../../sharing/share-manager.js';
import { loadProviderAvailability, hasMultipleAvailableProviders } from '../../provider-availability.js';
import { getActiveContextMenu, hideTabContextMenu } from './menu.js';
import { gitStatusEl } from './dom.js';
import { render, renderTabList, updateTabStatus } from './tab-list.js';
import { clearTabScrollState } from './tab-scroll.js';
import { renderGitStatus, showBranchContextMenu } from './git-status-bar.js';
import { showMoreMenu, promptNewSession, quickNewSession } from './session-menu.js';
import { registerTabBarView, unregisterTabBarView, viewProject, type TabBarView } from './views.js';

export type { TabBarView } from './views.js';

/**
 * The main window's `#tab-bar` structure (list + actions) for another window's
 * document. Without the git status bar and the project-terminal toggle: both
 * belong to the main window only. The main view reuses index.html's own nodes.
 */
export function buildTabBarDom(doc: Document): HTMLElement {
  const root = doc.createElement('div');
  root.id = 'tab-bar';
  root.innerHTML = `
    <div id="tab-list"></div>
    <div id="tab-actions">
      <button id="btn-add-browser-tab" class="icon-btn" title="New Browser Tab" aria-label="New Browser Tab">
        <span class="toolbar-icon toolbar-icon-browser" aria-hidden="true"></span>
      </button>
      <button id="btn-more" class="icon-btn" title="More" aria-haspopup="menu" aria-label="More"></button>
      <div class="split-btn-group new-session-group">
        <button id="btn-add-session" class="btn-primary new-session-main" title="New Session (Ctrl+Shift+N)">
          <span class="new-session-icon" aria-hidden="true">+</span>New session
        </button>
        <button id="btn-add-session-menu" class="btn-primary new-session-caret" title="New Custom Session" aria-label="New Custom Session">&#x25BE;</button>
      </div>
    </div>
  `;
  return root;
}

/**
 * Make `root` (a `#tab-bar` structure, see buildTabBarDom) a tab bar view: wire its
 * buttons to the view's project and register it, so render() draws it. App event
 * subscriptions are not per view — initTabBar holds them once for every view.
 */
export function createTabBarView(kind: ViewKind, root: HTMLElement): TabBarView {
  const doc = root.ownerDocument;
  // Attribute match, not `#id`: some selector engines answer `#id` through the document's
  // first element with that id, missing a second tab bar built in the same document.
  const find = (id: string) => root.querySelector<HTMLElement>(`[id="${id}"]`);
  const view: TabBarView = { kind, root, tabListEl: find('tab-list')!, doc };

  const btnAddSession = find('btn-add-session');
  const btnAddSessionMenu = find('btn-add-session-menu');
  const btnAddBrowserTab = find('btn-add-browser-tab');
  const btnMore = find('btn-more');

  btnAddSession?.addEventListener('click', () => {
    const project = viewProject(view);
    if (project) quickNewSession(project.id);
  });
  btnAddSession?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMoreMenu(e.clientX, e.clientY, view);
  });
  // The pill's caret opens a custom-session dialog; the More button owns the menu.
  btnAddSessionMenu?.addEventListener('click', (e) => {
    e.stopPropagation();
    void promptNewSession(undefined, { projectId: viewProject(view)?.id, doc });
  });
  if (btnMore) {
    btnMore.innerHTML = ICON_MENU;
    btnMore.addEventListener('click', (e) => {
      e.stopPropagation();
      if (getActiveContextMenu()) {
        hideTabContextMenu();
        return;
      }
      const rect = btnMore.getBoundingClientRect();
      showMoreMenu(rect.left, rect.bottom + 4, view);
    });
  }
  // Browser button keeps its CSS-drawn .toolbar-icon-browser glyph.
  btnAddBrowserTab?.addEventListener('click', () => {
    const project = viewProject(view);
    if (project) appState.addBrowserTabSession(project.id);
  });

  // Menus open in this view's document, so they are dismissed from it too.
  const onDocClick = (): void => hideTabContextMenu();
  const onDocKeydown = (e: KeyboardEvent): void => { if (e.key === 'Escape') hideTabContextMenu(); };
  doc.addEventListener('click', onDocClick);
  doc.addEventListener('keydown', onDocKeydown);

  registerTabBarView(view, () => {
    doc.removeEventListener('click', onDocClick);
    doc.removeEventListener('keydown', onDocKeydown);
  });
  renderTabList(view);
  return view;
}

/** Unregister a view: render() stops drawing it and its document listeners go away. */
export function destroyTabBarView(view: TabBarView): void {
  unregisterTabBarView(view);
}

export function initTabBar(): void {
  createTabBarView('main', document.getElementById('tab-bar')!);

  // Terminal toggle is wired in project-terminal.ts; we only own its icon here.
  document.getElementById('btn-toggle-terminal')!.innerHTML = ICON_TERMINAL;
  gitStatusEl.addEventListener('click', (e) => showBranchContextMenu(e));

  // Icons only distinguish providers when multiple are installed
  loadProviderAvailability().then(() => {
    if (hasMultipleAvailableProviders()) render();
  }).catch(() => {});

  appState.on('state-loaded', render);
  appState.on('project-changed', render);
  appState.on('session-added', render);
  appState.on('session-removed', render);
  appState.on('project-removed', (id) => { if (typeof id === 'string') clearTabScrollState(id); });
  appState.on('session-changed', render);
  appState.on('layout-changed', render);
  onShareChange(render);
  // Detaching or re-attaching a project moves its tabs between the views.
  onDetachedChange(() => render());

  onStatusChange(updateTabStatus);

  onUnreadChange(render);
  onGithubUnreadChange(render);

  onGitStatusChange((projectId) => {
    if (projectId === appState.activeProjectId) renderGitStatus();
  });
  appState.on('project-changed', renderGitStatus);

  render();
}
