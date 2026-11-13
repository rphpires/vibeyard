import type { TaskPriority } from '../shared/types.js';
import { t } from './i18n.js';

/** Maps each priority onto an existing `.tag-pill[data-color]` swatch. */
const PRIORITY_COLORS: Record<TaskPriority, string> = {
  urgent: 'red',
  high: 'amber',
  medium: 'blue',
  low: 'gray',
};

export function priorityLabel(priority: TaskPriority): string {
  return t(`board.priority.${priority}`);
}

/** A `.tag-pill` showing a priority; callers add their size/role class. */
export function createPriorityPill(priority: TaskPriority, extraClass: string): HTMLElement {
  const pill = document.createElement('span');
  pill.className = `tag-pill ${extraClass}`;
  pill.dataset.color = PRIORITY_COLORS[priority];
  pill.dataset.priority = priority;
  pill.textContent = priorityLabel(priority);
  return pill;
}
