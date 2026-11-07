import { appState, type ProjectRecord } from '../../state.js';
import type { PromptNewSessionOptions } from '../tab-bar.js';
import type { BrowserTabInstance } from './types.js';

/**
 * The project owning a browser tab. Not `appState.activeProject`: a browser tab of
 * the project detached into the sessions window belongs to that project while the
 * main window shows another one.
 */
export function browserTabProject(instance: BrowserTabInstance): ProjectRecord | undefined {
  return appState.findSessionWithProject(instance.sessionId)?.project;
}

/** Options for the custom-session dialog opened from a browser tab: its project, in its window. */
export function customSessionOptions(instance: BrowserTabInstance): PromptNewSessionOptions {
  return { projectId: browserTabProject(instance)?.id, doc: instance.element.ownerDocument };
}
