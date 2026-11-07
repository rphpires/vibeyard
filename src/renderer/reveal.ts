/**
 * Which window a command acts on, and how to bring a session or project into view.
 *
 * With a project detached into the sessions window, "the current project/tab" depends
 * on where the user is: a shortcut pressed in the sessions window (or a native-menu
 * click whose `source` is that window) acts on the detached project and on the tab
 * the sessions view shows; anything else acts on the main window's active project and
 * on the tab the main view shows — for the detached project, that is the main view's
 * own selection of Overview/Kanban/Team, never one of the sessions window's tabs.
 */
import { appState, type NavTarget, type SessionRecord } from './state.js';
import {
  currentCommandSource,
  getDetachedProjectId,
  viewActiveSessionId,
  viewShowsSession,
  type ViewKind,
} from './session-window-state.js';
import { focusSessionWindow, getSessionWindowDocument, isSessionWindowFocused } from './session-window-handle.js';

/**
 * The view a command acts on: `source` when given (a menu click), else the window of
 * the key press being handled, else the focused window.
 */
export function commandTargetView(source?: ViewKind): ViewKind {
  if (!getDetachedProjectId()) return 'main';
  const from = source ?? currentCommandSource();
  if (from) return from;
  return isSessionWindowFocused() ? 'sessions' : 'main';
}

export function commandTargetProjectId(source?: ViewKind): string | null {
  return commandTargetView(source) === 'sessions' ? getDetachedProjectId() : appState.activeProjectId;
}

/** The tab the target view shows as active in the target project. */
export function commandTargetSession(source?: ViewKind): SessionRecord | undefined {
  const project = appState.getProject(commandTargetProjectId(source));
  if (!project) return undefined;
  const id = viewActiveSessionId(commandTargetView(source), project);
  return id ? project.sessions.find((s) => s.id === id) : undefined;
}

/** The document of the target view's window (for dialogs and blur). */
export function commandTargetDoc(source?: ViewKind): Document {
  return (commandTargetView(source) === 'sessions' && getSessionWindowDocument()) || document;
}

/** The document of the window that shows this session's tab. */
export function docForSession(projectId: string, sessionId: string): Document {
  const found = appState.findSessionWithProject(sessionId);
  const inSessionsWindow = found?.project.id === projectId && viewShowsSession('sessions', projectId, found.session);
  return (inSessionsWindow && getSessionWindowDocument()) || document;
}

/**
 * Run a command that only exists in the main window (sidebar, git panel, project
 * terminal, quick open, preferences, …): fired from the sessions window, bring the
 * main window forward first — through `app:focus` (restore + focus with steal), since
 * `window.focus()` does not reliably raise a window on Windows.
 */
export function runInMainWindow(fn: () => void, source?: ViewKind): void {
  if (commandTargetView(source) === 'sessions') window.vibeyard.app.focus();
  fn();
}

/**
 * Show a session wherever it lives. A tab of the sessions window is activated there
 * and that window comes forward, the main window keeping its project; anything else
 * switches the main window to its project, as before.
 */
export function revealSession(projectId: string, sessionId: string): void {
  const session = appState.getProject(projectId)?.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  if (viewShowsSession('sessions', projectId, session)) {
    appState.setActiveSession(projectId, sessionId);
    focusSessionWindow();
    return;
  }
  if (appState.activeProjectId !== projectId) appState.setActiveProject(projectId);
  appState.setActiveSession(projectId, sessionId);
}

/**
 * A tab just created that the sessions view shows: bring that window forward, so a tab
 * opened from the main window (a diff from the git panel, "+", the More menu, a file
 * link) does not land unseen behind it. Creating it already made it the active tab.
 */
export function focusIfInSessionWindow(projectId: string, session: SessionRecord | undefined): void {
  if (session && viewShowsSession('sessions', projectId, session)) focusSessionWindow();
}

/**
 * After a Back/Forward step (which already selected the tab, without touching nav
 * history): a tab of the sessions window brings that window forward.
 */
export function revealNavTarget(target: NavTarget | undefined): void {
  if (!target) return;
  const found = appState.findSessionWithProject(target.sessionId);
  if (found?.project.id === target.projectId) focusIfInSessionWindow(target.projectId, found.session);
}

/** Resume a history entry and show the tab where it lands (revealSession). */
export async function resumeAndReveal(projectId: string, archivedId: string): Promise<void> {
  const session = await appState.resumeFromHistorySafe(projectId, archivedId);
  if (session) revealSession(projectId, session.id);
}

/** Make a project active in the main window; a detached one also brings its sessions window forward. */
export function revealProject(projectId: string): void {
  appState.setActiveProject(projectId);
  if (projectId === getDetachedProjectId()) focusSessionWindow();
}
