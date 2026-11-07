// Shared context-menu infrastructure for the tab bar. There is a single
// open context menu at a time (tab menu, branch menu, or "More" menu); this
// module owns that state and the dismiss/position helpers.

let activeContextMenu: HTMLElement | null = null;

export function getActiveContextMenu(): HTMLElement | null {
  return activeContextMenu;
}

export function setActiveContextMenu(el: HTMLElement | null): void {
  activeContextMenu = el;
}

export function hideTabContextMenu(): void {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// Clamp a menu so it stays within the viewport of the window it is shown in.
export function positionMenu(menu: HTMLElement): void {
  const win = menu.ownerDocument.defaultView ?? window;
  const rect = menu.getBoundingClientRect();
  if (rect.right > win.innerWidth) menu.style.left = `${win.innerWidth - rect.width - 4}px`;
  if (rect.bottom > win.innerHeight) menu.style.top = `${win.innerHeight - rect.height - 4}px`;
}
