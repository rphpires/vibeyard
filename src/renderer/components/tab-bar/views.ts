import { appState, type ProjectRecord } from '../../state.js';
import { projectIdForView, type ViewKind } from '../../session-window-state.js';

/**
 * One tab bar: the main window's `#tab-bar` (index.html nodes) or the sessions
 * window's, built by buildTabBarDom in that window's document (same JS context).
 * render() draws every registered view, each restricted to viewTabs(kind, project).
 */
export interface TabBarView {
  kind: ViewKind;
  root: HTMLElement;
  tabListEl: HTMLElement;
  doc: Document;
}

const views = new Map<TabBarView, () => void>();

/** Register a view; `cleanup` runs on unregister (listeners it put outside its root). */
export function registerTabBarView(view: TabBarView, cleanup: () => void): void {
  views.set(view, cleanup);
}

export function unregisterTabBarView(view: TabBarView): void {
  const cleanup = views.get(view);
  if (!cleanup) return;
  views.delete(view);
  cleanup();
}

export function tabBarViews(): Iterable<TabBarView> {
  return views.keys();
}

/** The project a view shows right now (projectIdForView), or undefined. */
export function viewProject(view: Pick<TabBarView, 'kind'>): ProjectRecord | undefined {
  const id = projectIdForView(view.kind, appState.activeProjectId ?? null);
  return id ? appState.projects.find((p) => p.id === id) : undefined;
}
