/**
 * The live handle of the open sessions window, kept apart from `session-window.ts`.
 *
 * `session-window.ts` builds the window, so it imports the whole layout (split-layout,
 * tab bar, every pane module). Code that only needs to *ask about* or *focus* the
 * window — reveal.ts, notifications, vibeyard-ctl, the Active Sessions panel, session
 * history — imports this leaf module instead, so it does not drag that graph in
 * (each test of such a module would otherwise load it). `session-window.ts` sets the
 * handle and re-exports these functions.
 */

import type { ViewKind } from '../shared/session-window.js';

export interface SessionWindowHandle {
  win: Window;
  doc: Document;
  root: HTMLElement;
}

let live: SessionWindowHandle | null = null;

export function setSessionWindowHandle(handle: SessionWindowHandle | null): void {
  live = handle;
}

/** Still the window (and document) that was built? A closed or re-navigated one is gone. */
export function isHandleAlive(h: SessionWindowHandle): boolean {
  try {
    return !h.win.closed && h.win.document === h.doc && h.doc.body?.contains(h.root) === true;
  } catch {
    return false;
  }
}

export function focusSessionWindow(): void {
  if (live) window.vibeyard.sessionWindow.focus();
}

export function isSessionWindowFocused(): boolean {
  if (!live) return false;
  try {
    return live.doc.hasFocus();
  } catch {
    return false;
  }
}

/** The sessions window's document while it is open. */
export function getSessionWindowDocument(): Document | null {
  return live && isHandleAlive(live) ? live.doc : null;
}

/**
 * The window a document belongs to: 'sessions' for the open sessions window's
 * document, else 'main'. Lets a listener on a pane's own document (a webview's
 * `before-input-event`, a selection) dispatch with the right command source.
 */
export function viewKindOfDocument(doc: Document): ViewKind {
  return live !== null && doc === live.doc ? 'sessions' : 'main';
}
