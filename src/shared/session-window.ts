/** Frame name the renderer passes to window.open() to get the sessions window. */
export const SESSION_WINDOW_FRAME = 'vibeyard-sessions';

/** Which window a view renders in (and a command came from): the main window or the separate sessions window. */
export type ViewKind = 'main' | 'sessions';
