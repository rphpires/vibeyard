// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserTabInstance } from './types.js';

// A browser tab of project B (detached into the sessions window) while the main
// window shows A: draw-mode and the send menu act on B, never on the active project.

const { addPlanSession, promptNewSession } = vi.hoisted(() => ({
  addPlanSession: vi.fn(),
  promptNewSession: vi.fn(),
}));
const projectA = { id: 'A', sessions: [{ id: 'a-cli', name: 'a-cli' }] };
const projectB = { id: 'B', sessions: [{ id: 'b-web', name: 'web', type: 'browser-tab' }, { id: 'b-cli', name: 'b-cli' }] };

vi.mock('../../state.js', () => ({
  appState: {
    get activeProject() { return projectA; },
    projectOfSession(id: string) { return this.findSessionWithProject(id)?.project; },
    findSessionWithProject: (id: string) => {
      for (const project of [projectA, projectB]) {
        const session = project.sessions.find((s) => s.id === id);
        if (session) return { project, session };
      }
      return undefined;
    },
    addPlanSession,
    on: vi.fn(() => () => {}),
  },
}));
vi.mock('../tab-bar.js', () => ({ promptNewSession }));
vi.mock('../terminal-pane.js', () => ({ setPendingPrompt: vi.fn(), getTerminalInstance: vi.fn(() => undefined) }));
vi.mock('./popover.js', () => ({ positionPopover: vi.fn() }));
vi.mock('./viewport.js', () => ({ getViewportContext: () => '' }));

const { sendDrawToNewSession, sendDrawToCustomSession } = await import('./draw-mode.js');
const { showSendMenu } = await import('./send-menu.js');

const otherDoc = document.implementation.createHTMLDocument('sessions');

function bTab(): BrowserTabInstance {
  const el = otherDoc.createElement('div');
  otherDoc.body.appendChild(el);
  return {
    sessionId: 'b-web',
    element: el,
    webview: { capturePage: () => Promise.resolve({ toDataURL: () => 'data:x' }) },
    drawInstructionInput: document.createElement('textarea'),
    drawErrorEl: document.createElement('div'),
    drawPlanModeCheckbox: { checked: false },
    drawAttachDimsCheckbox: { checked: false },
    urlInput: { value: 'https://example.com' },
    drawMode: false,
    sendMenuEl: otherDoc.createElement('div'),
    sendMenuOverlay: otherDoc.createElement('div'),
  } as unknown as BrowserTabInstance;
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { vibeyard: unknown }).vibeyard = {
    browser: { saveScreenshot: vi.fn(() => Promise.resolve('/tmp/shot.png')) },
  };
});

describe('browser tab of the detached project', () => {
  it('Draw → new session creates the session in the tab\'s own project', async () => {
    const tab = bTab();
    tab.drawInstructionInput.value = 'fix it';
    await sendDrawToNewSession(tab);
    expect(addPlanSession).toHaveBeenCalledWith('B', expect.any(String), false);
  });

  it('Draw → custom session opens the dialog for the tab\'s project, in its window', async () => {
    const tab = bTab();
    tab.drawInstructionInput.value = 'fix it';
    await sendDrawToCustomSession(tab);
    expect(promptNewSession).toHaveBeenCalledWith(expect.any(Function), { projectId: 'B', doc: otherDoc });
  });

  it('the send menu lists the tab\'s own project\'s CLI sessions', () => {
    const tab = bTab();
    showSendMenu(tab, otherDoc.createElement('button'), {
      deliverTo: vi.fn(), onNewSession: vi.fn(), onNewWithArgs: vi.fn(),
    } as never);
    const labels = Array.from(tab.sendMenuEl.querySelectorAll('.send-menu-item')).map((el) => el.textContent ?? '');
    expect(labels.some((l) => l.includes('b-cli'))).toBe(true);
    expect(labels.some((l) => l.includes('a-cli'))).toBe(false);
  });
});
