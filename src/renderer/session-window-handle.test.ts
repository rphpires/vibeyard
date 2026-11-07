// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  setSessionWindowHandle,
  focusSessionWindow,
  isSessionWindowFocused,
  getSessionWindowDocument,
  isSessionWindowOpen,
  viewKindOfDocument,
} from './session-window-handle.js';

const focus = vi.fn();
(window as unknown as { vibeyard: unknown }).vibeyard = { sessionWindow: { focus } };

function handle() {
  const doc = document.implementation.createHTMLDocument('sessions');
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const win = { closed: false, document: doc } as unknown as Window;
  return { win, doc, root };
}

beforeEach(() => {
  focus.mockClear();
  setSessionWindowHandle(null);
});

describe('session-window-handle', () => {
  it('reports nothing and focuses nothing while no window is open', () => {
    expect(isSessionWindowOpen()).toBe(false);
    expect(getSessionWindowDocument()).toBeNull();
    expect(isSessionWindowFocused()).toBe(false);
    focusSessionWindow();
    expect(focus).not.toHaveBeenCalled();
  });

  it('answers for the open window, and drops a document that lost its root', () => {
    const h = handle();
    setSessionWindowHandle(h);
    expect(isSessionWindowOpen()).toBe(true);
    expect(getSessionWindowDocument()).toBe(h.doc);
    focusSessionWindow();
    expect(focus).toHaveBeenCalledTimes(1);
    h.root.remove();
    expect(getSessionWindowDocument()).toBeNull();
  });

  it('maps a document to the window that shows it', () => {
    expect(viewKindOfDocument(document)).toBe('main');
    const h = handle();
    expect(viewKindOfDocument(h.doc)).toBe('main');
    setSessionWindowHandle(h);
    expect(viewKindOfDocument(h.doc)).toBe('sessions');
    expect(viewKindOfDocument(document)).toBe('main');
  });

  // The fan-out guard: session-window.ts imports the whole layout (split-layout, tab
  // bar, every pane). These modules are imported by many others (and their tests),
  // so they ask about the window through the handle and load the controller lazily.
  it.each([
    'reveal.ts',
    'notification-desktop.ts',
    'ctl-bridge.ts',
    'components/sidebar.ts',
  ])('%s has no static import of session-window.js', (file) => {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    expect(src).not.toMatch(/^import[^;]*from '[./]*session-window\.js';/m);
  });
});
