import { appState } from '../../state.js';
import type { PromptNewSessionOptions } from '../tab-bar.js';
import type { BrowserTabInstance } from './types.js';

/**
 * Options for a custom-session dialog opened from a pane: the pane's own project
 * (not the active one: in the sessions window they differ), in the pane's window.
 */
export function ownerPromptOptions(sessionId: string, el: HTMLElement): PromptNewSessionOptions {
  return { projectId: appState.projectOfSession(sessionId)?.id, doc: el.ownerDocument };
}

/** Options for the custom-session dialog opened from a browser tab: its project, in its window. */
export function customSessionOptions(instance: BrowserTabInstance): PromptNewSessionOptions {
  return ownerPromptOptions(instance.sessionId, instance.element);
}
