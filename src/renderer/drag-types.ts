export const FILE_PATH_DRAG_TYPE = 'application/x-vibeyard-file-path';

// Standard HTML5 DataTransfer marker for native OS file drags (Finder, Explorer, etc.).
export const NATIVE_FILES_DRAG_TYPE = 'Files';

/** Local paths of the OS files in a drop (empty for an in-app drag). */
export function droppedFilePaths(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  const paths: string[] = [];
  for (const file of Array.from(dt.files)) {
    const path = window.vibeyard.fs.getDroppedFilePath(file);
    if (path) paths.push(path);
  }
  return paths;
}
