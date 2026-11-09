/**
 * File-tree operations on an SSH host: new entry, rename, delete, copy/move,
 * stat, and moving files between this machine and the host (upload a pasted
 * or dropped file, download, fetch a read-only local copy to open).
 *
 * Every remote script runs under `sh` (sent on stdin, or as `sh -c` when stdin
 * carries a tar stream), so the user's login shell (fish, zsh...) never parses
 * it, and every path in it is `shQuote`d. The sandbox (`file-ops-ipc.ts`)
 * checks each path lexically against the host's remote project roots; each
 * script then re-checks on the host, with symlinks resolved (`guard`), that the
 * folder it touches really is inside that root, so a link inside the project
 * cannot aim an `rm -rf` or a write outside it. Like the local ops, nothing
 * overwrites: a taken name is refused (new, rename) or numbered (paste).
 *
 * Each ssh call is a full login (Windows OpenSSH shares no connections), so an
 * operation is one script where it can be: a paste of N entries on the host
 * runs every `cp`/`mv` in one call, and opening a file stats and fetches it in
 * one. Folders travel as tar streams (`tar -cf - | ssh … tar -xf -`) extracted
 * into a temporary folder next to the destination and then renamed into place,
 * so a numbered name works for folders too and an interrupted transfer never
 * leaves a half-written entry under the real name.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BATCH_OPTS, listRemoteDirEntries, resolveSshBinary, resolveSystemBinary, runSshRaw, shQuote, sshFailure } from './remote-ssh';
import { adoptExtracted, LOCAL_NAMES_IGNORE_CASE, namesIn } from './local-file-ops';
import { isWin } from './platform';
import { assertEntryName, assignEntryNames } from '../shared/file-names';
import { basename, isPathUnder } from '../shared/platform';

/** Local folder for the read-only copies of remote files opened in the file reader. */
export const REMOTE_FILES_DIR = path.join(os.homedir(), '.vibeyard', 'remote-files');

/** Largest remote file fetched to be opened in the reader. */
const MAX_OPEN_COPY_BYTES = 50 * 1024 * 1024;
/** A transfer that has not finished after this long is killed. */
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

const posixDir = (p: string) => path.posix.dirname(p);
const posixJoin = (dir: string, name: string) => path.posix.join(dir, name);
const q = shQuote;

/** A host path the sandbox checked, with the remote project folder it is inside. */
export interface RemoteTarget {
  host: string;
  root: string;
  path: string;
}

/** Fails with `msg` (exit 1) when `target` exists, so nothing is overwritten. */
const refuseExisting = (target: string) =>
  `if [ -e ${q(target)} ] || [ -L ${q(target)} ]; then echo ${q(`"${basename(target)}" already exists`)} >&2; exit 1; fi`;

/**
 * Exit unless each of `dirs`, with symlinks resolved (`pwd -P`), is inside
 * `root` (resolved the same way). The lexical check in the sandbox cannot see
 * a link; this one runs on the host and can.
 */
function guard(root: string, dirs: string[]): string {
  const lines = [`r=$(cd -P -- ${q(root)} && pwd -P) || { echo 'Cannot resolve the project folder' >&2; exit 1; }`];
  for (const dir of [...new Set(dirs)]) {
    lines.push(
      `d=$(cd -P -- ${q(dir)} && pwd -P) || { echo ${q(`Cannot open ${dir}`)} >&2; exit 1; }`,
      `if [ "$r" != / ]; then case "$d/" in "$r"/*) ;; *) echo 'Path leaves the project folder' >&2; exit 1;; esac; fi`,
    );
  }
  return lines.join('\n');
}

/** GNU stat first, then BSD/macOS: "<size> <mtime seconds>". */
const statCmd = (target: string) => `stat -c '%s %Y' -- ${q(target)} 2>/dev/null || stat -f '%z %m' -- ${q(target)}`;

