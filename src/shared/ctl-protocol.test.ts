import { describe, it, expect } from 'vitest';
import { parseCtlRequest, ctlError, scopeViolation, CTL_MAX_PROMPT_CHARS, CTL_MAX_TAGS } from './ctl-protocol';

const req = (command: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, token: 'tok', command, ...extra });

describe('parseCtlRequest', () => {
  it('accepts a full new-session request and keeps strings verbatim', () => {
    const name = 'DR-1 "quoted" $HOME `x` ünï';
    const prompt = 'line1\nline2 "q" $(rm -rf /)';
    const r = parseCtlRequest(req({ action: 'new-session', name, prompt, project: '/p', provider: 'claude', profile: 'work', focus: true }));
    expect(r).toEqual({ ok: true, token: 'tok', command: { action: 'new-session', name, prompt, project: '/p', provider: 'claude', profile: 'work', focus: true } });
  });

  it.each(['args', 'env'])('rejects a new-session carrying %s instead of silently dropping it', (key) => {
    const r = parseCtlRequest(req({ action: 'new-session', name: 'n', [key]: key === 'env' ? 'NODE_OPTIONS=--require x' : '--dangerously-skip-permissions' }));
    expect(r).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: `'${key}' is not supported: new sessions use the project's saved default args and env` },
    });
  });

  it('accepts rename, close and list', () => {
    expect(parseCtlRequest(req({ action: 'rename', sessionId: 's1', name: 'n' }))).toMatchObject({ ok: true, command: { action: 'rename', sessionId: 's1', name: 'n' } });
    expect(parseCtlRequest(req({ action: 'close', sessionId: 's1' }))).toMatchObject({ ok: true, command: { action: 'close', sessionId: 's1' } });
    expect(parseCtlRequest(req({ action: 'list', mine: true }))).toMatchObject({ ok: true, command: { action: 'list', mine: true } });
  });

  it.each([
    ['not json', '{'],
    ['wrong version', JSON.stringify({ v: 2, token: 't', command: { action: 'list' } })],
    ['missing token', JSON.stringify({ v: 1, command: { action: 'list' } })],
    ['unknown action', req({ action: 'send', sessionId: 's' })],
    ['empty name', req({ action: 'new-session', name: '   ' })],
    ['non-string name', req({ action: 'new-session', name: 5 })],
    ['missing sessionId', req({ action: 'close' })],
    ['focus not boolean', req({ action: 'new-session', name: 'n', focus: 'yes' })],
    ['prompt too long', req({ action: 'new-session', name: 'n', prompt: 'x'.repeat(CTL_MAX_PROMPT_CHARS + 1) })],
  ])('rejects %s with invalid_request', (_label, raw) => {
    const r = parseCtlRequest(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_request');
  });

  it('drops unknown fields instead of passing them through', () => {
    const r = parseCtlRequest(req({ action: 'close', sessionId: 's', evil: 1 }));
    expect(r).toEqual({ ok: true, token: 'tok', command: { action: 'close', sessionId: 's' } });
  });
});

describe('ctlError', () => {
  it('builds the error envelope', () => {
    expect(ctlError('not_owner', 'nope')).toEqual({ ok: false, error: { code: 'not_owner', message: 'nope' } });
  });
});

describe('parseCtlRequest: board commands', () => {
  const ok = (command: unknown) => {
    const r = parseCtlRequest(req(command));
    if (!r.ok) throw new Error(r.error.message);
    return r.command;
  };

  it('accepts every board command and keeps only known fields', () => {
    expect(ok({ action: 'board-list', column: 'Ready', tag: 'bug', priority: 'high', evil: 1 }))
      .toEqual({ action: 'board-list', column: 'Ready', tag: 'bug', priority: 'high' });
    expect(ok({ action: 'board-show', taskId: 'abcd' })).toEqual({ action: 'board-show', taskId: 'abcd' });
    expect(ok({ action: 'board-add', title: 'T', prompt: 'p\nq', notes: 'n', column: 'Backlog', tags: ['a', 'B'], priority: 'urgent' }))
      .toEqual({ action: 'board-add', title: 'T', prompt: 'p\nq', notes: 'n', column: 'Backlog', tags: ['a', 'B'], priority: 'urgent' });
    expect(ok({ action: 'board-update', taskId: 't', priority: 'none', addTags: ['x'], removeTags: ['y'], notes: '' }))
      .toEqual({ action: 'board-update', taskId: 't', priority: 'none', addTags: ['x'], removeTags: ['y'], notes: '' });
    expect(ok({ action: 'board-move', taskId: 't', column: 'Done', position: 0 })).toEqual({ action: 'board-move', taskId: 't', column: 'Done', position: 0 });
    expect(ok({ action: 'board-delete', taskId: 't', project: 'p1' })).toEqual({ action: 'board-delete', taskId: 't', project: 'p1' });
  });

  it.each([
    ['add without title', { action: 'board-add' }],
    ['blank title', { action: 'board-add', title: '  ' }],
    ['bad priority', { action: 'board-add', title: 'T', priority: 'p0' }],
    ['none priority on add', { action: 'board-add', title: 'T', priority: 'none' }],
    ['tags not a list', { action: 'board-add', title: 'T', tags: 'a,b' }],
    ['blank tag', { action: 'board-add', title: 'T', tags: [' '] }],
    ['too many tags', { action: 'board-add', title: 'T', tags: Array.from({ length: CTL_MAX_TAGS + 1 }, (_, i) => `t${i}`) }],
    ['update with nothing to change', { action: 'board-update', taskId: 't', project: 'p' }],
    ['move without column', { action: 'board-move', taskId: 't' }],
    ['negative position', { action: 'board-move', taskId: 't', column: 'c', position: -1 }],
    ['fractional position', { action: 'board-move', taskId: 't', column: 'c', position: 1.5 }],
    ['show without task', { action: 'board-show' }],
  ])('rejects %s', (_label, command) => {
    const r = parseCtlRequest(req(command));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_request');
  });
});

describe('scopeViolation', () => {
  it('allows everything locally', () => {
    expect(scopeViolation({ action: 'close', sessionId: 's' }, 'local')).toBeNull();
  });

  it('allows a remote caller only the board commands, without --project', () => {
    expect(scopeViolation({ action: 'board-list' }, 'remote')).toBeNull();
    expect(scopeViolation({ action: 'board-add', title: 't' }, 'remote')).toBeNull();
    expect(scopeViolation({ action: 'new-session', name: 'n' }, 'remote')).toMatch(/not available from a remote/);
    expect(scopeViolation({ action: 'list' }, 'remote')).toMatch(/not available from a remote/);
    expect(scopeViolation({ action: 'board-list', project: 'p2' }, 'remote')).toMatch(/--project/);
    expect(scopeViolation({ action: 'board-delete', taskId: 't', project: 'p2' }, 'remote')).toMatch(/--project/);
  });
});
