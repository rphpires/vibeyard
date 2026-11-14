import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifyBoardChanged } = vi.hoisted(() => ({ notifyBoardChanged: vi.fn() }));
vi.mock('./state.js', () => ({ appState: { notifyBoardChanged, activeProject: undefined } }));

let uuid = 0;
vi.stubGlobal('crypto', { randomUUID: () => `new-${++uuid}` });

import { addTask, updateTask, moveTask, deleteTask, ensureTags, normalizeTagName } from './board-state';
import { handleCtlCommand, type CtlHandlerDeps } from './ctl-handler';
import type { BoardData, BoardTask, ProjectRecord, SessionRecord } from '../shared/types';
import type { CtlBoardTask, CtlBoardTaskSummary, CtlCommand, CtlResult } from '../shared/ctl-protocol';

function task(id: string, columnId: string, order: number, extra: Partial<BoardTask> = {}): BoardTask {
  return { id, title: id, prompt: `do ${id}`, columnId, order, createdAt: 0, updatedAt: 0, ...extra };
}

function board(tasks: BoardTask[]): BoardData {
  return {
    columns: [
      { id: 'c-in', title: 'Backlog', order: 0, behavior: 'inbox' },
      { id: 'c-run', title: 'Running', order: 1, behavior: 'active' },
      { id: 'c-done', title: 'Done', order: 2, behavior: 'terminal' },
    ],
    tasks,
    tags: [],
  };
}

const session = (id: string) => ({ id, name: id, cliSessionId: null, createdAt: '' }) as SessionRecord;

let projects: ProjectRecord[];
let deps: CtlHandlerDeps;

beforeEach(() => {
  uuid = 0;
  notifyBoardChanged.mockClear();
  projects = [
    {
      id: 'p1', name: 'One', path: '/repo/one', sessions: [session('me')],
      board: board([task('aaaa1111', 'c-in', 0, { tags: ['bug'], priority: 'high' }), task('aaaa2222', 'c-in', 1), task('bbbb1111', 'c-done', 0)]),
    } as unknown as ProjectRecord,
    {
      id: 'p2', name: 'Two', path: '/repo/two', sessions: [session('other')],
      board: board([task('cccc1111', 'c-in', 0)]),
    } as unknown as ProjectRecord,
    { id: 'tmp', name: 'Temporary', path: '', temporary: true, sessions: [session('adhoc')], board: board([]) } as unknown as ProjectRecord,
  ];
  deps = {
    projects: () => projects,
    board: { addTask, updateTask, moveTask, deleteTask, ensureTags, normalizeTagName },
  } as unknown as CtlHandlerDeps;
});

const run = (command: CtlCommand, caller = 'me'): CtlResult => handleCtlCommand(deps, caller, command);
const okResult = <T>(r: CtlResult): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
};
const errCode = (r: CtlResult) => (r.ok ? null : r.error.code);
const tasksOf = (projectId: string) => projects.find((p) => p.id === projectId)!.board!.tasks;

describe('board-list', () => {
  it("lists the caller's project in column order, then task order", () => {
    const r = okResult<{ projectId: string; columns: unknown[]; tasks: CtlBoardTaskSummary[] }>(run({ action: 'board-list' }));
    expect(r.projectId).toBe('p1');
    expect(r.columns).toEqual([
      { id: 'c-in', title: 'Backlog', behavior: 'inbox' },
      { id: 'c-run', title: 'Running', behavior: 'active' },
      { id: 'c-done', title: 'Done', behavior: 'terminal' },
    ]);
    expect(r.tasks.map((t) => t.id)).toEqual(['aaaa1111', 'aaaa2222', 'bbbb1111']);
    expect(r.tasks[0]).toMatchObject({ column: 'Backlog', tags: ['bug'], priority: 'high', sessionId: null, createdAt: '1970-01-01T00:00:00.000Z' });
    // Rows leave out the prompt and notes; `board show` returns them.
    expect(r.tasks[0]).not.toHaveProperty('prompt');
    expect(r.tasks[0]).not.toHaveProperty('notes');
  });

  it('filters by column title (any case), tag and priority', () => {
    const ids = (c: CtlCommand) => okResult<{ tasks: CtlBoardTaskSummary[] }>(run(c)).tasks.map((t) => t.id);
    expect(ids({ action: 'board-list', column: 'done' })).toEqual(['bbbb1111']);
    expect(ids({ action: 'board-list', tag: 'BUG' })).toEqual(['aaaa1111']);
    expect(ids({ action: 'board-list', priority: 'high' })).toEqual(['aaaa1111']);
  });

  it('names the columns when one is unknown', () => {
    const r = run({ action: 'board-list', column: 'Nope' });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_request', message: "no column 'Nope' (columns: Backlog, Running, Done)" } });
  });

  it('uses --project by id or path, and refuses the Temporary project', () => {
    expect(okResult<{ projectId: string }>(run({ action: 'board-list', project: '/repo/two/' })).projectId).toBe('p2');
    expect(errCode(run({ action: 'board-list', project: 'nope' }))).toBe('unknown_project');
    expect(errCode(run({ action: 'board-list' }, 'adhoc'))).toBe('unsupported');
  });
});

