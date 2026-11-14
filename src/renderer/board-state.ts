import { appState } from './state.js';
import type { BoardTask, BoardColumn, BoardData, ColumnBehavior, TagDefinition } from '../shared/types.js';

export function getBoard(): BoardData | undefined {
  return appState.activeProject?.board;
}

export function getColumnByBehavior(behavior: ColumnBehavior, board: BoardData | undefined = getBoard()): BoardColumn | undefined {
  if (!board) return undefined;
  return board.columns.find(c => c.behavior === behavior);
}

export function getTasksForColumn(columnId: string): BoardTask[] {
  const board = getBoard();
  if (!board) return [];
  return board.tasks
    .filter(t => t.columnId === columnId)
    .sort((a, b) => a.order - b.order);
}

export function getTaskBySessionId(sessionId: string): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.tasks.find(t => t.sessionId === sessionId);
}

export function getTaskByCliSessionId(cliSessionId: string): BoardTask | undefined {
  const board = getBoard();
  if (!board) return undefined;
  return board.tasks.find(t => t.cliSessionId === cliSessionId);
}

/** Every mutator takes an optional `board` (default: the active project's), so vibeyard-ctl can edit any project's board. */
export function addTask(partial: Partial<BoardTask>, board: BoardData | undefined = getBoard()): BoardTask | undefined {
  if (!board) return undefined;

  const columnId = partial.columnId ?? getColumnByBehavior('inbox', board)?.id ?? board.columns[0]?.id;
  if (!columnId) return undefined;

  const tasksInColumn = board.tasks.filter(t => t.columnId === columnId);
  const maxOrder = tasksInColumn.reduce((max, t) => Math.max(max, t.order), -1);

  const now = Date.now();
  const taskId = partial.id ?? crypto.randomUUID();
  const task: BoardTask = {
    id: taskId,
    title: partial.title ?? '',
    prompt: partial.prompt ?? '',
    columnId,
    order: maxOrder + 1,
    createdAt: partial.createdAt || now,
    updatedAt: now,
    ...(partial.notes ? { notes: partial.notes } : {}),
    ...(partial.tags && partial.tags.length > 0 ? { tags: partial.tags } : {}),
    ...(partial.priority ? { priority: partial.priority } : {}),
    ...(partial.providerId ? { providerId: partial.providerId } : {}),
    ...(partial.profileId ? { profileId: partial.profileId } : {}),
    ...(partial.planMode !== undefined ? { planMode: partial.planMode } : {}),
  };

  board.tasks.push(task);
  appState.notifyBoardChanged();
  return task;
}

export function updateTask(taskId: string, updates: Partial<BoardTask>, board: BoardData | undefined = getBoard()): void {
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;
  const safeUpdates = { ...updates };
  if (safeUpdates.columnId && !board.columns.some(c => c.id === safeUpdates.columnId)) {
    delete safeUpdates.columnId;
  }
  Object.assign(task, safeUpdates, { updatedAt: Date.now() });
  appState.notifyBoardChanged();
}

export function deleteTask(taskId: string, board: BoardData | undefined = getBoard()): void {
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;

  const columnId = task.columnId;
  const order = task.order;
  board.tasks = board.tasks.filter(t => t.id !== taskId);

  board.tasks
    .filter(t => t.columnId === columnId && t.order > order)
    .forEach(t => t.order--);

  appState.notifyBoardChanged();
}

export function moveTask(taskId: string, toColumnId: string, toOrder: number, board: BoardData | undefined = getBoard()): void {
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (!board.columns.some(c => c.id === toColumnId)) return;

  const fromColumnId = task.columnId;

  if (fromColumnId !== toColumnId) {
    board.tasks
      .filter(t => t.columnId === fromColumnId && t.order > task.order)
      .forEach(t => t.order--);
  } else {
    // Same column: remove from current position first
    board.tasks
      .filter(t => t.columnId === fromColumnId && t.id !== taskId && t.order > task.order)
      .forEach(t => t.order--);
  }

  board.tasks
    .filter(t => t.columnId === toColumnId && t.order >= toOrder && t.id !== taskId)
    .forEach(t => t.order++);

  task.columnId = toColumnId;
  task.order = toOrder;
  task.updatedAt = Date.now();

  appState.notifyBoardChanged();
}

export function addColumn(title: string, afterColumnId?: string): BoardColumn | undefined {
  const board = getBoard();
  if (!board) return undefined;

  let insertOrder: number;
  if (afterColumnId) {
    const afterCol = board.columns.find(c => c.id === afterColumnId);
    insertOrder = afterCol ? afterCol.order + 1 : board.columns.length;
  } else {
    insertOrder = board.columns.length;
  }

  // Shift columns at or after insertion point
  board.columns
    .filter(c => c.order >= insertOrder)
    .forEach(c => c.order++);

  const column: BoardColumn = {
    id: crypto.randomUUID(),
    title,
    order: insertOrder,
    behavior: 'none',
  };
  board.columns.push(column);
  appState.notifyBoardChanged();
  return column;
}