/** One sh script per operation, each starting with its `guard`. Pure (unit-tested); every value is quoted. */
export const remoteScripts = {
  mkdir: (root: string, target: string) => `${guard(root, [posixDir(target)])}\nmkdir -- ${q(target)}\n`,
  touch: (root: string, target: string) => `${guard(root, [posixDir(target)])}\n${refuseExisting(target)}\n: > ${q(target)}\n`,
  /** Copy (or move) each `[from, to]` pair, stopping at the first failure. */
  transfer: (root: string, pairs: Array<[string, string]>, move: boolean) => [
    guard(root, pairs.flatMap(([from, to]) => [posixDir(from), posixDir(to)])),
    ...pairs.map(([from, to]) => `${refuseExisting(to)}\n${move ? 'mv --' : 'cp -R -P --'} ${q(from)} ${q(to)} || exit 1`),
  ].join('\n') + '\n',
  remove: (root: string, target: string) => `${guard(root, [posixDir(target)])}\nrm -rf -- ${q(target)}\n`,
  stat: (root: string, target: string) => `${guard(root, [posixDir(target)])}\n${statCmd(target)}\n`,
  /**
   * Print the file's "<size> <mtime>" line, then its bytes unless that line
   * equals `known` (the local copy is still current) — one call either way.
   */
  fetch: (root: string, target: string, known: string, maxBytes: number) => [
    guard(root, [posixDir(target)]),
    `s=$(${statCmd(target)}) || exit 1`,
    `printf '%s\\n' "$s"`,
    `[ "$s" = ${q(known)} ] && exit 0`,
    `set -- $s`,
    `[ "$1" -le ${maxBytes} ] || { echo 'File is too large to open' >&2; exit 1; }`,
    `cat -- ${q(target)}`,
  ].join('\n') + '\n',
  /** Pack `target` as a one-entry tar on stdout. */
  pack: (root: string, target: string) =>
    `${guard(root, [posixDir(target)])}\ntar -C ${q(posixDir(target))} -cf - -- ${q(path.posix.basename(target))}`,
  /** Unpack a one-entry tar (entry `entryName`) from stdin to `destDir/finalName`. */
  unpack: (root: string, destDir: string, entryName: string, finalName: string) => [
    'set -e',
    guard(root, [destDir]),
    `tmp=$(mktemp -d ${q(posixJoin(destDir, '.vibeyard-upload.XXXXXX'))})`,
    `trap 'rm -rf "$tmp"' EXIT`,
    `tar -C "$tmp" -xf -`,
    refuseExisting(posixJoin(destDir, finalName)),
    `mv -- "$tmp"/${q(entryName)} ${q(posixJoin(destDir, finalName))}`,
  ].join('\n'),
  /** Write stdin to a new file (never over an existing one). */
  write: (root: string, target: string) => `${guard(root, [posixDir(target)])}\nset -C\ncat > ${q(target)}`,
};

/** Run one operation script on `host` (sent on stdin); returns its stdout. */
async function runScript(host: string, script: string, opts: { timeoutMs?: number; maxStdoutBytes?: number } = {}): Promise<Buffer> {
  const res = await runSshRaw(host, 'sh -s', { stdin: script, timeoutMs: opts.timeoutMs ?? 60_000, maxStdoutBytes: opts.maxStdoutBytes });
  if (res.code !== 0) throw new Error(sshFailure(res));
  return res.stdout;
}

async function takenNames(host: string, dir: string): Promise<Set<string>> {
  const listing = (await listRemoteDirEntries(host, [dir]))[dir];
  if (!listing) throw new Error(`Cannot list ${dir} on ${host}`);
  return new Set(listing.map((e) => e.name));
}

/** Create `name` (file or folder) in folder `dir`. */
export async function remoteCreate(dir: RemoteTarget, name: string, kind: 'file' | 'dir'): Promise<string> {
  assertEntryName(name);
  const target = posixJoin(dir.path, name);
  await runScript(dir.host, kind === 'dir' ? remoteScripts.mkdir(dir.root, target) : remoteScripts.touch(dir.root, target));
  return target;
}

