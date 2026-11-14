// src/main/ctl-server.ts
// External-control command server. Same transport shape as hook-status.ts:
// a private directory watched with fs.watch plus a polling fallback. Requests
// arrive as <reqId>.json (written to .tmp then renamed by the client), are
// validated here, and are relayed to the renderer, which owns live state.
// Each running Vibeyard owns its own `<pid>-<hex>` folder under a shared root,
// so two instances never read, clear or answer each other's requests.
// `submit` is the second way in: requests a remote (SSH) session wrote on its
// host, relayed by the status mirror (remote-ssh.ts) and answered through it.
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { isWin } from './platform';
import { parseCtlRequest, ctlError, scopeViolation, CTL_MAX_REQUEST_BYTES, CTL_REQ_ID_RE, CTL_INSTANCE_RE, type CtlCommand, type CtlResult, type CtlScope } from '../shared/ctl-protocol';

// Below the client's 10 s default wait, so a held request can never execute after
// its client has already reported `timeout` (and possibly been retried).
const HOLD_MS = 8_000;
// A relayed request has already spent the host's poll interval plus ssh latency
// before it gets here, so it may be held for less.
const REMOTE_HOLD_MS = 5_000;
const RESULT_TTL_MS = 60_000;
const ENABLED_MARKER = '.enabled';

export interface CtlServerDeps {
  /** Shared parent folder (~/.vibeyard/commands). */
  commandsRoot: string;
  /** This instance's folder, a direct child of commandsRoot. Its start-error file is `<commandsDir>.error`. */
  commandsDir: string;
  resolveToken(token: string): string | undefined;
  dispatch(reqId: string, callerId: string, command: CtlCommand): void;
  now?: () => number;
  pollMs?: number;
  /** Whether the Vibeyard that owns a sibling folder is still running. */
  isAlive?: (pid: number) => boolean;
}

/** Signal 0 probes without signalling: ESRCH = gone, EPERM = exists but not ours. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface CtlServer {
  start(): { ok: true } | { ok: false; reason: string };
  stop(): void;
  isRunning(): boolean;
  onRendererReady(): void;
  /** The page is going away (or may be): hold new requests; in-flight ones stay answerable. */
  onRendererGone(): void;
  /** The page that was handling in-flight requests is gone for good: answer them all with `timeout`. */
  failPending(): void;
  reply(reqId: string, result: CtlResult): void;
  /**
   * A request a remote (SSH) session wrote on its host, relayed by the mirror.
   * `expectedCaller` is the session the transport vouches for: the token must
   * belong to that session, so a host can never act as a session it does not
   * run, and only what `scopeViolation` allows a remote caller runs.
   * `respond` is called exactly once.
   */
  submit(raw: string, expectedCaller: string, respond: (result: CtlResult) => void): void;
  scan(): void;
  sweep(): void;
}