export function renameColumn(columnId: string, title: string): void {
  const board = getBoard();
  if (!board) return;
  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;
  column.title = title;
  appState.notifyBoardChanged();
}

export function deleteColumn(columnId: string): void {
  const board = getBoard();
  if (!board) return;

  const column = board.columns.find(c => c.id === columnId);
  if (!column) return;

  // Prevent deleting if it's the last column
  if (board.columns.length <= 1) return;

  // Prevent deleting behavior columns (inbox, active, terminal)
  if (column.behavior !== 'none') return;

  // Move orphaned tasks to inbox column
  const inboxCol = getColumnByBehavior('inbox') ?? board.columns.find(c => c.id !== columnId)!;
  const orphanedTasks = board.tasks.filter(t => t.columnId === columnId);
  const maxInboxOrder = board.tasks
    .filter(t => t.columnId === inboxCol.id)
    .reduce((max, t) => Math.max(max, t.order), -1);

  orphanedTasks.forEach((t, i) => {
    t.columnId = inboxCol.id;
    t.order = maxInboxOrder + 1 + i;
  });

  board.columns = board.columns.filter(c => c.id !== columnId);
  board.columns.sort((a, b) => a.order - b.order).forEach((c, i) => c.order = i);

  appState.notifyBoardChanged();
}

export function reorderColumns(columnIds: string[]): void {
  const board = getBoard();
  if (!board) return;
  for (let i = 0; i < columnIds.length; i++) {
    const col = board.columns.find(c => c.id === columnIds[i]);
    if (col) col.order = i;
  }
  appState.notifyBoardChanged();
}

export const TAG_COLORS = ['blue', 'green', 'amber', 'red', 'purple', 'cyan', 'pink', 'gray'];

/** The form tags are stored and compared in. */
export function normalizeTagName(name: string): string {
  return name.toLowerCase().trim();
}

/** The palette entry for an already-normalized name, created (without notifying) when missing. */
function registerTag(board: BoardData, normalized: string, color?: string): { tag: TagDefinition; added: boolean } {
  if (!board.tags) board.tags = [];
  const existing = board.tags.find(t => t.name === normalized);
  if (existing) return { tag: existing, added: false };
  const tag: TagDefinition = { name: normalized, color: color ?? TAG_COLORS[board.tags.length % TAG_COLORS.length] };
  board.tags.push(tag);
  return { tag, added: true };
}

export function addTag(name: string, color?: string): TagDefinition | undefined {
  const board = getBoard();
  if (!board) return undefined;
  const { tag, added } = registerTag(board, normalizeTagName(name), color);
  if (added) appState.notifyBoardChanged();
  return tag;
}

/**
 * Add the missing palette entries for `names` **without notifying**: the caller
 * stores the returned names (normalized, deduplicated) on a task through
 * addTask/updateTask, whose notify covers both changes.
 */
export function ensureTags(names: string[], board: BoardData | undefined = getBoard()): string[] {
  const normalized = [...new Set(names.map(normalizeTagName).filter(Boolean))];
  if (board) for (const name of normalized) registerTag(board, name);
  return normalized;
}

export function removeTag(name: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  board.tags = board.tags.filter(t => t.name !== normalized);
  for (const task of board.tasks) {
    if (task.tags) {
      task.tags = task.tags.filter(t => t !== normalized);
    }
  }
  appState.notifyBoardChanged();
}

export function updateTagColor(name: string, color: string): void {
  const board = getBoard();
  if (!board || !board.tags) return;

  const normalized = name.toLowerCase().trim();
  const tag = board.tags.find(t => t.name === normalized);
  if (tag) {
    tag.color = color;
    appState.notifyBoardChanged();
  }
}

export function addTagToTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task) return;

  const normalized = tagName.toLowerCase().trim();
  if (!normalized) return;

  // Auto-create the tag in the palette if it doesn't exist
  addTag(normalized);

  if (!task.tags) task.tags = [];
  if (task.tags.includes(normalized)) return;
  task.tags.push(normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function removeTagFromTask(taskId: string, tagName: string): void {
  const board = getBoard();
  if (!board) return;
  const task = board.tasks.find(t => t.id === taskId);
  if (!task || !task.tags) return;

  const normalized = tagName.toLowerCase().trim();
  task.tags = task.tags.filter(t => t !== normalized);
  task.updatedAt = Date.now();
  appState.notifyBoardChanged();
}

export function getTagColor(tagName: string): string {
  const board = getBoard();
  const tag = board?.tags?.find(t => t.name === tagName);
  return tag?.color ?? 'gray';
}

export function getTagCount(tagName: string): number {
  const board = getBoard();
  if (!board) return 0;
  return board.tasks.filter(t => t.tags?.includes(tagName)).length;
}

