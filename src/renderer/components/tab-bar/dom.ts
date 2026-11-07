// Main-window-only tab-bar DOM ref shared across more than one module. The tab
// list and buttons belong to a TabBarView (views.ts); the git status bar exists
// only in the main window.
export const gitStatusEl = document.getElementById('git-status')!;
