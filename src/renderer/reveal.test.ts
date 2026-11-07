// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Which window a command or a "show me this session" acts on, with A active in the
// main window and B detached into the sessions window. Real appState; the sessions
// window controller is mocked (its focus state is the input here).

const { sw, ctlListeners } = vi.hoisted(() => ({
  sw: {
    focusSessionWindow: vi.fn(),
    closeSessionWindow: vi.fn(),
    isSessionWindowFocused: vi.fn(() => false),
    getSessionWindowDocument: vi.fn((): Document | null => null),
  },
  ctlListeners: {} as Record<string, (...a: unknown[]) => void>,
}));
vi.mock('./session-window.js', () => sw);
vi.mock('./session-cost.js', () => ({ getCost: vi.fn().mockReturnValue(null), restoreCost: vi.fn() }));
vi.mock('./session-context.js', () => ({ restoreContext: vi.fn() }));
vi.mock('./provider-availability.js', () => ({
  getProviderCapabilities: vi.fn(() => ({})),
  getProviderAvailabilitySnapshot: vi.fn(() => null),
  loadProviderAvailability: vi.fn(() => Promise.resolve()),
  getTeamChatProviderMetas: vi.fn(() => []),
}));
vi.mock('./components/modal.js', () => ({
  showModal: vi.fn(), closeModal: vi.fn(), setModalError: vi.fn(), showConfirmDialog: vi.fn(),
}));
vi.mock('./components/join-dialog.js', () => ({ showJoinDialog: vi.fn() }));
vi.mock('./components/path-autocomplete.js', () => ({ attachPathAutocomplete: vi.fn() }));
vi.mock('./run-location.js', () => ({ resolveRunLocation: vi.fn() }));
vi.mock('./components/terminal-pane.js', () => ({ getTerminalInstance: vi.fn(() => undefined) }));

(window as unknown as { vibeyard: unknown }).vibeyard = {
  store: { load: vi.fn(), save: vi.fn() },
  ctl: {
    onCommand: vi.fn((cb) => { ctlListeners.command = cb; return () => {}; }),
    reply: vi.fn(),
    setEnabled: vi.fn(),
    rendererReady: vi.fn(),
  },
};

const { appState, _resetForTesting } = await import('./state.js');
const ws = await import('./session-window-state.js');
const reveal = await import('./reveal.js');
const { quickNewSession } = await import('./components/tab-bar/session-menu.js');
const { initCtlBridge } = await import('./ctl-bridge.js');

function setup() {
  const b = appState.addProject('B', '/b');
  const b1 = appState.addSession(b.id, 'b1')!;
  const a = appState.addProject('A', '/a');
  const a1 = appState.addSession(a.id, 'a1')!;
  appState.setActiveProject(a.id);
  ws.setDetachedProjectId(b.id);
  return { a, a1, b, b1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  sw.isSessionWindowFocused.mockReturnValue(false);
  sw.getSessionWindowDocument.mockReturnValue(null);
  _resetForTesting();
  ws._resetForTesting();
});

describe('commandTargetProjectId / commandTargetSession', () => {
  it('with the sessions window focused, commands act on the detached project', () => {
    const { b, b1 } = setup();
    sw.isSessionWindowFocused.mockReturnValue(true);
    expect(reveal.commandTargetProjectId()).toBe(b.id);
    expect(reveal.commandTargetSession()?.id).toBe(b1.id);
    expect(reveal.commandTargetView()).toBe('sessions');
  });

  it('an explicit source wins over focus', () => {
    const { a, a1, b } = setup();
    sw.isSessionWindowFocused.mockReturnValue(true);
    expect(reveal.commandTargetProjectId('main')).toBe(a.id);
    expect(reveal.commandTargetSession('main')?.id).toBe(a1.id);
    sw.isSessionWindowFocused.mockReturnValue(false);
    expect(reveal.commandTargetProjectId('sessions')).toBe(b.id);
  });

  it('without focus or source: the active project', () => {
    const { a } = setup();
    expect(reveal.commandTargetProjectId()).toBe(a.id);
  });

  it('source "sessions" with nothing detached falls back to the main window', () => {
    const { a } = setup();
    ws.setDetachedProjectId(null);
    expect(reveal.commandTargetProjectId('sessions')).toBe(a.id);
    expect(reveal.commandTargetView('sessions')).toBe('main');
  });

  it('main view of the detached active project: its selected project-level tab, never a sessions-window tab', () => {
    const { b } = setup();
    appState.setActiveProject(b.id);
    expect(reveal.commandTargetSession('main')).toBeUndefined();
    const ov = appState.openProjectTab(b.id)!;
    expect(reveal.commandTargetSession('main')?.id).toBe(ov.id);
  });

  it('commandTargetDoc: the sessions window document when it is the target', () => {
    setup();
    const child = document.implementation.createHTMLDocument('child');
    sw.getSessionWindowDocument.mockReturnValue(child);
    expect(reveal.commandTargetDoc('sessions')).toBe(child);
    expect(reveal.commandTargetDoc('main')).toBe(document);
  });
});

