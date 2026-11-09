// Re-export shim: tab-bar was split into the ./tab-bar/ folder. This preserves
// the original import path for existing consumers.
export { initTabBar, createTabBarView, destroyTabBarView, buildTabBarDom, type TabBarView } from './tab-bar/index.js';
export { render as renderTabBars } from './tab-bar/tab-list.js';
export { quickNewSession, promptNewSession, type PromptNewSessionOptions } from './tab-bar/session-menu.js';
