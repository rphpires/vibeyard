import { describe, it, expect, beforeEach } from 'vitest';
import type { BoardTask } from '../shared/types';
import {
  setSearchQuery, getSearchQuery, toggleTagFilter, isTagFilterActive,
  hasActiveFilters, matchesFilter, getFilteredTasks, clearFilters,
  togglePriorityFilter, isPriorityFilterActive,
} from './board-filter';

function makeTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'task-1',
    title: 'Test Task',
    prompt: 'Do something',
    columnId: 'col-1',
    order: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  clearFilters();
});

describe('search filter', () => {
  it('matches by title substring (case-insensitive)', () => {
    setSearchQuery('test');
    expect(matchesFilter(makeTask({ title: 'My Test Task' }))).toBe(true);
    expect(matchesFilter(makeTask({ title: 'Unrelated' }))).toBe(false);
  });

  it('matches by prompt substring', () => {
    setSearchQuery('something');
    expect(matchesFilter(makeTask({ prompt: 'Do something cool' }))).toBe(true);
  });

  it('empty query matches everything', () => {
    setSearchQuery('');
    expect(matchesFilter(makeTask())).toBe(true);
  });

  it('getSearchQuery returns current query', () => {
    setSearchQuery('hello');
    expect(getSearchQuery()).toBe('hello');
  });
});

describe('tag filter', () => {
  it('toggles tag filter on and off', () => {
    toggleTagFilter('bug');
    expect(isTagFilterActive('bug')).toBe(true);
    toggleTagFilter('bug');
    expect(isTagFilterActive('bug')).toBe(false);
  });

  it('filters tasks with matching tags (OR)', () => {
    toggleTagFilter('bug');
    toggleTagFilter('feature');
    expect(matchesFilter(makeTask({ tags: ['bug'] }))).toBe(true);
    expect(matchesFilter(makeTask({ tags: ['feature'] }))).toBe(true);
    expect(matchesFilter(makeTask({ tags: ['docs'] }))).toBe(false);
    expect(matchesFilter(makeTask({ tags: undefined }))).toBe(false);
  });

  it('no active tags matches all tasks', () => {
    expect(matchesFilter(makeTask({ tags: [] }))).toBe(true);
    expect(matchesFilter(makeTask({ tags: undefined }))).toBe(true);
  });
});

describe('combined filter (AND)', () => {
  it('requires both search and tag match', () => {
    setSearchQuery('test');
    toggleTagFilter('bug');
    expect(matchesFilter(makeTask({ title: 'Test', tags: ['bug'] }))).toBe(true);
    expect(matchesFilter(makeTask({ title: 'Test', tags: ['feature'] }))).toBe(false);
    expect(matchesFilter(makeTask({ title: 'Other', tags: ['bug'] }))).toBe(false);
  });
});

describe('getFilteredTasks', () => {
  it('returns all tasks when no filters active', () => {
    const tasks = [makeTask({ id: '1' }), makeTask({ id: '2' })];
    expect(getFilteredTasks(tasks)).toEqual(tasks);
  });

  it('returns only matching tasks', () => {
    setSearchQuery('alpha');
    const tasks = [
      makeTask({ id: '1', title: 'Alpha task' }),
      makeTask({ id: '2', title: 'Beta task' }),
    ];
    const result = getFilteredTasks(tasks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
  });
});

describe('hasActiveFilters', () => {
  it('returns false when clean', () => {
    expect(hasActiveFilters()).toBe(false);
  });

  it('returns true with search query', () => {
    setSearchQuery('hello');
    expect(hasActiveFilters()).toBe(true);
  });

  it('returns true with active tag', () => {
    toggleTagFilter('bug');
    expect(hasActiveFilters()).toBe(true);
  });

  it('clearFilters resets everything', () => {
    setSearchQuery('hello');
    toggleTagFilter('bug');
    clearFilters();
    expect(hasActiveFilters()).toBe(false);
  });
});

describe('priority filter', () => {
  it('matches only tasks with a selected priority', () => {
    togglePriorityFilter('high');
    expect(matchesFilter(makeTask({ priority: 'high' }))).toBe(true);
    expect(matchesFilter(makeTask({ priority: 'low' }))).toBe(false);
    expect(matchesFilter(makeTask())).toBe(false);
  });

  it('ORs multiple selected priorities', () => {
    togglePriorityFilter('high');
    togglePriorityFilter('urgent');
    expect(matchesFilter(makeTask({ priority: 'urgent' }))).toBe(true);
    expect(matchesFilter(makeTask({ priority: 'high' }))).toBe(true);
    expect(matchesFilter(makeTask({ priority: 'medium' }))).toBe(false);
  });

  it('ANDs with tag filters', () => {
    togglePriorityFilter('high');
    toggleTagFilter('bug');
    expect(matchesFilter(makeTask({ priority: 'high', tags: ['bug'] }))).toBe(true);
    expect(matchesFilter(makeTask({ priority: 'high', tags: ['ui'] }))).toBe(false);
    expect(matchesFilter(makeTask({ priority: 'low', tags: ['bug'] }))).toBe(false);
  });

  it('toggles off and counts as an active filter', () => {
    togglePriorityFilter('low');
    expect(isPriorityFilterActive('low')).toBe(true);
    expect(hasActiveFilters()).toBe(true);
    togglePriorityFilter('low');
    expect(isPriorityFilterActive('low')).toBe(false);
    expect(hasActiveFilters()).toBe(false);
  });

  it('is reset by clearFilters', () => {
    togglePriorityFilter('urgent');
    clearFilters();
    expect(isPriorityFilterActive('urgent')).toBe(false);
  });
});
