import { describe, it, expect } from 'vitest';
import { preserveMainOwnedFields } from './store';
import type { PersistedState } from '../shared/types';

const base = { version: 1, projects: [], activeProjectId: null, preferences: {} } as unknown as PersistedState;

describe('preserveMainOwnedFields', () => {
  const bounds = { x: 1, y: 2, width: 3, height: 4 };

  it('keeps sessionWindowBounds when the renderer payload lacks it', () => {
    expect(preserveMainOwnedFields(base, { ...base, sessionWindowBounds: bounds }).sessionWindowBounds).toEqual(bounds);
  });

  it('does not override bounds present in the payload', () => {
    const newer = { x: 9, y: 9, width: 9, height: 9 };
    expect(preserveMainOwnedFields({ ...base, sessionWindowBounds: newer }, { ...base, sessionWindowBounds: bounds }).sessionWindowBounds).toEqual(newer);
  });

  it('leaves state untouched when nothing is known', () => {
    expect(preserveMainOwnedFields(base, null)).toBe(base);
  });
});
