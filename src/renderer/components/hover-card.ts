import { windowOf } from '../frame.js';

// One card per document (the session window is a second Document). The card
// lives in the document of the element it is anchored to.
const cards = new WeakMap<Document, HTMLDivElement>();
let activeDoc: Document | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
const HOVER_DELAY_MS = 600;

function ensureCard(doc: Document): HTMLDivElement {
  const existing = cards.get(doc);
  if (existing) return existing;
  const el = doc.createElement('div');
  el.className = 'hover-card hidden';
  el.setAttribute('role', 'tooltip');
  doc.body.appendChild(el);
  cards.set(doc, el);
  return el;
}

function show(target: HTMLElement, content: string): void {
  const doc = target.ownerDocument;
  const win = windowOf(doc);
  if (activeDoc && activeDoc !== doc) hide();
  activeDoc = doc;
  const card = ensureCard(doc);
  card.textContent = content;
  card.classList.remove('hidden');

  const rect = target.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 8;
  const viewportW = win.innerWidth;
  const viewportH = win.innerHeight;

  let top = rect.bottom + margin;
  let left = rect.left + rect.width / 2 - cardRect.width / 2;
  if (top + cardRect.height > viewportH - margin) {
    top = rect.top - cardRect.height - margin;
  }
  if (left + cardRect.width > viewportW - margin) {
    left = viewportW - cardRect.width - margin;
  }
  if (left < margin) left = margin;

  card.style.top = `${Math.max(margin, top)}px`;
  card.style.left = `${left}px`;

  if (!escHandler) {
    escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    doc.addEventListener('keydown', escHandler);
  }
}

function hide(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (activeDoc) {
    cards.get(activeDoc)?.classList.add('hidden');
    if (escHandler) activeDoc.removeEventListener('keydown', escHandler);
  }
  escHandler = null;
  activeDoc = null;
}

function scheduleShow(target: HTMLElement, content: string): void {
  if (showTimer) clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    showTimer = null;
    show(target, content);
  }, HOVER_DELAY_MS);
}

export function hideHoverCard(): void {
  hide();
}

export function attachHoverCard(target: HTMLElement, content: string): void {
  target.addEventListener('mouseenter', () => scheduleShow(target, content));
  target.addEventListener('focusin', () => scheduleShow(target, content));
  target.addEventListener('mouseleave', hide);
  target.addEventListener('focusout', hide);
}
