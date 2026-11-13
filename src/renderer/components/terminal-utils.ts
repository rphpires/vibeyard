import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { shortcutManager } from '../shortcuts.js';
import { isWin } from '../platform.js';
import { appState } from '../state.js';
import type { ClipboardSource } from '../../shared/types.js';
import { windowOf } from '../frame.js';

type ExtraKeyHandler = (e: KeyboardEvent) => boolean | undefined;

// Wraps text in bracketed-paste escapes when the shell has the mode enabled,
// so it's delivered as a paste rather than character-by-character input.
export function wrapBracketedPaste(terminal: Terminal, text: string): string {
  const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
  return modes?.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

/**
 * Move an already-opened terminal pane into `container`. Moving into another window's
 * document (the sessions window): xterm only rebinds to that window (its rAF, DPR,
 * listeners) when open() runs again after the move.
 */
export function moveOpenedTerminal(element: HTMLElement, container: HTMLElement, terminal: Terminal, xtermWrap: HTMLElement): void {
  const previousDoc = element.ownerDocument;
  container.appendChild(element);
  if (container.ownerDocument !== previousDoc) terminal.open(xtermWrap);
}

// Reading the clipboard needs a focused document, so a terminal living in
// another window (the session window) must use that window's navigator.
export function clipboardFor(terminal: Terminal): Clipboard {
  const doc = terminal.element?.ownerDocument;
  return (doc ? windowOf(doc).navigator : navigator).clipboard;
}

// Every terminal copy goes through the main process rather than
// navigator.clipboard, so exactly one plain-text flavor reaches the OS clipboard
// (#160). `source` is the caller's intent, not a mechanism: the main process
// decides what a selection-driven copy means per platform.
export function copyText(text: string, source: ClipboardSource = 'explicit'): void {
  if (!text) return;
  window.vibeyard.clipboard.write(text, source)
    .catch((err) => console.warn('clipboard write failed', err));
}

export function copySelection(terminal: Terminal, source?: ClipboardSource): void {
  copyText(terminal.getSelection(), source);
}

// Call after terminal.open(); the selection service doesn't fire before then.
export function attachCopyOnSelect(terminal: Terminal): void {
  terminal.onSelectionChange(() => {
    if (!appState.preferences.copyOnSelect) return;
    copySelection(terminal, 'selection');
  });
}

// Cap on a decoded OSC 52 payload, so a program cannot push an unbounded string
// through IPC into the OS clipboard.
export const MAX_OSC52_BYTES = 1024 * 1024;

/**
 * Decode the payload of an OSC 52 set-clipboard request (`<targets>;<base64>`).
 * Returns null for anything that is not a write: a read request (`?`) — never
 * answered, it would let any program in the terminal read the clipboard — an
 * empty payload (a "clear" request), malformed base64, or an oversized one.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (payload === '?') return null;
  if (payload.length > Math.ceil(MAX_OSC52_BYTES / 3) * 4) return null;
  try {
    const bin = atob(payload);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) || null;
  } catch {
    return null;
  }
}

/**
 * Honor OSC 52 clipboard writes. A program that turns on mouse tracking (Claude
 * Code's fullscreen renderer, tmux, vim with mouse=a) receives the drag itself,
 * so xterm never holds a selection — Ctrl+C has nothing to copy and the context
 * menu's Copy is disabled. Such programs draw their own selection and hand the
 * text to the terminal via OSC 52; without this handler it was dropped silently.
 */
export function attachOsc52Clipboard(terminal: Terminal): void {
  terminal.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text) copyText(text);
    return true;
  });
}

/**
 * Call after terminal.open(). xterm's right-click handler parks the selection in
 * its hidden textarea and DOM-selects it so a native context-menu Copy can pick
 * it up, which leaves anything that later serializes that textarea free to write
 * the rich flavors that corrupt non-Latin text (#160).
 *
 * Collapse the selection rather than wiping the value: with nothing selected
 * Blink reports the copy command unavailable, and the contents stay intact for
 * xterm's IME CompositionHelper, which reads `textarea.value` back in a deferred
 * callback — clearing it would silently drop a CJK or Cyrillic candidate mid
 * composition, hitting exactly the users this fixes.
 */
export function collapseArmedTextareaOnContextMenu(terminal: Terminal): void {
  // xterm's own handler is on this element, so ours runs after the arming.
  terminal.element?.addEventListener('contextmenu', () => {
    terminal.textarea?.setSelectionRange(0, 0);
  });
}

/**
 * Attaches shared key event handling to a terminal:
 * - Cmd/Ctrl+F: bubbles up to document (prevents xterm from consuming it)
 * - Ctrl+Shift+C: copies selected text to clipboard
 * - Windows Ctrl+C: copies if selection exists, otherwise passes through as SIGINT
 * - Windows Ctrl+V: pastes clipboard content to PTY (requires writeToPty)
 *
 * Pass an optional `extend` handler for terminal-specific key behavior.
 * Return false to suppress the key, undefined to fall through to default.
 *
 * Pass `writeToPty` to enable Ctrl+V paste on Windows — it receives the
 * clipboard text and should forward it to the PTY.
 *
 * Pass `onImagePaste` to handle Ctrl+V when the clipboard holds an image and
 * no text. The CLI reads images from the OS clipboard itself, so the handler
 * only has to send the CLI's own image-paste key (Claude Code on Windows: Alt+V).
 */
export function attachClipboardCopyHandler(
  terminal: Terminal,
  extend?: ExtraKeyHandler,
  writeToPty?: (data: string) => void,
  onImagePaste?: () => void
): void {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F: bubble to document for search
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') return false;

    // Ctrl+Shift+C: copy selected text (all platforms)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
      if (e.type === 'keydown') copySelection(terminal);
      return false;
    }

    // Windows: Ctrl+C with selection → copy; without selection → SIGINT
    if (isWin && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'c') {
      // hasSelection() is a coordinate compare; getSelection() rebuilds the whole
      // string from the buffer, and this handler fires on keyup too.
      if (!terminal.hasSelection()) return true; // let xterm send \x03
      if (e.type === 'keydown') copySelection(terminal);
      return false;
    }

    // Windows: Ctrl+V → async paste clipboard to PTY
    if (isWin && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v' && writeToPty) {
      if (e.type === 'keydown') {
        clipboardFor(terminal).readText().then(async (text) => {
          if (text) {
            writeToPty(wrapBracketedPaste(terminal, text));
          } else if (onImagePaste && await window.vibeyard.clipboard.hasImage()) {
            onImagePaste();
          }
        }).catch(() => {});
      }
      e.preventDefault(); // prevent native paste event from firing
      return false; // suppress \x16
    }

    // Let registered app shortcuts bubble to document listener
    if (shortcutManager.matchesAnyShortcut(e)) return false;

    return extend?.(e) ?? true;
  });
}

// Disposing the addon on context loss lets xterm.js fall back to the DOM renderer
// instead of keeping a dead GPU texture atlas (black-box glyphs).
export function loadWebglWithFallback(terminal: Terminal): WebglAddon | undefined {
  try {
    const addon = new WebglAddon();
    terminal.loadAddon(addon);
    addon.onContextLoss(() => addon.dispose());
    return addon;
  } catch {
    return undefined;
  }
}
