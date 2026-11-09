import type { Terminal } from '@xterm/xterm';
import { isMac } from '../platform.js';
import { clipboardFor, copySelection, wrapBracketedPaste } from './terminal-utils.js';
import { t } from '../i18n.js';
import { windowOf } from '../frame.js';

let activeMenu: HTMLElement | null = null;
let menuDoc: Document = document;

function makeItem(doc: Document, label: string, shortcut?: string): HTMLDivElement {
  const item = doc.createElement('div');
  item.className = 'tab-context-menu-item';
  const labelSpan = doc.createElement('span');
  labelSpan.textContent = label;
  item.appendChild(labelSpan);
  if (shortcut) {
    const hint = doc.createElement('span');
    hint.className = 'shortcut-hint';
    hint.textContent = shortcut;
    item.appendChild(hint);
  }
  return item;
}

function onDocumentClick(): void {
  hideTerminalContextMenu();
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hideTerminalContextMenu();
}

export function showTerminalContextMenu(
  x: number,
  y: number,
  terminal: Terminal,
  writeToPty: (data: string) => void
): void {
  hideTerminalContextMenu();

  const doc = terminal.element?.ownerDocument ?? document;
  const win = windowOf(doc);
  const menu = doc.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const hasSelection = terminal.hasSelection();

  const copyItem = makeItem(doc, t('contextMenu.terminal.copy'), isMac ? '⇧⌘C' : 'Ctrl+Shift+C');
  if (!hasSelection) copyItem.classList.add('disabled');
  if (hasSelection) {
    copyItem.addEventListener('click', (e) => {
      e.stopPropagation();
      hideTerminalContextMenu();
      terminal.focus();
      copySelection(terminal);
    });
  }
  menu.appendChild(copyItem);

  const pasteItem = makeItem(doc, t('contextMenu.terminal.paste'), isMac ? '⌘V' : 'Ctrl+V');
  pasteItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTerminalContextMenu();
    terminal.focus();
    clipboardFor(terminal).readText().then((text) => {
      if (!text) return;
      writeToPty(wrapBracketedPaste(terminal, text));
    }).catch(() => {});
  });
  menu.appendChild(pasteItem);

  const sep1 = doc.createElement('div');
  sep1.className = 'tab-context-menu-separator';
  menu.appendChild(sep1);

  const selectAllItem = makeItem(doc, t('contextMenu.terminal.selectAll'));
  selectAllItem.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTerminalContextMenu();
    terminal.focus();
    terminal.selectAll();
  });
  menu.appendChild(selectAllItem);

  doc.body.appendChild(menu);
  menuDoc = doc;
  activeMenu = menu;

  const rect = menu.getBoundingClientRect();
  if (rect.right > win.innerWidth) menu.style.left = `${win.innerWidth - rect.width - 4}px`;
  if (rect.bottom > win.innerHeight) menu.style.top = `${win.innerHeight - rect.height - 4}px`;

  doc.addEventListener('click', onDocumentClick);
  doc.addEventListener('keydown', onDocumentKeydown);
}

export function hideTerminalContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
    menuDoc.removeEventListener('click', onDocumentClick);
    menuDoc.removeEventListener('keydown', onDocumentKeydown);
  }
}
