// The `board-*` external-control commands: read and edit a project's Kanban
// board (the backlog) from inside a session. Pure over injected deps, like
// ctl-handler.ts; ctl-bridge.ts wires the real board-state mutators.
// Every command acts on one project: `--project` when given, else the caller's.
// (A remote SSH caller is refused `--project` in the main process, so it can
// only ever reach its own session's board.)
import type { BoardColumn, BoardData, BoardTask, ProjectRecord } from '../shared/types.js';
import { findProject, findSession } from './ctl-lookup.js';
import {
  ctlError,
  type CtlBoardColumn,
  type CtlBoardCommand,
  type CtlBoardTask,
  type CtlBoardTaskSummary,
  type CtlResult,
} from '../shared/ctl-protocol.js';

/**
 * board-state.ts mutators, with its argument order (the board last). Each
 * persists and re-renders, so a command makes one call where it can.
 */
export interface CtlBoardOps {
  addTask(partial: Partial<BoardTask>, board: BoardData): BoardTask | undefined;
  updateTask(taskId: string, updates: Partial<BoardTask>, board: BoardData): void;
  moveTask(taskId: string, columnId: string, order: number, board: BoardData): void;
  deleteTask(taskId: string, board: BoardData): void;
  /** Register missing palette tags without notifying; returns the names normalized and deduplicated. */
  ensureTags(names: string[], board: BoardData): string[];
  normalizeTagName(name: string): string;
}

export interface CtlBoardDeps {
  projects(): ProjectRecord[];
  board: CtlBoardOps;
}

/** Shortest task-id prefix accepted in place of the full id. */
export const MIN_TASK_ID_PREFIX = 4;

class BoardError extends Error {
  constructor(readonly result: CtlResult) { super(); }
}

const fail = (...args: Parameters<typeof ctlError>): never => { throw new BoardError(ctlError(...args)); };

/** The board a command acts on, with its project. */
function resolveBoard(deps: CtlBoardDeps, callerId: string, ref: string | undefined): { project: ProjectRecord; board: BoardData } {
  const project = ref === undefined
    ? findSession(deps.projects(), callerId)?.project ?? fail('unknown_project', 'caller tab no longer exists; pass --project')
    : findProject(deps.projects(), ref) ?? fail('unknown_project', `no project '${ref}'`);
  if (project.temporary || !project.board) {
    return fail('unsupported', "this tab's project (Temporary, for sessions outside any project) has no board; pass --project <id|path> of a real project (not possible from an SSH session)");
  }
  return { project, board: project.board };
}

function sortedColumns(board: BoardData): BoardColumn[] {
  return [...board.columns].sort((a, b) => a.order - b.order);
}

/** A column by id, else by title (case-insensitive). */
export function findColumn(board: BoardData, ref: string): BoardColumn {
  const byId = board.columns.find((c) => c.id === ref);
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  const byTitle = board.columns.filter((c) => c.title.trim().toLowerCase() === want);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) return fail('invalid_request', `more than one column is called '${ref}'; pass its id`);
  return fail('invalid_request', `no column '${ref}' (columns: ${sortedColumns(board).map((c) => c.title).join(', ')})`);
}

/** A task by full id, or by a unique id prefix of at least MIN_TASK_ID_PREFIX characters. */
function findTask(board: BoardData, ref: string): BoardTask {
  const exact = board.tasks.find((t) => t.id === ref);
  if (exact) return exact;
  const hits = ref.length < MIN_TASK_ID_PREFIX ? [] : board.tasks.filter((t) => t.id.startsWith(ref));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return fail('invalid_request', `task id '${ref}' is ambiguous; use more characters`);
  return fail('unknown_task', `no task '${ref}' in this project; pass --project for another one`);
}

