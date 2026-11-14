// Wire format for external control (vibeyard-ctl). Requests are untrusted
// input from a local process, so every field is type- and size-checked and
// unknown fields are dropped. new-session deliberately has no args/env: a
// worker always runs with its project's saved defaults, so an agent cannot add
// CLI flags (e.g. --dangerously-skip-permissions) or env (NODE_OPTIONS, PATH).

import { TASK_PRIORITIES, isTaskPriority, type TaskPriority } from './types';

export const CTL_PROTOCOL_VERSION = 1;
/**
 * Room for the largest valid request: board-add/update carry a prompt and notes
 * of CTL_MAX_PROMPT_CHARS each, up to 3 UTF-8 bytes per char plus JSON escaping.
 */
export const CTL_MAX_REQUEST_BYTES = 512 * 1024;
export const CTL_MAX_PROMPT_CHARS = 64 * 1024;
export const CTL_MAX_NAME_CHARS = 200;
export const CTL_REQ_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
/** Name of one Vibeyard instance's folder under ~/.vibeyard/commands: `<pid>-<8 hex>`. */
export const CTL_INSTANCE_RE = /^(\d+)-[0-9a-f]{8}$/;
export const CTL_MAX_TITLE_CHARS = 500;
export const CTL_MAX_TAGS = 32;
export const CTL_MAX_TAG_CHARS = 64;

export type CtlErrorCode =
  | 'disabled' | 'unauthorized' | 'not_owner' | 'unknown_session'
  | 'unknown_project' | 'unknown_task' | 'invalid_request' | 'unsupported' | 'timeout';

export type CtlCommand =
  | { action: 'new-session'; name: string; project?: string; prompt?: string; provider?: string; profile?: string; focus?: boolean }
  | { action: 'rename'; sessionId: string; name: string }
  | { action: 'close'; sessionId: string }
  | { action: 'list'; project?: string; mine?: boolean }
  | { action: 'board-list'; project?: string; column?: string; tag?: string; priority?: TaskPriority }
  | { action: 'board-show'; taskId: string; project?: string }
  | { action: 'board-add'; title: string; project?: string; prompt?: string; notes?: string; column?: string; tags?: string[]; priority?: TaskPriority }
  | {
    action: 'board-update'; taskId: string; project?: string;
    title?: string; prompt?: string; notes?: string;
    /** 'none' clears the priority. */
    priority?: TaskPriority | 'none';
    addTags?: string[]; removeTags?: string[];
  }
  | { action: 'board-move'; taskId: string; column: string; project?: string; position?: number }
  | { action: 'board-delete'; taskId: string; project?: string };

export type CtlBoardCommand = Extract<CtlCommand, { action: `board-${string}` }>;

/**
 * Where a request came from (main process only; the renderer never sees it). A
 * `remote` request was written by a session on an SSH host (relayed by the
 * status mirror); the host is a trust boundary, so it may only use the board
 * commands, and only on the calling session's own project (no --project).
 */
export type CtlScope = 'local' | 'remote';

export function isBoardCommand(command: CtlCommand): command is CtlBoardCommand {
  return command.action.startsWith('board-');
}

/** Why `command` may not run in `scope`, or null when it may. */
export function scopeViolation(command: CtlCommand, scope: CtlScope): string | null {
  if (scope === 'local') return null;
  if (!isBoardCommand(command)) return `'${command.action}' is not available from a remote (SSH) session; only the board commands are`;
  if (command.project !== undefined) return "--project is not available from a remote (SSH) session: it always uses the session's own project";
  return null;
}

export type CtlResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: CtlErrorCode; message: string } };

export type CtlSessionStatus = 'not_started' | 'idle' | 'working' | 'input' | 'exited';

export interface CtlBoardTask {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  notes: string | null;
  columnId: string;
  column: string;
  order: number;
  tags: string[];
  priority: TaskPriority | null;
  sessionId: string | null;
  /** Null when the stored timestamp is missing or invalid. */
  createdAt: string | null;
  updatedAt: string | null;
}

/** A `board list` row: the task without its prompt and notes, which `board show` returns. */
export type CtlBoardTaskSummary = Omit<CtlBoardTask, 'prompt' | 'notes'>;

export interface CtlBoardColumn {
  id: string;
  title: string;
  behavior: string;
}

export interface CtlListEntry {
  projectId: string;
  sessionId: string;
  name: string;
  cliSessionId: string | null;
  providerId: string;
  status: CtlSessionStatus;
  createdBy: string | null;
  createdAt: string;
  cost: { totalCostUsd: number } | null;
  userRenamed: boolean;
}

export function ctlError(code: CtlErrorCode, message: string): CtlResult {
  return { ok: false, error: { code, message } };
}

type Parsed = { ok: true; token: string; command: CtlCommand } | { ok: false; error: { code: CtlErrorCode; message: string } };

class Invalid extends Error {}

