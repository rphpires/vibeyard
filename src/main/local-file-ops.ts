/**
 * File-tree operations on this machine's disk: new entry, rename, copy/move
 * (paste) and writing a pasted image. The sandbox (`file-ops-ipc.ts`) resolves
 * and checks every path first; this module only does the filesystem work.
 * Nothing here ever overwrites: a taken name is refused (new, rename) or
 * numbered (paste, see `uniqueEntryName`), and names are compared without case
 * on Windows and macOS, whose disks treat `README.md` and `readme.md` as one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertEntryName, assignEntryNames } from '../shared/file-names';
import { isPathUnder } from '../shared/platform';
import { isMac, isWin } from './platform';

/** Windows and (default) macOS volumes are case-insensitive. */
export const LOCAL_NAMES_IGNORE_CASE = isWin || isMac;

const CP_OPTS: fs.CopyOptions = { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true };

export async function namesIn(dir: string): Promise<Set<string>> {
  return new Set(await fs.promises.readdir(dir));
}

const lstatOrNull = (p: string) => fs.promises.lstat(p).catch(() => null);

/** Throw when `dest` exists: the last guard before a rename, which would replace it. */
async function refuseExisting(dest: string): Promise<void> {
  if (await lstatOrNull(dest)) throw new Error(`"${path.basename(dest)}" already exists`);
}

/** Create an empty file or a folder named `name` in `dir`; returns its path. */
export async function createLocalEntry(dir: string, name: string, kind: 'file' | 'dir'): Promise<string> {
  assertEntryName(name);
  const target = path.join(dir, name);
  if (kind === 'dir') await fs.promises.mkdir(target);
  else await (await fs.promises.open(target, 'wx')).close();
  return target;
}

/** Rename `target` within its folder; returns the new path. */
export async function renameLocalEntry(target: string, newName: string): Promise<string> {
  assertEntryName(newName);
  const dest = path.join(path.dirname(target), newName);
  if (dest === target) return target;
  const [src, existing] = await Promise.all([fs.promises.lstat(target), lstatOrNull(dest)]);
  // `dest` "existing" is only fine when it is `target` itself: a case-only
  // rename on a case-insensitive disk. A different file must never be replaced.
  if (existing && !(existing.ino === src.ino && existing.dev === src.dev)) throw new Error(`"${newName}" already exists`);
  await fs.promises.rename(target, dest);
  return dest;
}

/**
 * Copy (or move) each of `sources` into `destDir`, numbering a taken name.
 * Moving an entry into the folder it already lives in is a no-op. Returns the
 * created paths.
 */
export async function copyLocalEntries(sources: string[], destDir: string, move: boolean): Promise<string[]> {
  const todo = sources.filter((src) => !(move && path.dirname(src) === destDir));
  const inside = todo.find((src) => isPathUnder(destDir, src));
  if (inside) throw new Error(`Cannot paste "${path.basename(inside)}" into itself`);
  const names = assignEntryNames(todo.map((src) => path.basename(src)), await namesIn(destDir), LOCAL_NAMES_IGNORE_CASE);
  const created: string[] = [];
  for (const [i, src] of todo.entries()) {
    const dest = path.join(destDir, names[i]);
    if (move) await moveEntry(src, dest);
    else await fs.promises.cp(src, dest, CP_OPTS);
    created.push(dest);
  }
  return created;
}

async function moveEntry(src: string, dest: string): Promise<void> {
  await refuseExisting(dest);
  try {
    await fs.promises.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Another volume: rename cannot cross it.
    await fs.promises.cp(src, dest, CP_OPTS);
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

/** Write `bytes` as a new file in `destDir` named `name` (numbered when taken); returns its path. */
export async function writeLocalFile(destDir: string, name: string, bytes: Uint8Array): Promise<string> {
  assertEntryName(name);
  const [free] = assignEntryNames([name], await namesIn(destDir), LOCAL_NAMES_IGNORE_CASE);
  const dest = path.join(destDir, free);
  await fs.promises.writeFile(dest, bytes, { flag: 'wx' });
  return dest;
}

/**
 * Move the single entry tar extracted into `tmp` to `destDir/name` (never over
 * an existing entry). Read back from disk instead of assuming its name: tar
 * may store a remote name differently (characters Windows forbids, codepage).
 */
export async function adoptExtracted(tmp: string, destDir: string, name: string): Promise<string> {
  const [entry] = await fs.promises.readdir(tmp);
  if (!entry) throw new Error('The download was empty');
  const dest = path.join(destDir, name);
  await refuseExisting(dest);
  await fs.promises.rename(path.join(tmp, entry), dest);
  return dest;
}
