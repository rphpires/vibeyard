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
import { appState, type SessionRecord } from './state.js';
import {
  currentCommandSource,
  getDetachedProjectId,
  viewActiveSessionId,
  viewShowsSession,
  type ViewKind,
} from './session-window-state.js';
import { focusSessionWindow, getSessionWindowDocument, isSessionWindowFocused } from './session-window.js';

/** The window a native-menu click came from. */
export type CommandSource = 'main' | 'sessions';

/**
 * The view a command acts on: `source` when given (a menu click), else the window of
 * the key press being handled, else the focused window.
 */
export function commandTargetView(source?: CommandSource): ViewKind {
  if (!getDetachedProjectId()) return 'main';
  const from = source ?? currentCommandSource();
  if (from) return from;
  return isSessionWindowFocused() ? 'sessions' : 'main';
}

export function commandTargetProjectId(source?: CommandSource): string | null {
  return commandTargetView(source) === 'sessions' ? getDetachedProjectId() : appState.activeProjectId;
}

/** The tab the target view shows as active in the target project. */
export function commandTargetSession(source?: CommandSource): SessionRecord | undefined {
  const projectId = commandTargetProjectId(source);
  const project = appState.projects.find((p) => p.id === projectId);
  if (!project) return undefined;
  const id = viewActiveSessionId(commandTargetView(source), project);
  return id ? project.sessions.find((s) => s.id === id) : undefined;
}

/** The document of the target view's window (for dialogs and blur). */
export function commandTargetDoc(source?: CommandSource): Document {
  return (commandTargetView(source) === 'sessions' && getSessionWindowDocument()) || document;
}

/** The document of the window that shows this session's tab. */
export function docForSession(projectId: string, sessionId: string): Document {
  const session = appState.projects.find((p) => p.id === projectId)?.sessions.find((s) => s.id === sessionId);
  return (session && viewShowsSession('sessions', projectId, session) && getSessionWindowDocument()) || document;
}

/**
 * Run a command that only exists in the main window (sidebar, git panel, project
 * terminal, quick open, preferences, …): fired from the sessions window, bring the
 * main window forward first.
 */
export function runInMainWindow(fn: () => void, source?: CommandSource): void {
  if (commandTargetView(source) === 'sessions') window.focus();
  fn();
}

/**
 * Show a session wherever it lives. A tab of the sessions window is activated there
 * and that window comes forward, the main window keeping its project; anything else
 * switches the main window to its project, as before.
 */
export function revealSession(projectId: string, sessionId: string): void {
  const project = appState.projects.find((p) => p.id === projectId);
  const session = project?.sessions.find((s) => s.id === sessionId);
  if (!project || !session) return;
  if (viewShowsSession('sessions', projectId, session)) {
    appState.setActiveSession(projectId, sessionId);
    focusSessionWindow();
    return;
  }
  if (appState.activeProjectId !== projectId) appState.setActiveProject(projectId);
  appState.setActiveSession(projectId, sessionId);
}

/** Make a project active in the main window; a detached one also brings its sessions window forward. */
export function revealProject(projectId: string): void {
  appState.setActiveProject(projectId);
  if (projectId === getDetachedProjectId()) focusSessionWindow();
}