function str(o: Record<string, unknown>, key: string, opts: { required?: boolean; max: number; nonBlank?: boolean }): string | undefined {
  const v = o[key];
  if (v === undefined) {
    if (opts.required) throw new Invalid(`'${key}' is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new Invalid(`'${key}' must be a string`);
  if (v.length > opts.max) throw new Invalid(`'${key}' is longer than ${opts.max} characters`);
  if (opts.nonBlank && v.trim() === '') throw new Invalid(`'${key}' must not be empty`);
  return v;
}

function bool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Invalid(`'${key}' must be true or false`);
  return v;
}

function int(o: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Invalid(`'${key}' must be a whole number from ${min} to ${max}`);
  return v;
}

function priority(o: Record<string, unknown>, key: string): TaskPriority | undefined;
function priority(o: Record<string, unknown>, key: string, allowNone: true): TaskPriority | 'none' | undefined;
function priority(o: Record<string, unknown>, key: string, allowNone = false): TaskPriority | 'none' | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (allowNone && v === 'none') return 'none';
  if (!isTaskPriority(v)) throw new Invalid(`'${key}' must be one of ${TASK_PRIORITIES.join(', ')}${allowNone ? ', none' : ''}`);
  return v;
}

function tagList(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Invalid(`'${key}' must be a list of strings`);
  if (v.length > CTL_MAX_TAGS) throw new Invalid(`'${key}' has more than ${CTL_MAX_TAGS} tags`);
  return v.map((t) => {
    if (typeof t !== 'string' || t.trim() === '') throw new Invalid(`'${key}' must hold non-empty strings`);
    if (t.length > CTL_MAX_TAG_CHARS) throw new Invalid(`a tag in '${key}' is longer than ${CTL_MAX_TAG_CHARS} characters`);
    return t;
  });
}

const taskIdOf = (c: Record<string, unknown>) => str(c, 'taskId', { required: true, max: 128, nonBlank: true })!;
const projectOf = (c: Record<string, unknown>) => str(c, 'project', { max: 4096 });
const columnOf = (c: Record<string, unknown>, required = false) => str(c, 'column', { required, max: CTL_MAX_NAME_CHARS, nonBlank: true });

function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function parseCommand(c: Record<string, unknown>): CtlCommand {
  switch (c.action) {
    case 'new-session':
      // Rejected rather than dropped, so a caller never believes its flags or env were applied.
      for (const key of ['args', 'env']) {
        if (c[key] !== undefined) throw new Invalid(`'${key}' is not supported: new sessions use the project's saved default args and env`);
      }
      return defined({
        action: 'new-session' as const,
        name: str(c, 'name', { required: true, max: CTL_MAX_NAME_CHARS, nonBlank: true })!,
        project: str(c, 'project', { max: 4096 }),
        prompt: str(c, 'prompt', { max: CTL_MAX_PROMPT_CHARS }),
        provider: str(c, 'provider', { max: 64 }),
        profile: str(c, 'profile', { max: 256 }),
        focus: bool(c, 'focus'),
      });
    case 'rename':
      return {
        action: 'rename',
        sessionId: str(c, 'sessionId', { required: true, max: 128, nonBlank: true })!,
        name: str(c, 'name', { required: true, max: CTL_MAX_NAME_CHARS, nonBlank: true })!,
      };
    case 'close':
      return { action: 'close', sessionId: str(c, 'sessionId', { required: true, max: 128, nonBlank: true })! };
    case 'list':
      return defined({ action: 'list' as const, project: projectOf(c), mine: bool(c, 'mine') });
    case 'board-list':
      return defined({
        action: 'board-list' as const,
        project: projectOf(c),
        column: columnOf(c),
        tag: str(c, 'tag', { max: CTL_MAX_TAG_CHARS, nonBlank: true }),
        priority: priority(c, 'priority'),
      });
    case 'board-show':
      return defined({ action: 'board-show' as const, taskId: taskIdOf(c), project: projectOf(c) });
    case 'board-add':
      return defined({
        action: 'board-add' as const,
        title: str(c, 'title', { required: true, max: CTL_MAX_TITLE_CHARS, nonBlank: true })!,
        project: projectOf(c),
        prompt: str(c, 'prompt', { max: CTL_MAX_PROMPT_CHARS }),
        notes: str(c, 'notes', { max: CTL_MAX_PROMPT_CHARS }),
        column: columnOf(c),
        tags: tagList(c, 'tags'),
        priority: priority(c, 'priority'),
      });
    case 'board-update': {
      const cmd = defined({
        action: 'board-update' as const,
        taskId: taskIdOf(c),
        project: projectOf(c),
        title: str(c, 'title', { max: CTL_MAX_TITLE_CHARS, nonBlank: true }),
        prompt: str(c, 'prompt', { max: CTL_MAX_PROMPT_CHARS }),
        notes: str(c, 'notes', { max: CTL_MAX_PROMPT_CHARS }),
        priority: priority(c, 'priority', true),
        addTags: tagList(c, 'addTags'),
        removeTags: tagList(c, 'removeTags'),
      });
      if (Object.keys(cmd).every((k) => k === 'action' || k === 'taskId' || k === 'project')) throw new Invalid('nothing to update');
      return cmd;
    }
    case 'board-move':
      return defined({
        action: 'board-move' as const,
        taskId: taskIdOf(c),
        column: columnOf(c, true)!,
        project: projectOf(c),
        position: int(c, 'position', 0, 100_000),
      });
    case 'board-delete':
      return defined({ action: 'board-delete' as const, taskId: taskIdOf(c), project: projectOf(c) });
    default:
      throw new Invalid(`unknown action '${String(c.action)}'`);
  }
}

export function parseCtlRequest(raw: string): Parsed {
  try {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Invalid('request is not valid JSON'); }
    if (!data || typeof data !== 'object') throw new Invalid('request must be a JSON object');
    const o = data as Record<string, unknown>;
    if (o.v !== CTL_PROTOCOL_VERSION) throw new Invalid(`unsupported protocol version '${String(o.v)}'`);
    if (typeof o.token !== 'string' || o.token === '') throw new Invalid('missing token');
    if (!o.command || typeof o.command !== 'object') throw new Invalid('missing command');
    return { ok: true, token: o.token, command: parseCommand(o.command as Record<string, unknown>) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: { code: 'invalid_request', message: e.message } };
    throw e;
  }
}
