// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const OVERLAY = '<div id="modal-overlay" class="hidden"><div id="modal"><div id="modal-title"></div><div id="modal-body"></div><div id="modal-actions"><button id="modal-cancel">Cancel</button><button id="modal-confirm">Create</button></div></div></div>';

beforeEach(() => {
  document.body.innerHTML = OVERLAY;
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0; });
});

describe('modal in another document', () => {
  it('showModal with opts.doc mounts in that document, not the main one', async () => {
    const { showModal, closeModal } = await import('./modal');
    const other = document.implementation.createHTMLDocument('o');
    other.body.innerHTML = OVERLAY;
    showModal('Hello', [{ label: 'Name', id: 'name' }], () => {}, { doc: other });
    expect(other.getElementById('modal-title')!.textContent).toBe('Hello');
    expect(other.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('modal-title')!.textContent).toBe('');
    expect(document.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(true);
    expect(other.getElementById('modal-name')!.ownerDocument).toBe(other);
    closeModal();
    expect(other.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(true);
  });

  it('defaults to the main document', async () => {
    const { showConfirmDialog, closeModal } = await import('./modal');
    showConfirmDialog('T', 'msg', { onConfirm: () => {} });
    expect(document.getElementById('modal-title')!.textContent).toBe('T');
    closeModal();
  });
});
