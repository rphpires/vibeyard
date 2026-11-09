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

  it('keeps exactly one active modal: opening in another doc hides and detaches the main one', async () => {
    const { showModal, closeModal } = await import('./modal');
    const other = document.implementation.createHTMLDocument('o');
    other.body.innerHTML = OVERLAY;
    const mainConfirm = vi.fn();
    const otherConfirm = vi.fn();
    showModal('Main', [], mainConfirm);
    showModal('Other', [], otherConfirm, { doc: other });

    expect(document.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(true);
    expect(other.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(false);

    // Main listeners were removed: Enter / click on main does nothing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.getElementById('modal-confirm')!.click();
    expect(mainConfirm).not.toHaveBeenCalled();

    // Only the active modal reacts.
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(otherConfirm).toHaveBeenCalledTimes(1));

    // Escape: ignored on the main document, closes the modal in the other one.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(other.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(false);
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(other.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(true);
    closeModal();
  });

  it('closeModal after the other document lost its overlay does not throw; main still works', async () => {
    const { showModal, closeModal } = await import('./modal');
    const other = document.implementation.createHTMLDocument('o');
    other.body.innerHTML = OVERLAY;
    showModal('Other', [], () => {}, { doc: other });
    other.getElementById('modal-overlay')!.remove();

    expect(() => closeModal()).not.toThrow();
    expect(() => showModal('Main again', [], () => {})).not.toThrow();
    expect(document.getElementById('modal-title')!.textContent).toBe('Main again');
    expect(document.getElementById('modal-overlay')!.classList.contains('hidden')).toBe(false);
    closeModal();
  });

  it('showModal in main recovers when the stored document lost its overlay', async () => {
    const { showModal, closeModal } = await import('./modal');
    const other = document.implementation.createHTMLDocument('o');
    other.body.innerHTML = OVERLAY;
    showModal('Other', [], () => {}, { doc: other });
    other.getElementById('modal-overlay')!.remove();
    expect(() => showModal('Main', [], () => {})).not.toThrow();
    expect(document.getElementById('modal-title')!.textContent).toBe('Main');
    closeModal();
  });

  it('defaults to the main document', async () => {
    const { showConfirmDialog, closeModal } = await import('./modal');
    showConfirmDialog('T', 'msg', { onConfirm: () => {} });
    expect(document.getElementById('modal-title')!.textContent).toBe('T');
    closeModal();
  });
});

describe('modal focus frames', () => {
  // The sessions window must not wait on the main window's frames: with main
  // minimized or covered, its rAF is throttled and the dialog would open unfocused.
  function childDoc() {
    const other = document.implementation.createHTMLDocument('o');
    other.body.innerHTML = OVERLAY;
    const childRaf = vi.fn((cb: FrameRequestCallback) => { cb(0); return 1; });
    Object.defineProperty(other, 'defaultView', { value: { requestAnimationFrame: childRaf } });
    return { other, childRaf };
  }

  it('showModal / showConfirmDialog / showPropertiesDialog focus on the overlay document\'s own frame', async () => {
    const { showModal, showConfirmDialog, showPropertiesDialog, closeModal } = await import('./modal');
    const mainRaf = vi.fn(() => 0);
    vi.stubGlobal('requestAnimationFrame', mainRaf);
    const { other, childRaf } = childDoc();

    showModal('T', [{ label: 'Name', id: 'name' }], () => {}, { doc: other });
    expect(childRaf).toHaveBeenCalledTimes(1);
    showConfirmDialog('T', 'msg', { onConfirm: () => {}, doc: other });
    expect(childRaf).toHaveBeenCalledTimes(2);
    showPropertiesDialog('T', [{ label: 'a', value: 'b' }], { doc: other });
    expect(childRaf).toHaveBeenCalledTimes(3);
    expect(mainRaf).not.toHaveBeenCalled();
    closeModal();
  });

  it('the main document keeps using the global frame', async () => {
    const { showModal, closeModal } = await import('./modal');
    const mainRaf = vi.fn(() => 0);
    vi.stubGlobal('requestAnimationFrame', mainRaf);
    showModal('T', [{ label: 'Name', id: 'name' }], () => {});
    expect(mainRaf).toHaveBeenCalledTimes(1);
    closeModal();
  });
});