export async function remoteRename(t: RemoteTarget, newName: string): Promise<string> {
  assertEntryName(newName);
  const dest = posixJoin(posixDir(t.path), newName);
  if (dest !== t.path) await runScript(t.host, remoteScripts.transfer(t.root, [[t.path, dest]], true));
  return dest;
}

export async function remoteDelete(t: RemoteTarget): Promise<void> {
  await runScript(t.host, remoteScripts.remove(t.root, t.path));
}

/** Copy or move host entries into host folder `dest` in one script, numbering taken names. Returns the created paths. */
export async function remoteCopy(dest: RemoteTarget, sources: string[], move: boolean): Promise<string[]> {
  // Moving an entry into the folder it already lives in is a no-op.
  const todo = sources.filter((src) => !(move && posixDir(src) === dest.path));
  const inside = todo.find((src) => isPathUnder(dest.path, src));
  if (inside) throw new Error(`Cannot paste "${basename(inside)}" into itself`);
  if (todo.length === 0) return [];
  const names = assignEntryNames(todo.map((src) => path.posix.basename(src)), await takenNames(dest.host, dest.path));
  const pairs = todo.map((src, i): [string, string] => [src, posixJoin(dest.path, names[i])]);
  await runScript(dest.host, remoteScripts.transfer(dest.root, pairs, move), { timeoutMs: TRANSFER_TIMEOUT_MS });
  return pairs.map(([, to]) => to);
}

/** Parse a "<size> <mtime seconds>" stat line. */
export function parseStatOutput(out: string): { size: number; mtimeMs: number } | null {
  const m = /^(\d+) (\d+)\s*$/.exec(out.trim());
  return m ? { size: Number(m[1]), mtimeMs: Number(m[2]) * 1000 } : null;
}

export async function remoteStat(t: RemoteTarget): Promise<{ size: number; mtimeMs: number }> {
  const stat = parseStatOutput((await runScript(t.host, remoteScripts.stat(t.root, t.path))).toString('utf-8'));
  if (!stat) throw new Error(`Cannot stat ${t.path}`);
  return stat;
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

const resolveTarBinary = () => resolveSystemBinary('tar');

function sshArgs(host: string, script: string): string[] {
  return [...BATCH_OPTS, host, `sh -c ${q(script)}`];
}

/**
 * Pipe `from`'s stdout into `to`'s stdin (two commands), resolving when both
 * exit 0. Either failing (or the timeout) kills both; the error carries the
 * failing side's last stderr line.
 */
function pipeCommands(from: [string, string[]], to: [string, string[]]): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = spawn(from[0], from[1], { windowsHide: true });
    const b = spawn(to[0], to[1], { windowsHide: true });
    const errs = ['', ''];
    a.stderr.on('data', (d) => { if (errs[0].length < 16_384) errs[0] += d.toString(); });
    b.stderr.on('data', (d) => { if (errs[1].length < 16_384) errs[1] += d.toString(); });
    a.stdout.pipe(b.stdin);
    // A consumer that exits early (EPIPE) is reported through its own exit code.
    b.stdin.on('error', () => {});
    let pending = 2;
    let failed = false;
    const timer = setTimeout(() => fail(new Error('transfer timed out')), TRANSFER_TIMEOUT_MS);
    function fail(err: Error): void {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      a.kill();
      b.kill();
      reject(err);
    }
    const onClose = (i: number) => (code: number | null) => {
      if (code !== 0) {
        fail(new Error(sshFailure({ code, stderr: errs[i] })));
        return;
      }
      if (--pending === 0 && !failed) {
        clearTimeout(timer);
        resolve();
      }
    };
    a.on('error', fail);
    b.on('error', fail);
    a.on('close', onClose(0));
    b.on('close', onClose(1));
  });
}

