/**
 * Name helpers for file-tree operations (new, rename, paste), shared by the
 * main process (local and SSH backends) and the renderer (dialog validation).
 */

/**
 * Why `name` cannot be used as a single path segment, or null when it can.
 * Separators of both platforms are refused everywhere: a name that is fine on
 * an SSH host may be pasted into a local Windows folder later.
 */
export function entryNameError(name: string): string | null {
  if (!name.trim()) return 'Name is required';
  if (name === '.' || name === '..') return 'Name cannot be "." or ".."';
  if (/[\\/]/.test(name)) return 'Name cannot contain / or \\';
  if (name.includes('\0')) return 'Name cannot contain a NUL character';
  return null;
}

/** `entryNameError` as a throw, for the main-process operations. */
export function assertEntryName(name: string): void {
  const err = entryNameError(name);
  if (err) throw new Error(err);
}

/**
 * `name` if no entry of `taken` uses it, else the first free `base (n).ext`
 * (`report (1).pdf`, `src (2)`), the way file managers number a pasted copy.
 * A leading dot is part of the base, so `.env` becomes `.env (1)`. With
 * `ignoreCase` (Windows and macOS disks) `README.md` counts as taken by
 * `readme.md`, since writing it would replace that file.
 */
export function uniqueEntryName(name: string, taken: ReadonlySet<string>, ignoreCase = false): string {
  const lower = ignoreCase ? new Set([...taken].map((n) => n.toLowerCase())) : null;
  const isTaken = (n: string) => (lower ? lower.has(n.toLowerCase()) : taken.has(n));
  if (!isTaken(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** A free name (see `uniqueEntryName`) for each of `names`, also distinct from one another. */
export function assignEntryNames(names: string[], taken: ReadonlySet<string>, ignoreCase = false): string[] {
  const used = new Set(taken);
  return names.map((name) => {
    const free = uniqueEntryName(name, used, ignoreCase);
    used.add(free);
    return free;
  });
}

/** File name for an image pasted from the clipboard, e.g. `pasted-image-20261107-153012.png`. */
export function pastedImageName(at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `pasted-image-${day}-${time}.png`;
}

/** Result of a file-tree operation, as returned over IPC. */
export interface FileOpResult {
  ok: boolean;
  error?: string;
  /** Paths created by the operation (new entry, pasted copies). */
  paths?: string[];
  /** A clipboard paste found neither files nor an image to paste. */
  empty?: boolean;
}
