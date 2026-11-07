import { appState } from './state.js';
import { resolveProjectFilePath } from './state/specialized-sessions.js';
import { getDetachedProjectId, viewShowsSession } from './session-window-state.js';
import { focusSessionWindow } from './session-window-handle.js';

/**
 * The project, if some window shows it: the main window's active project, or the
 * project detached into the sessions window (whose terminals pass their own id).
 */
function onScreenProject(projectId: string) {
  const active = appState.activeProject;
  if (active?.id === projectId) return active;
  if (projectId === getDetachedProjectId()) return appState.projects.find((p) => p.id === projectId);
  return undefined;
}

/**
 * Open a path in a file-reader tab, but only once the path is known to be an
 * openable file. `projectId` must be on screen — the active project, or the one
 * detached into the sessions window — so a row rendered for a project the user has
 * since left is dropped rather than opened. A tab that lands in the sessions
 * window brings that window forward.
 *
 * Checking first is load-bearing, not defensive: `addFileReaderSession` appends
 * the new tab and makes it active *before* anything touches the filesystem, so
 * a dead path spawns a tab that `loadFile`'s `closeSessionIfFileMissing` tears
 * down a moment later — and `removeSession` then falls back to the left
 * neighbour by index, not to the tab the user came from. The user sees a tab
 * flash and lands somewhere arbitrary.
 *
 * `exists` is also true for a directory, whose read fails with EISDIR; that tab
 * is never reaped (the path really is there) and sticks around permanently
 * showing "Failed to load file".
 *
 * Failures are console-only, matching every other silent-open path in the
 * renderer — and this never rejects, so callers can fire it off with a bare
 * `void` instead of each repeating the same `.catch`.
 */
export async function openFileReaderChecked(
  projectId: string,
  filePath: string,
  lineNumber?: number,
): Promise<void> {
  const project = onScreenProject(projectId);
  if (!project) {
    console.warn(`[open-file] ${projectId} is not on screen: ${filePath}`);
    return;
  }

  const fullPath = resolveProjectFilePath(project, filePath);

  try {
    const [exists, isDir] = await Promise.all([
      window.vibeyard.fs.exists(fullPath),
      window.vibeyard.fs.isDirectory(fullPath),
    ]);
    if (!exists || isDir) {
      console.warn(`[open-file] not an openable file: ${fullPath}`);
      return;
    }
  } catch (err: unknown) {
    // An invoke rejects when the window is tearing down mid-click.
    console.warn(`[open-file] could not check ${fullPath}`, err);
    return;
  }

  // Re-check after the await: the user may have switched projects while the IPC
  // was in flight, and appending to the one they left would silently steal its
  // tab selection.
  if (!onScreenProject(projectId)) {
    console.warn(`[open-file] project left the screen mid-lookup, dropping ${fullPath}`);
    return;
  }

  const session = appState.addFileReaderSession(projectId, fullPath, lineNumber);
  if (session && viewShowsSession('sessions', projectId, session)) focusSessionWindow();
}
