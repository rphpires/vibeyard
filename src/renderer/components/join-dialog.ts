// Join dialog — guest-side UI for joining a shared P2P session.

import { joinRemoteSession } from '../sharing/share-manager.js';
import { appState } from '../state.js';
import { DecryptionError, validatePin } from '../sharing/share-crypto.js';
import { createPinInput } from '../dom-utils.js';
import { bindModalDismiss } from './modal-manager.js';
import { windowOf } from '../frame.js';

let activeOverlay: HTMLElement | null = null;
let activeDismiss: (() => void) | null = null;

export interface JoinDialogOptions {
  /** Project the remote session joins (default: the active project). */
  projectId?: string;
  /** Document to open the dialog in (default: the main window's). */
  doc?: Document;
}

export function showJoinDialog(opts: JoinDialogOptions = {}): void {
  closeJoinDialog();

  const doc = opts.doc ?? document;
  const project = opts.projectId ? appState.getProject(opts.projectId) : appState.activeProject;
  if (!project) return;

  const overlay = doc.createElement('div');
  overlay.className = 'share-overlay';
  activeOverlay = overlay;

  const dialog = doc.createElement('div');
  dialog.className = 'share-dialog';

  // Title
  const title = doc.createElement('h3');
  title.textContent = 'Join Remote Session';
  dialog.appendChild(title);

  // Offer input section (PIN + code paste together)
  const offerSection = doc.createElement('div');
  offerSection.className = 'share-section';

  const pinLabel = doc.createElement('div');
  pinLabel.className = 'share-label';
  pinLabel.textContent = 'Enter the PIN from the host';
  offerSection.appendChild(pinLabel);

  const pinInput = createPinInput(doc);
  offerSection.appendChild(pinInput);

  const offerLabel = doc.createElement('div');
  offerLabel.className = 'share-label share-label-spaced';
  offerLabel.textContent = 'Paste the host\'s connection code';
  offerSection.appendChild(offerLabel);

  const offerTextarea = doc.createElement('textarea');
  offerTextarea.className = 'share-code';
  offerTextarea.rows = 3;
  offerTextarea.placeholder = 'Paste connection code here...';
  offerSection.appendChild(offerTextarea);
  dialog.appendChild(offerSection);

  // Status area
  const statusEl = doc.createElement('div');
  statusEl.className = 'share-status';
  dialog.appendChild(statusEl);

  // Answer section (hidden initially)
  const answerSection = doc.createElement('div');
  answerSection.className = 'share-section hidden';

  const answerLabel = doc.createElement('div');
  answerLabel.className = 'share-label';
  answerLabel.textContent = 'Send this response code back to the host';
  answerSection.appendChild(answerLabel);

  const answerTextarea = doc.createElement('textarea');
  answerTextarea.className = 'share-code';
  answerTextarea.readOnly = true;
  answerTextarea.rows = 3;
  answerSection.appendChild(answerTextarea);

  const copyAnswerBtn = doc.createElement('button');
  copyAnswerBtn.className = 'btn-secondary share-btn';
  copyAnswerBtn.textContent = 'Copy Response';
  copyAnswerBtn.addEventListener('click', () => {
    windowOf(doc).navigator.clipboard.writeText(answerTextarea.value);
    copyAnswerBtn.textContent = 'Copied!';
    setTimeout(() => { copyAnswerBtn.textContent = 'Copy Response'; }, 1500);
  });
  answerSection.appendChild(copyAnswerBtn);
  dialog.appendChild(answerSection);

  // Action buttons
  const actions = doc.createElement('div');
  actions.className = 'share-actions';

  const joinBtn = doc.createElement('button');
  joinBtn.className = 'btn-primary share-btn';
  joinBtn.textContent = 'Join';

  const closeBtn = doc.createElement('button');
  closeBtn.className = 'btn-secondary share-btn';
  closeBtn.textContent = 'Cancel';
  closeBtn.addEventListener('click', closeJoinDialog);

  actions.appendChild(closeBtn);
  actions.appendChild(joinBtn);
  dialog.appendChild(actions);

  overlay.appendChild(dialog);
  doc.body.appendChild(overlay);

  // ESC + overlay background click close the dialog (capture-phase ESC so it
  // works over a focused terminal and never leaks to the PTY).
  activeDismiss = bindModalDismiss({ overlay, onClose: closeJoinDialog });

  // Join flow
  joinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    const pinError = validatePin(pin);
    if (pinError) {
      statusEl.textContent = pinError;
      return;
    }
    const offer = offerTextarea.value.trim();
    if (!offer) {
      statusEl.textContent = 'Please paste the connection code from the host.';
      return;
    }

    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting...';
    statusEl.textContent = 'Generating response code...';
    offerTextarea.readOnly = true;
    pinInput.readOnly = true;

    try {
      const { answer } = await joinRemoteSession(project.id, offer, pin, closeJoinDialog);

      answerTextarea.value = answer;
      answerSection.classList.remove('hidden');
      statusEl.textContent = 'Send the response code to the host. The session will appear once they connect.';

      closeBtn.textContent = 'Close';
    } catch (err) {
      if (err instanceof DecryptionError) {
        statusEl.textContent = 'Could not decrypt connection code. Check the PIN and try again.';
      } else {
        statusEl.textContent = `Error: ${err instanceof Error ? err.message : 'Invalid code'}`;
      }
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join';
      offerTextarea.readOnly = false;
      pinInput.readOnly = false;
    }
  });
}

export function closeJoinDialog(): void {
  if (activeDismiss) {
    activeDismiss();
    activeDismiss = null;
  }
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}
