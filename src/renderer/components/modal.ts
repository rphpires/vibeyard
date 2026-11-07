import { createCustomSelect } from './custom-select.js';
import { pushModal } from './modal-manager.js';
import { requestFrameIn } from '../frame.js';

export interface FieldDef {
  label: string;
  id: string;
  type?: 'text' | 'checkbox' | 'select' | 'textarea';
  placeholder?: string;
  defaultValue?: string;
  rows?: number;
  maxLength?: number;
  options?: { value: string; label: string; disabled?: boolean }[];
  buttonLabel?: string;
  onButtonClick?: (input: HTMLInputElement) => void;
  onChange?: (checked: boolean) => void;
  /** Fired when a `select` field's value changes (the new value). */
  onSelectChange?: (value: string) => void;
}

/** Document the single modal currently lives in. `closeModal()` closes it wherever it is. */
let activeDoc: Document = document;
/** Overlay element of the open modal; keeps teardown reachable if its document dies. */
let activeOverlay: HTMLElement | null = null;

function nodes(doc: Document) {
  return {
    overlay: doc.getElementById('modal-overlay')!,
    titleEl: doc.getElementById('modal-title')!,
    bodyEl: doc.getElementById('modal-body')!,
    btnCancel: doc.getElementById('modal-cancel')!,
    btnConfirm: doc.getElementById('modal-confirm')!,
  };
}

/** Make `doc` the modal's document; a modal still open in another document is closed first. */
function useDoc(doc: Document): void {
  // The overlay element is remembered so teardown still reaches listeners
  // registered in a document that has since lost its markup or been closed.
  if (!activeDoc.getElementById('modal-overlay') || activeDoc.defaultView === null && activeDoc !== document) {
    closeModal();
    activeDoc = document;
  }
  if (doc !== activeDoc) {
    closeModal();
    activeDoc = doc;
  }
  activeOverlay = nodes(activeDoc).overlay;
}

/** Register a teardown callback for resources injected into the open modal
 *  (e.g. a custom-select created outside the standard FieldDef flow). Runs
 *  when the modal closes. */
export function registerModalCleanup(fn: () => void): void {
  const overlay = activeOverlay ?? nodes(activeDoc).overlay;
  if (!(overlay as any)._selectCleanups) (overlay as any)._selectCleanups = [];
  (overlay as any)._selectCleanups.push(fn);
}

export function setModalError(fieldId: string, message: string): void {
  const { bodyEl } = nodes(activeDoc);
  const existing = bodyEl.querySelector(`#modal-error-${fieldId}`);
  if (existing) existing.remove();

  if (!message) return;

  const input = activeDoc.getElementById(`modal-${fieldId}`);
  if (!input) return;

  const errEl = activeDoc.createElement('div');
  errEl.id = `modal-error-${fieldId}`;
  errEl.className = 'modal-error';
  errEl.textContent = message;
  input.parentElement!.appendChild(errEl);
}

export function closeModal(): void {
  const overlay = activeDoc.getElementById('modal-overlay') ?? activeOverlay;
  overlay?.classList.add('hidden');
  cleanup();
}

const DEFAULT_CONFIRM_LABEL = 'Create';

export interface ModalOptions {
  confirmLabel?: string;
  /** Document to mount the modal in. Defaults to the main `document`. */
  doc?: Document;
}

function resetFooter(): void {
  const { btnConfirm, btnCancel } = nodes(activeDoc);
  btnConfirm.style.display = '';
  btnConfirm.style.background = '';
  btnConfirm.style.borderColor = '';
  const footer = activeDoc.getElementById('modal-actions');
  if (!footer) return;
  for (const el of Array.from(footer.children)) {
    if (el !== btnCancel && el !== btnConfirm) el.remove();
  }
}