export function createCtlServer(deps: CtlServerDeps): CtlServer {
  const now = deps.now ?? Date.now;
  const root = deps.commandsRoot;
  const dir = deps.commandsDir;
  const ownId = path.basename(dir);
  const startErrorPath = `${dir}.error`;
  const isAlive = deps.isAlive ?? isPidAlive;
  let running = false;
  let rendererReady = false;
  let watcher: fs.FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const seen = new Set<string>();      // reqIds already taken (watch + poll race)
  type Respond = (result: CtlResult) => void;
  const pending = new Map<string, Respond>();   // dispatched, awaiting reply
  const held: Array<{ reqId: string; callerId: string; command: CtlCommand; respond: Respond; expiresAt: number }> = [];
  /** Answer held requests that waited too long; the renderer may never come back to release them. */
  function expireHeld(): void {
    for (let i = held.length - 1; i >= 0; i--) {
      if (now() <= held[i].expiresAt) continue;
      const [h] = held.splice(i, 1);
      h.respond(ctlError('timeout', 'Vibeyard was not ready in time'));
    }
  }

  /**
   * Validate one request and dispatch it, or hold it until the renderer is
   * ready. Shared by both transports; `expectedCaller` is set when the
   * transport itself vouches for the calling session (the remote relay).
   */
  function ingest(reqId: string, raw: string, scope: CtlScope, respond: Respond, expectedCaller?: string): void {
    const parsed = parseCtlRequest(raw);
    if (!parsed.ok) { respond({ ok: false, error: parsed.error }); return; }
    const callerId = deps.resolveToken(parsed.token);
    if (!callerId || (expectedCaller !== undefined && callerId !== expectedCaller)) {
      respond(ctlError('unauthorized', 'caller is not a running Vibeyard tab'));
      return;
    }
    const violation = scopeViolation(parsed.command, scope);
    if (violation) { respond(ctlError('unsupported', violation)); return; }
    if (!rendererReady) {
      held.push({ reqId, callerId, command: parsed.command, respond, expiresAt: now() + (scope === 'remote' ? REMOTE_HOLD_MS : HOLD_MS) });
      return;
    }
    pending.set(reqId, respond);
    deps.dispatch(reqId, callerId, parsed.command);
  }

  /** Safety problems with a folder as it exists now, without creating anything. */
  function inspectDir(p: string, opts: { modeAndOwner: boolean }): string | null {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) return `${p} is not a real directory`;
    if (!isWin && opts.modeAndOwner) {
      if ((st.mode & 0o077) !== 0) return `${p} must not be accessible by group/others (mode ${(st.mode & 0o777).toString(8)})`;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `${p} is not owned by the current user`;
    }
    return null;
  }

  /** Root first: the instance folder is only created once its parent is known to be ours. */
  function checkDir(): string | null {
    for (const p of [root, dir]) {
      try {
        fs.mkdirSync(p, { recursive: true, mode: 0o700 });
        const problem = inspectDir(p, { modeAndOwner: true });
        if (problem) return problem;
      } catch (e) {
        return `cannot prepare ${p}: ${(e as Error).message}`;
      }
    }
    return null;
  }

  /**
   * stop() runs on every launch with the preference off, so it must never clean
   * through a root it has not validated (a symlink into a user folder, say).
   * A root the server was running in only needs to still be a real directory.
   */
  function rootSafeToClean(strict: boolean): boolean {
    try {
      return inspectDir(root, { modeAndOwner: strict }) === null;
    } catch {
      return false; // missing or unreadable: nothing of ours to clean
    }
  }

  /** Remove `p` only if it is a real file/folder of the expected kind, never through a symlink. */
  function removeEntry(p: string, kind: 'dir' | 'file'): void {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile())) return;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* gone or unreadable */ }
  }

  /** Folders and .error files left behind by Vibeyard instances that are no longer running. */
  function cleanupStaleInstances(): void {
    let names: string[];
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      const isError = name.endsWith('.error');
      const id = isError ? name.slice(0, -'.error'.length) : name;
      const m = CTL_INSTANCE_RE.exec(id);
      if (!m || id === ownId) continue;
      const pid = Number(m[1]);
      // pid 0 / huge values would make kill(pid, 0) probe a process group or throw.
      if (!Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid)) continue;
      removeEntry(path.join(root, name), isError ? 'file' : 'dir');
    }
  }

  function writeStartError(reason: string): void {
    // Only into a real root: never leave files in whatever folder a symlinked root points at.
    try {
      const st = fs.lstatSync(root);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
    } catch { return; }
    const tmp = `${startErrorPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { fs.writeFileSync(fd, reason); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, startErrorPath);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      console.warn(`[ctl] failed to record start error: ${(e as Error).message}`);
    }
  }

  function clearRequestFiles(): void {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json') || f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch { /* dir may be gone */ }
  }

  function writeResult(reqId: string, result: CtlResult): void {
    const final = path.join(dir, `${reqId}.result.json`);
    // Server-chosen unique temp name + exclusive create: a planted symlink or file at a
    // predictable name can neither redirect the write nor suppress the 0600 mode.
    const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(result)); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, final);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      console.warn(`[ctl] failed to write result for ${reqId}: ${(e as Error).message}`);
    }
  }

  function take(file: string): void {
    const reqId = file.slice(0, -'.json'.length);
    if (!CTL_REQ_ID_RE.test(reqId) || seen.has(reqId)) return;
    const full = path.join(dir, file);
    let raw: string;
    let fd: number | null = null;
    try {
      // O_NOFOLLOW: a symlinked request is refused (ELOOP). O_NONBLOCK: a FIFO cannot hang the scan.
      fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return;
      seen.add(reqId);
      const oversize = (): void => {
        fs.rmSync(full, { force: true });
        writeResult(reqId, ctlError('invalid_request', `request larger than ${CTL_MAX_REQUEST_BYTES} bytes`));
      };
      if (st.size > CTL_MAX_REQUEST_BYTES) { oversize(); return; }
      const buf = Buffer.alloc(CTL_MAX_REQUEST_BYTES + 1);
      let n = 0;
      for (;;) {
        const r = fs.readSync(fd, buf, n, buf.length - n, null);
        if (r === 0) break;
        n += r;
        if (n > CTL_MAX_REQUEST_BYTES) { oversize(); return; }
      }
      raw = buf.toString('utf-8', 0, n);
      fs.rmSync(full, { force: true });
    } catch {
      return; // vanished, symlink, or unreadable
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    ingest(reqId, raw, 'local', (r) => writeResult(reqId, r));
  }

  const server: CtlServer = {
    start() {
      if (running) return { ok: true };
      const problem = checkDir();
      if (problem) {
        console.warn(`[ctl] external control disabled: ${problem}`);
        writeStartError(problem);
        return { ok: false, reason: problem };
      }
      removeEntry(startErrorPath, 'file');
      cleanupStaleInstances();
      clearRequestFiles();
      fs.writeFileSync(path.join(dir, ENABLED_MARKER), String(process.pid), { mode: 0o600 });
      running = true;
      try {
        watcher = fs.watch(dir, (_e, name) => { if (name && name.endsWith('.json') && !name.endsWith('.result.json')) server.scan(); });
      } catch { watcher = null; }
      // An unhandled 'error' event would be an uncaught exception in the main process; the poll keeps running.
      watcher?.on('error', () => { watcher?.close(); watcher = null; });
      poll = setInterval(() => { server.scan(); server.sweep(); }, deps.pollMs ?? 2000);
      return { ok: true };
    },
    stop() {
      const wasRunning = running;
      running = false;
      watcher?.close(); watcher = null;
      if (poll) clearInterval(poll); poll = null;
      // Answer what is still waiting, so a relayed (remote) caller is not left counting it in flight.
      const waiting = [...held.map((h) => h.respond), ...pending.values()];
      held.length = 0; pending.clear();
      if (wasRunning) for (const respond of waiting) respond(ctlError('disabled', 'external control was turned off'));
      if (!rootSafeToClean(!wasRunning)) return;
      removeEntry(startErrorPath, 'file');
      removeEntry(dir, 'dir'); // .enabled and any request/result files go with it
      cleanupStaleInstances();
    },
    isRunning: () => running,
    onRendererReady() {
      rendererReady = true;
      if (!running) { held.length = 0; return; }
      expireHeld();
      const queued = held.splice(0);
      for (const h of queued) {
        pending.set(h.reqId, h.respond);
        deps.dispatch(h.reqId, h.callerId, h.command);
      }
    },
    onRendererGone() { rendererReady = false; },
    failPending() {
      const responders = [...pending.values()];
      pending.clear();
      if (!running) return;
      for (const respond of responders) respond(ctlError('timeout', 'Vibeyard reloaded while handling the request; run list before retrying'));
    },
    reply(reqId, result) {
      const respond = pending.get(reqId);
      if (!running || !respond) return;
      pending.delete(reqId);
      respond(result);
    },
    submit(raw, expectedCaller, respond) {
      if (!running) { respond(ctlError('disabled', 'external control is disabled in Vibeyard preferences')); return; }
      if (Buffer.byteLength(raw, 'utf-8') > CTL_MAX_REQUEST_BYTES) { respond(ctlError('invalid_request', `request larger than ${CTL_MAX_REQUEST_BYTES} bytes`)); return; }
      // Server-chosen id: the transport's own id names a file on the host and must not collide with a local request.
      ingest(`x-${randomBytes(12).toString('hex')}`, raw, 'remote', respond, expectedCaller);
    },
    scan() {
      if (!running) return;
      let files: string[];
      try { files = fs.readdirSync(dir); } catch { return; }
      for (const f of files) {
        if (f.endsWith('.json') && !f.endsWith('.result.json')) take(f);
      }
    },
    sweep() {
      if (!running) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.result.json') && !f.endsWith('.tmp')) continue;
          const full = path.join(dir, f);
          if (now() - fs.statSync(full).mtimeMs > RESULT_TTL_MS) fs.rmSync(full, { force: true });
        }
      } catch { /* best effort */ }
      if (seen.size > 10_000) seen.clear();
      expireHeld();
    },
  };
  return server;
}