/** Upload local files/folders into host folder `dest`, numbering taken names. Returns the created host paths. */
export async function uploadToRemote(dest: RemoteTarget, localPaths: string[]): Promise<string[]> {
  const names = assignEntryNames(localPaths.map((p) => path.basename(p)), await takenNames(dest.host, dest.path));
  for (const [i, local] of localPaths.entries()) {
    await pipeCommands(
      [resolveTarBinary(), ['-C', path.dirname(local), '-cf', '-', '--', path.basename(local)]],
      [resolveSshBinary(), sshArgs(dest.host, remoteScripts.unpack(dest.root, dest.path, path.basename(local), names[i]))],
    );
  }
  return names.map((name) => posixJoin(dest.path, name));
}

/** Write `bytes` as a new host file in folder `dest` named `name` (numbered when taken). */
export async function writeRemoteFile(dest: RemoteTarget, name: string, bytes: Uint8Array): Promise<string> {
  assertEntryName(name);
  const [free] = assignEntryNames([name], await takenNames(dest.host, dest.path));
  const target = posixJoin(dest.path, free);
  const res = await runSshRaw(dest.host, `sh -c ${q(remoteScripts.write(dest.root, target))}`, { stdin: Buffer.from(bytes), timeoutMs: TRANSFER_TIMEOUT_MS });
  if (res.code !== 0) throw new Error(sshFailure(res));
  return target;
}

/** Download host entries (files or folders) of `from`'s project into local folder `destDir`, numbering taken names. */
export async function downloadFromRemote(from: Omit<RemoteTarget, 'path'>, remotePaths: string[], destDir: string): Promise<string[]> {
  const names = assignEntryNames(remotePaths.map((p) => localSafeName(path.posix.basename(p))), await namesIn(destDir), LOCAL_NAMES_IGNORE_CASE);
  const created: string[] = [];
  for (const [i, remote] of remotePaths.entries()) {
    const tmp = await fs.promises.mkdtemp(path.join(destDir, '.vibeyard-download-'));
    try {
      await pipeCommands(
        [resolveSshBinary(), sshArgs(from.host, remoteScripts.pack(from.root, remote))],
        [resolveTarBinary(), ['-C', tmp, '-xf', '-']],
      );
      created.push(await adoptExtracted(tmp, destDir, names[i]));
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }
  return created;
}

/** A remote name made safe as a Windows file name (reserved chars and device names). */
export function localSafeName(name: string): string {
  if (!isWin) return name;
  const cleaned = name.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Where the read-only local copy of host file `remotePath` lives. */
export function remoteCopyPath(host: string, remotePath: string): string {
  const segments = remotePath.split('/').filter(Boolean).map(localSafeName);
  return path.join(REMOTE_FILES_DIR, localSafeName(host), ...segments);
}

/**
 * The read-only local copy of host file `t`, for the file reader to open. One
 * ssh call: the host sends the file only when its size or mtime differ from
 * the copy's (which is stamped with the host's mtime for this comparison).
 */
export async function fetchRemoteCopy(t: RemoteTarget): Promise<string> {
  const local = remoteCopyPath(t.host, t.path);
  const copy = await fs.promises.stat(local).catch(() => null);
  const known = copy ? `${copy.size} ${Math.floor(copy.mtimeMs / 1000)}` : '';
  const out = await runScript(t.host, remoteScripts.fetch(t.root, t.path, known, MAX_OPEN_COPY_BYTES), {
    timeoutMs: TRANSFER_TIMEOUT_MS,
    maxStdoutBytes: MAX_OPEN_COPY_BYTES + 1024,
  });
  const nl = out.indexOf(0x0a);
  const statLine = out.subarray(0, nl < 0 ? out.length : nl).toString('utf-8');
  const stat = parseStatOutput(statLine);
  if (!stat) throw new Error(`Cannot stat ${t.path}`);
  if (statLine.trim() === known) return local;
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  await fs.promises.writeFile(local, out.subarray(nl + 1));
  const mtime = new Date(stat.mtimeMs);
  await fs.promises.utimes(local, mtime, mtime);
  return local;
}