export function showModal(
  title: string,
  fields: FieldDef[],
  onConfirm: (values: Record<string, string>) => void | Promise<void>,
  options?: ModalOptions,
): void {
  useDoc(options?.doc ?? document);
  const doc = activeDoc;
  const { overlay, titleEl, bodyEl, btnCancel, btnConfirm } = nodes(doc);
  titleEl.textContent = title;
  btnConfirm.textContent = options?.confirmLabel ?? DEFAULT_CONFIRM_LABEL;
  bodyEl.innerHTML = '';
  btnCancel.textContent = 'Cancel';
  resetFooter();

  for (const field of fields) {
    const div = doc.createElement('div');
    div.className = field.type === 'checkbox' ? 'modal-field modal-field-checkbox' : 'modal-field';

    const label = doc.createElement('label');
    label.setAttribute('for', `modal-${field.id}`);
    label.textContent = field.label;

    const input = doc.createElement('input');
    input.id = `modal-${field.id}`;

    if (field.type === 'checkbox') {
      input.type = 'checkbox';
      if (field.defaultValue === 'true') input.checked = true;
      if (field.onChange) {
        input.addEventListener('change', () => field.onChange!(input.checked));
      }
      div.appendChild(input);
      div.appendChild(label);
    } else if (field.type === 'textarea') {
      div.appendChild(label);
      const textarea = doc.createElement('textarea');
      textarea.id = `modal-${field.id}`;
      textarea.placeholder = field.placeholder ?? '';
      textarea.value = field.defaultValue ?? '';
      textarea.rows = field.rows ?? 3;
      if (field.maxLength) textarea.maxLength = field.maxLength;
      div.appendChild(textarea);
    } else if (field.type === 'select') {
      div.appendChild(label);
      const sel = createCustomSelect(`modal-${field.id}`, field.options ?? [], field.defaultValue, field.onSelectChange, doc);
      div.appendChild(sel.element);
      if (!(overlay as any)._selectCleanups) (overlay as any)._selectCleanups = [];
      (overlay as any)._selectCleanups.push(() => sel.destroy());
    } else {
      input.type = 'text';
      input.placeholder = field.placeholder ?? '';
      input.value = field.defaultValue ?? '';
      div.appendChild(label);

      if (field.buttonLabel && field.onButtonClick) {
        const row = doc.createElement('div');
        row.className = 'modal-field-row';
        row.appendChild(input);
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'modal-field-btn';
        btn.textContent = field.buttonLabel;
        btn.addEventListener('click', () => field.onButtonClick!(input));
        row.appendChild(btn);
        div.appendChild(row);
      } else {
        div.appendChild(input);
      }
    }

    bodyEl.appendChild(div);
  }

  overlay.classList.remove('hidden');

  // Focus first text input
  const firstInput = bodyEl.querySelector('input[type="text"]') as HTMLInputElement | null;
  if (firstInput) {
    requestFrameIn(doc, () => {
      firstInput.focus();
      firstInput.select();
    });
  }

  // Clean up previous listeners
  cleanup();

  const handleConfirm = async () => {
    const values: Record<string, string> = {};
    for (const field of fields) {
      const el = doc.getElementById(`modal-${field.id}`) as HTMLInputElement | HTMLSelectElement;
      if (field.type === 'checkbox') {
        values[field.id] = String((el as HTMLInputElement)?.checked ?? false);
      } else {
        values[field.id] = el?.value ?? '';
      }
    }
    await onConfirm(values);
  };

  const handleCancel = () => {
    closeModal();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !((e.target as Element | null)?.tagName === 'TEXTAREA')) {
      e.preventDefault();
      handleConfirm();
    }
  };

  // ESC is handled by the centralized modal manager (capture phase) so it works
  // over a focused terminal and never leaks to the PTY.
  const unregisterEsc = pushModal({ onEscape: handleCancel }, activeDoc);

  btnConfirm.addEventListener('click', handleConfirm);
  btnCancel.addEventListener('click', handleCancel);
  doc.addEventListener('keydown', handleKeydown);

  // Store for cleanup
  (overlay as any)._cleanup = () => {
    unregisterEsc();
    btnConfirm.removeEventListener('click', handleConfirm);
    btnCancel.removeEventListener('click', handleCancel);
    doc.removeEventListener('keydown', handleKeydown);
  };
}