describe('board-add', () => {
  it('adds to the inbox by default, registering its tags', () => {
    const t = okResult<CtlBoardTask>(run({ action: 'board-add', title: 'New', prompt: 'p', notes: 'n', tags: ['Feat'], priority: 'low' }));
    expect(t).toMatchObject({ id: 'new-1', projectId: 'p1', title: 'New', prompt: 'p', notes: 'n', column: 'Backlog', order: 2, tags: ['feat'], priority: 'low' });
    expect(projects[0].board!.tags).toEqual([{ name: 'feat', color: expect.any(String) }]);
    expect(notifyBoardChanged).toHaveBeenCalled();
  });

  it('adds into a named column of another project', () => {
    const t = okResult<CtlBoardTask>(run({ action: 'board-add', title: 'X', column: 'Running', project: 'p2' }));
    expect(t).toMatchObject({ projectId: 'p2', columnId: 'c-run', prompt: '' });
    expect(tasksOf('p2')).toHaveLength(2);
  });
});

describe('board-update / move / delete / show', () => {
  it("finds a task by unique prefix in the caller's project, or in --project", () => {
    expect(okResult<CtlBoardTask>(run({ action: 'board-show', taskId: 'bbbb' }))).toMatchObject({ id: 'bbbb1111', prompt: 'do bbbb1111', notes: null });
    expect(run({ action: 'board-show', taskId: 'aaaa' })).toEqual({ ok: false, error: { code: 'invalid_request', message: "task id 'aaaa' is ambiguous; use more characters" } });
    expect(errCode(run({ action: 'board-show', taskId: 'aaa' }))).toBe('unknown_task');
    // Another project's task, even by full id, needs --project.
    expect(errCode(run({ action: 'board-delete', taskId: 'cccc1111' }))).toBe('unknown_task');
    expect(tasksOf('p2')).toHaveLength(1);
    expect(okResult<CtlBoardTask>(run({ action: 'board-show', taskId: 'cccc', project: 'p2' })).projectId).toBe('p2');
  });

  it('updates fields, clears notes and priority, and edits tags', () => {
    run({ action: 'board-update', taskId: 'aaaa1111', notes: 'x' });
    const t = okResult<CtlBoardTask>(run({ action: 'board-update', taskId: 'aaaa1111', title: 'Renamed', notes: '', priority: 'none', addTags: ['ui'], removeTags: ['bug'] }));
    expect(t).toMatchObject({ title: 'Renamed', notes: null, priority: null, tags: ['ui'] });
  });

  it('moves to the end of a column by default and clamps the position', () => {
    expect(okResult<CtlBoardTask>(run({ action: 'board-move', taskId: 'aaaa1111', column: 'Done' }))).toMatchObject({ column: 'Done', order: 1 });
    expect(tasksOf('p1').find((t) => t.id === 'aaaa2222')!.order).toBe(0);
    expect(okResult<CtlBoardTask>(run({ action: 'board-move', taskId: 'aaaa2222', column: 'c-done', position: 99 }))).toMatchObject({ order: 2 });
    expect(okResult<CtlBoardTask>(run({ action: 'board-move', taskId: 'aaaa2222', column: 'Done', position: 0 }))).toMatchObject({ order: 0 });
    expect(tasksOf('p1').filter((t) => t.columnId === 'c-done').sort((a, b) => a.order - b.order).map((t) => t.id)).toEqual(['aaaa2222', 'bbbb1111', 'aaaa1111']);
  });

  it('deletes a task', () => {
    expect(okResult(run({ action: 'board-delete', taskId: 'bbbb1111' }))).toEqual({ deleted: 'bbbb1111', projectId: 'p1' });
    expect(tasksOf('p1').map((t) => t.id)).toEqual(['aaaa1111', 'aaaa2222']);
  });
});

describe('board writes', () => {
  it('persists once for an add, new palette tags included', () => {
    run({ action: 'board-add', title: 'A', tags: ['x', 'X ', 'y'] });
    expect(notifyBoardChanged).toHaveBeenCalledTimes(1);
    expect(tasksOf('p1').at(-1)!.tags).toEqual(['x', 'y']);
    expect(projects[0].board!.tags!.map((t) => t.name)).toEqual(['x', 'y']);
  });

  it('applies an update with tag changes in a single board write', () => {
    const t = okResult<CtlBoardTask>(run({ action: 'board-update', taskId: 'aaaa1111', title: 'T', addTags: ['bug', 'new'], removeTags: ['BUG'] }));
    expect(t.tags).toEqual(['new']);
    expect(notifyBoardChanged).toHaveBeenCalledTimes(1);
  });

  it('reports an invalid stored timestamp as null instead of failing the listing', () => {
    tasksOf('p1')[0].createdAt = undefined as unknown as number;
    const r = okResult<{ tasks: CtlBoardTaskSummary[] }>(run({ action: 'board-list' }));
    expect(r.tasks[0].createdAt).toBeNull();
  });
});

describe('the Temporary project', () => {
  it('has no board; the message names the way out and that SSH sessions have none', () => {
    const r = run({ action: 'board-list' }, 'adhoc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'unsupported', message: expect.stringMatching(/--project.*not possible from an SSH session/) });
  });
});