/** A stored epoch-ms timestamp as ISO, or null when it is missing or invalid (old or hand-edited state). */
function iso(ms: number | undefined): string | null {
  const d = new Date(typeof ms === 'number' ? ms : NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toSummary(project: ProjectRecord, board: BoardData, task: BoardTask): CtlBoardTaskSummary {
  return {
    id: task.id,
    projectId: project.id,
    title: task.title,
    columnId: task.columnId,
    column: board.columns.find((c) => c.id === task.columnId)?.title ?? '',
    order: task.order,
    tags: task.tags ?? [],
    priority: task.priority ?? null,
    sessionId: task.sessionId ?? null,
    createdAt: iso(task.createdAt),
    updatedAt: iso(task.updatedAt),
  };
}

export function toCtlTask(project: ProjectRecord, board: BoardData, task: BoardTask): CtlBoardTask {
  return { ...toSummary(project, board, task), prompt: task.prompt, notes: task.notes ?? null };
}

function toCtlColumn(c: BoardColumn): CtlBoardColumn {
  return { id: c.id, title: c.title, behavior: c.behavior };
}

function run(deps: CtlBoardDeps, callerId: string, command: CtlBoardCommand): CtlResult {
  const ops = deps.board;
  const { project, board } = resolveBoard(deps, callerId, command.project);
  const ok = (result: unknown): CtlResult => ({ ok: true, result });
  switch (command.action) {
    case 'board-list': {
      const columns = sortedColumns(board);
      const columnId = command.column !== undefined ? findColumn(board, command.column).id : undefined;
      const tag = command.tag !== undefined ? ops.normalizeTagName(command.tag) : undefined;
      const rank = new Map(columns.map((c, i) => [c.id, i]));
      const tasks = board.tasks
        .filter((t) => (columnId === undefined || t.columnId === columnId)
          && (tag === undefined || (t.tags ?? []).includes(tag))
          && (command.priority === undefined || t.priority === command.priority))
        .sort((a, b) => (rank.get(a.columnId) ?? 0) - (rank.get(b.columnId) ?? 0) || a.order - b.order)
        .map((t) => toSummary(project, board, t));
      return ok({ projectId: project.id, project: project.name, columns: columns.map(toCtlColumn), tasks });
    }
    case 'board-show':
      return ok(toCtlTask(project, board, findTask(board, command.taskId)));
    case 'board-add': {
      const columnId = command.column !== undefined ? findColumn(board, command.column).id : undefined;
      const task = ops.addTask({
        title: command.title,
        prompt: command.prompt ?? '',
        ...(command.notes ? { notes: command.notes } : {}),
        ...(command.priority ? { priority: command.priority } : {}),
        ...(columnId ? { columnId } : {}),
        tags: command.tags ? ops.ensureTags(command.tags, board) : [],
      }, board);
      return task ? ok(toCtlTask(project, board, task)) : ctlError('unsupported', 'this project board has no columns');
    }
    case 'board-update': {
      const task = findTask(board, command.taskId);
      const updates: Partial<BoardTask> = {};
      if (command.title !== undefined) updates.title = command.title;
      if (command.prompt !== undefined) updates.prompt = command.prompt;
      // An empty string clears the field, like emptying it in the task dialog.
      if (command.notes !== undefined) updates.notes = command.notes === '' ? undefined : command.notes;
      if (command.priority !== undefined) updates.priority = command.priority === 'none' ? undefined : command.priority;
      if (command.addTags || command.removeTags) {
        const add = command.addTags ? ops.ensureTags(command.addTags, board) : [];
        const remove = new Set((command.removeTags ?? []).map(ops.normalizeTagName));
        updates.tags = [...new Set([...(task.tags ?? []), ...add])].filter((t) => !remove.has(t));
      }
      if (Object.keys(updates).length > 0) ops.updateTask(task.id, updates, board);
      return ok(toCtlTask(project, board, task));
    }
    case 'board-move': {
      const task = findTask(board, command.taskId);
      const column = findColumn(board, command.column);
      // Default: the end of the column. Orders are dense indices, so clamp to them.
      const last = board.tasks.filter((t) => t.columnId === column.id && t.id !== task.id).length;
      ops.moveTask(task.id, column.id, Math.min(command.position ?? last, last), board);
      return ok(toCtlTask(project, board, task));
    }
    case 'board-delete': {
      const task = findTask(board, command.taskId);
      ops.deleteTask(task.id, board);
      return ok({ deleted: task.id, projectId: project.id });
    }
  }
}

export function handleBoardCommand(deps: CtlBoardDeps, callerId: string, command: CtlBoardCommand): CtlResult {
  try {
    return run(deps, callerId, command);
  } catch (e) {
    if (e instanceof BoardError) return e.result;
    throw e;
  }
}