export function showConfirmDialog(
  title: string,
  message: string,
  options: {
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    doc?: Document;
  }
): void {
  useDoc(options.doc ?? document);
  const { overlay, titleEl, bodyEl, btnCancel, btnConfirm } = nodes(activeDoc);
  titleEl.textContent = title;
  bodyEl.innerHTML = '';
  btnConfirm.textContent = options.confirmLabel ?? 'Confirm';
  btnCancel.textContent = options.cancelLabel ?? 'Cancel';
  resetFooter();

  const messageEl = activeDoc.createElement('div');
  messageEl.className = 'modal-message';
  messageEl.textContent = message;
  bodyEl.appendChild(messageEl);

  overlay.classList.remove('hidden');

  requestFrameIn(activeDoc, () => {
    btnCancel.focus();
  });

  cleanup();

  const handleConfirm = () => {
    options.onConfirm();
    closeModal();
  };

  const handleCancel = () => {
    closeModal();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  const unregisterEsc = pushModal({ onEscape: handleCancel }, activeDoc);

  btnConfirm.addEventListener('click', handleConfirm);
  btnCancel.addEventListener('click', handleCancel);
  const doc = activeDoc;
  doc.addEventListener('keydown', handleKeydown);

  (overlay as any)._cleanup = () => {
    unregisterEsc();
    btnConfirm.removeEventListener('click', handleConfirm);
    btnCancel.removeEventListener('click', handleCancel);
    doc.removeEventListener('keydown', handleKeydown);
  };
}

function cleanup(): void {
  const overlay = activeOverlay ?? activeDoc.getElementById('modal-overlay');
  if (!overlay) return;
  if ((overlay as any)._cleanup) {
    (overlay as any)._cleanup();
    (overlay as any)._cleanup = null;
  }
  if ((overlay as any)._selectCleanups) {
    for (const fn of (overlay as any)._selectCleanups) fn();
    (overlay as any)._selectCleanups = null;
  }
}

export function showPropertiesDialog(
  title: string,
  rows: Array<{ label: string; value: string; mono?: boolean }>,
  opts?: { doc?: Document },
): void {
  useDoc(opts?.doc ?? document);
  const { overlay, titleEl, bodyEl, btnCancel, btnConfirm } = nodes(activeDoc);
  titleEl.textContent = title;
  bodyEl.innerHTML = '';
  btnConfirm.textContent = 'OK';
  resetFooter();
  btnCancel.style.display = 'none';

  const list = activeDoc.createElement('dl');
  list.className = 'modal-properties';
  for (const row of rows) {
    const dt = activeDoc.createElement('dt');
    dt.textContent = row.label;
    const dd = activeDoc.createElement('dd');
    if (row.mono) dd.classList.add('mono');
    dd.textContent = row.value;
    list.appendChild(dt);
    list.appendChild(dd);
  }
  bodyEl.appendChild(list);

  overlay.classList.remove('hidden');

  requestFrameIn(activeDoc, () => { btnConfirm.focus(); });

  cleanup();

  const handleClose = () => closeModal();
  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleClose();
    }
  };

  const unregisterEsc = pushModal({ onEscape: handleClose }, activeDoc);

  const doc = activeDoc;
  btnConfirm.addEventListener('click', handleClose);
  doc.addEventListener('keydown', handleKeydown);

  (overlay as any)._cleanup = () => {
    unregisterEsc();
    btnConfirm.removeEventListener('click', handleClose);
    doc.removeEventListener('keydown', handleKeydown);
    btnCancel.style.display = '';
  };
}

export function showConfirmModal(
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmLabel?: string; danger?: boolean; doc?: Document }
): void {
  const label = options?.confirmLabel ?? 'Delete';
  const fields: FieldDef[] = [];

  showModal(title, fields, () => {
    onConfirm();
    closeModal();
  }, { confirmLabel: label, doc: options?.doc });

  // Replace the empty body with the message text
  const { bodyEl } = nodes(activeDoc);
  bodyEl.innerHTML = '';
  const msgEl = activeDoc.createElement('p');
  msgEl.style.cssText = 'font-size:13px;color:var(--text-secondary);margin:0;line-height:1.5;';
  msgEl.textContent = message;
  bodyEl.appendChild(msgEl);

  // Style the confirm button as danger if requested
  if (options?.danger !== false) {
    const btnConfirm = activeDoc.getElementById('modal-confirm')!;
    btnConfirm.style.background = 'var(--accent)';
    btnConfirm.style.borderColor = 'var(--accent)';
  }
}

