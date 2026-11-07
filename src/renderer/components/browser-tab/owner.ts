import { appState } from '../../state.js';
import type { PromptNewSessionOptions } from '../tab-bar.js';
import type { BrowserTabInstance } from './types.js';

/** Options for the custom-session dialog opened from a browser tab: its project, in its window. */
export function customSessionOptions(instance: BrowserTabInstance): PromptNewSessionOptions {
  return { projectId: appState.projectOfSession(instance.sessionId)?.id, doc: instance.element.ownerDocument };
}