describe('Ctrl+T from the sessions window', () => {
  it('quickNewSession(commandTargetProjectId()) creates in B and the main window stays on A', () => {
    const { a, b } = setup();
    sw.isSessionWindowFocused.mockReturnValue(true);
    const before = b.sessions.length;
    quickNewSession(reveal.commandTargetProjectId()!);
    expect(b.sessions.length).toBe(before + 1);
    expect(appState.activeProjectId).toBe(a.id);
  });

  it('quickNewSession blurs the focused element of the document it is given', () => {
    const { b } = setup();
    const child = document.implementation.createHTMLDocument('child');
    const input = child.createElement('input');
    child.body.appendChild(input);
    const blur = vi.spyOn(input, 'blur');
    Object.defineProperty(child, 'activeElement', { value: input, configurable: true });
    quickNewSession(b.id, child);
    expect(blur).toHaveBeenCalled();
  });
});

describe('revealSession / revealProject', () => {
  it('revealSession of a sessions-window session focuses that window and keeps the main project', () => {
    const { a, b } = setup();
    const b2 = appState.addSession(b.id, 'b2')!;
    const b1 = b.sessions[0];
    appState.setActiveSession(b.id, b1.id);
    const spy = vi.spyOn(appState, 'setActiveProject');
    reveal.revealSession(b.id, b2.id);
    expect(b.activeSessionId).toBe(b2.id);
    expect(sw.focusSessionWindow).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(appState.activeProjectId).toBe(a.id);
  });

  it('revealSession of a session in the main window switches project there', () => {
    const { a } = setup();
    const c = appState.addProject('C', '/c');
    const c1 = appState.addSession(c.id, 'c1')!;
    appState.setActiveProject(a.id);
    reveal.revealSession(c.id, c1.id);
    expect(appState.activeProjectId).toBe(c.id);
    expect(c.activeSessionId).toBe(c1.id);
    expect(sw.focusSessionWindow).not.toHaveBeenCalled();
  });

  it('revealSession of a closed (detached-flag) tab in the detached project reattaches it in the sessions window', () => {
    const { b, b1 } = setup();
    appState.addSession(b.id, 'b2');
    appState.closeTabs(b.id, [b1.id]);
    expect(b.sessions.find((s) => s.id === b1.id)?.detached).toBe(true);
    reveal.revealSession(b.id, b1.id);
    expect(b.sessions.find((s) => s.id === b1.id)?.detached).toBeFalsy();
    expect(b.activeSessionId).toBe(b1.id);
    expect(sw.focusSessionWindow).toHaveBeenCalled();
  });

  it('revealProject of the detached project activates it in main and focuses the sessions window', () => {
    const { b } = setup();
    reveal.revealProject(b.id);
    expect(appState.activeProjectId).toBe(b.id);
    expect(sw.focusSessionWindow).toHaveBeenCalled();
  });

  it('revealProject of another project does not touch the sessions window', () => {
    const { a, b } = setup();
    appState.setActiveProject(b.id);
    reveal.revealProject(a.id);
    expect(appState.activeProjectId).toBe(a.id);
    expect(sw.focusSessionWindow).not.toHaveBeenCalled();
  });
});

describe('vibeyard-ctl', () => {
  it('new-session --project B --focus keeps the main project and focuses the sessions window', () => {
    const { a, b, b1 } = setup();
    initCtlBridge();
    ctlListeners.command('r1', b1.id, { action: 'new-session', name: 'worker', project: b.id, focus: true });
    const reply = vi.mocked(window.vibeyard.ctl.reply).mock.calls[0][1] as { ok: boolean; result: { sessionId: string } };
    expect(reply.ok).toBe(true);
    expect(appState.activeProjectId).toBe(a.id);
    expect(b.activeSessionId).toBe(reply.result.sessionId);
    expect(sw.focusSessionWindow).toHaveBeenCalled();
  });

  it('new-session --project B without --focus does not focus the sessions window', () => {
    const { b, b1 } = setup();
    initCtlBridge();
    ctlListeners.command('r2', b1.id, { action: 'new-session', name: 'worker', project: b.id });
    expect(sw.focusSessionWindow).not.toHaveBeenCalled();
  });
});
