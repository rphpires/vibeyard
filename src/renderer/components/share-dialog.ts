// Share dialog — host-side UI for sharing a session via P2P.

import type { ShareMode } from '../../shared/sharing-types.js';
import { shareSession, acceptShareAnswer, endShare } from '../sharing/share-manager.js';
import { isSharing, isConnected } from '../sharing/peer-host.js';
import { validatePin } from '../sharing/share-crypto.js';
import { createPinInput } from '../dom-utils.js';
import { bindModalDismiss } from './modal-manager.js';
import { windowOf } from '../frame.js';

let activeOverlay: HTMLElement | null = null;
let activeDismiss: (() => void) | null = null;
let pendingShareSessionId: string | null = null;

/** Open the share dialog in `doc` (default: the main window; the sessions window passes its own). */
export function showShareDialog(sessionId: string, doc: Document = document): void {
  closeShareDialog();

  const overlay = doc.createElement('div');
  overlay.className = 'share-overlay';
  activeOverlay = overlay;

  const dialog = doc.createElement('div');
  dialog.className = 'share-dialog';

  let selectedMode: ShareMode = 'readonly';

  // Title
  const title = doc.createElement('h3');
  title.textContent = 'Share Session';
  dialog.appendChild(title);

  // ── Phase 1: Permission + Disclaimers ──

  const phase1 = doc.createElement('div');
  phase1.className = 'share-phase';

  const notice = doc.createElement('div');
  notice.className = 'share-notice';
  notice.textContent = 'Your full terminal scrollback history will be shared with the peer.';
  phase1.appendChild(notice);

  const rwWarning = doc.createElement('div');
  rwWarning.className = 'share-notice hidden';
  rwWarning.textContent = 'Read-write mode allows the peer to type into your terminal and execute commands. Only share with people you trust.';
  phase1.appendChild(rwWarning);

  const modeSection = doc.createElement('div');
  modeSection.className = 'share-section';

  const modeLabel = doc.createElement('div');
  modeLabel.className = 'share-label';
  modeLabel.textContent = 'Access level';
  modeSection.appendChild(modeLabel);

  const modeGroup = doc.createElement('div');
  modeGroup.className = 'share-radio-group';

  const readonlyRadio = createRadio(doc, 'share-mode', 'readonly', 'Read-only', true);
  const readwriteRadio = createRadio(doc, 'share-mode', 'readwrite', 'Read-write', false);
  modeGroup.appendChild(readonlyRadio);
  modeGroup.appendChild(readwriteRadio);
  modeSection.appendChild(modeGroup);

  modeGroup.addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value as ShareMode;
    selectedMode = value;
    rwWarning.classList.toggle('hidden', value !== 'readwrite');
  });

  phase1.appendChild(modeSection);
  dialog.appendChild(phase1);

  // ── Phase 2: PIN + Codes ──

  const phase2 = doc.createElement('div');
  phase2.className = 'share-phase hidden';

  const pinSection = doc.createElement('div');
  pinSection.className = 'share-section';

  const pinLabel = doc.createElement('div');
  pinLabel.className = 'share-label';
  pinLabel.textContent = 'Choose a PIN (4–8 digits) to share with your peer';

  const pinInput = createPinInput(doc);
  pinSection.appendChild(pinLabel);
  pinSection.appendChild(pinInput);
  phase2.appendChild(pinSection);

  // Offer code (hidden until generated)
  const offerSection = doc.createElement('div');
  offerSection.className = 'share-section hidden';

  const offerLabel = doc.createElement('div');
  offerLabel.className = 'share-label';
  offerLabel.textContent = 'Send this code to your peer';
  offerSection.appendChild(offerLabel);

  const offerTextarea = doc.createElement('textarea');
  offerTextarea.className = 'share-code';
  offerTextarea.readOnly = true;
  offerTextarea.rows = 3;
  offerSection.appendChild(offerTextarea);

  const copyOfferBtn = doc.createElement('button');
  copyOfferBtn.className = 'btn-secondary share-btn';
  copyOfferBtn.textContent = 'Copy Code';
  copyOfferBtn.addEventListener('click', () => {
    windowOf(doc).navigator.clipboard.writeText(offerTextarea.value);
    copyOfferBtn.textContent = 'Copied!';
    setTimeout(() => { copyOfferBtn.textContent = 'Copy Code'; }, 1500);
  });
  offerSection.appendChild(copyOfferBtn);
  phase2.appendChild(offerSection);

  // Answer code (hidden until offer generated)
  const answerSection = doc.createElement('div');
  answerSection.className = 'share-section hidden';

  const answerLabel = doc.createElement('div');
  answerLabel.className = 'share-label';
  answerLabel.textContent = 'Paste your peer\'s response code';
  answerSection.appendChild(answerLabel);

  const answerTextarea = doc.createElement('textarea');
  answerTextarea.className = 'share-code';
  answerTextarea.rows = 3;
  answerTextarea.placeholder = 'Paste response code here...';
  answerSection.appendChild(answerTextarea);
  phase2.appendChild(answerSection);

  dialog.appendChild(phase2);

  // Status area
  const statusEl = doc.createElement('div');
  statusEl.className = 'share-status';
  dialog.appendChild(statusEl);

  // ── Action buttons (always at bottom) ──

  const actions = doc.createElement('div');
  actions.className = 'share-actions';

  const closeBtn = doc.createElement('button');
  closeBtn.className = 'btn-secondary share-btn';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', closeShareDialog);

  const backBtn = doc.createElement('button');
  backBtn.className = 'btn-secondary share-btn hidden';
  backBtn.textContent = 'Back';

  const nextBtn = doc.createElement('button');
  nextBtn.className = 'btn-primary share-btn';
  nextBtn.textContent = 'Next';

  const startBtn = doc.createElement('button');
  startBtn.className = 'btn-primary share-btn hidden';
  startBtn.textContent = 'Start Sharing';

  const connectBtn = doc.createElement('button');
  connectBtn.className = 'btn-primary share-btn hidden';
  connectBtn.textContent = 'Connect';
  connectBtn.disabled = true;

  actions.appendChild(closeBtn);
  actions.appendChild(backBtn);
  actions.appendChild(nextBtn);
  actions.appendChild(startBtn);
  actions.appendChild(connectBtn);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  doc.body.appendChild(overlay);

  // ── Phase navigation ──

  nextBtn.addEventListener('click', () => {
    phase1.classList.add('hidden');
    phase2.classList.remove('hidden');
    nextBtn.classList.add('hidden');
    backBtn.classList.remove('hidden');
    startBtn.classList.remove('hidden');
    pinInput.focus();
  });

  backBtn.addEventListener('click', () => {
    phase2.classList.add('hidden');
    phase1.classList.remove('hidden');
    backBtn.classList.add('hidden');
    startBtn.classList.add('hidden');
    nextBtn.classList.remove('hidden');
    statusEl.textContent = '';
  });

  // Enable Connect only when answer code is entered
  answerTextarea.addEventListener('input', () => {
    connectBtn.disabled = !answerTextarea.value.trim();
  });

  // Connect handler (registered once, guarded by disabled state)
  connectBtn.addEventListener('click', async () => {
    const answer = answerTextarea.value.trim();
    if (!answer) return;
    try {
      await acceptShareAnswer(sessionId, answer);
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting...';
      answerTextarea.readOnly = true;
      statusEl.textContent = 'Establishing connection...';
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : 'Invalid response code';
    }
  });

  // ── Handle Escape + overlay background click (capture-phase ESC) ──

  activeDismiss = bindModalDismiss({ overlay, onClose: closeShareDialog });

  // ── Start sharing flow ──

  startBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    const pinError = validatePin(pin);
    if (pinError) {
      statusEl.textContent = pinError;
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = 'Generating code...';
    statusEl.textContent = 'Generating connection code...';

    pendingShareSessionId = sessionId;

    try {
      const { offer, handle } = await shareSession(sessionId, selectedMode, pin);

      pinInput.readOnly = true;
      pinLabel.textContent = 'Share this PIN with your peer';
      offerTextarea.value = offer;
      offerSection.classList.remove('hidden');
      answerSection.classList.remove('hidden');
      startBtn.classList.add('hidden');
      backBtn.classList.add('hidden');
      connectBtn.classList.remove('hidden');
      statusEl.textContent = 'Waiting for peer to connect...';

      handle.onConnected(() => {
        closeShareDialog();
      });

      handle.onAuthFailed((reason: string) => {
        statusEl.textContent = `Authentication failed: ${reason}`;
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
        answerTextarea.value = '';
        answerTextarea.readOnly = false;
      });
    } catch (err) {
      if (pendingShareSessionId && isSharing(pendingShareSessionId)) {
        endShare(pendingShareSessionId);
      }
      pendingShareSessionId = null;
      statusEl.textContent = `Error: ${err instanceof Error ? err.message : 'Unknown error'}`;
      startBtn.disabled = false;
      startBtn.textContent = 'Start Sharing';
    }
  });
}

export function closeShareDialog(): void {
  if (activeDismiss) {
    activeDismiss();
    activeDismiss = null;
  }
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
  if (pendingShareSessionId && isSharing(pendingShareSessionId) && !isConnected(pendingShareSessionId)) {
    endShare(pendingShareSessionId);
  }
  pendingShareSessionId = null;
}

function createRadio(doc: Document, name: string, value: string, labelText: string, checked: boolean): HTMLElement {
  const wrapper = doc.createElement('label');
  wrapper.className = 'share-radio-label';
  const input = doc.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  input.checked = checked;
  const span = doc.createElement('span');
  span.textContent = labelText;
  wrapper.appendChild(input);
  wrapper.appendChild(span);
  return wrapper;
}
