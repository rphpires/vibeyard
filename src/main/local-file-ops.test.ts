import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLocalEntry, renameLocalEntry, copyLocalEntries, writeLocalFile } from './local-file-ops';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-ops-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const ls = (dir: string) => fs.readdirSync(dir).sort();

describe('createLocalEntry', () => {
  it('creates a file and a folder, refusing a taken name or a bad one', async () => {
    expect(await createLocalEntry(root, 'a.ts', 'file')).toBe(path.join(root, 'a.ts'));
    await createLocalEntry(root, 'src', 'dir');
    expect(fs.statSync(path.join(root, 'src')).isDirectory()).toBe(true);
    await expect(createLocalEntry(root, 'a.ts', 'file')).rejects.toThrow();
    await expect(createLocalEntry(root, '../x', 'file')).rejects.toThrow(/cannot contain/);
  });
});

describe('renameLocalEntry', () => {
  it('renames, refusing to overwrite a sibling', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'b.ts'), 'b');
    await expect(renameLocalEntry(path.join(root, 'a.ts'), 'b.ts')).rejects.toThrow(/already exists/);
    expect(await renameLocalEntry(path.join(root, 'a.ts'), 'c.ts')).toBe(path.join(root, 'c.ts'));
    expect(ls(root)).toEqual(['b.ts', 'c.ts']);
    expect(fs.readFileSync(path.join(root, 'b.ts'), 'utf-8')).toBe('b');
  });

  it('allows a case-only rename', async () => {
    fs.writeFileSync(path.join(root, 'readme.md'), 'r');
    expect(await renameLocalEntry(path.join(root, 'readme.md'), 'README.md')).toBe(path.join(root, 'README.md'));
    expect(ls(root)).toEqual(['README.md']);
  });
});

describe('copyLocalEntries', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'x');
    fs.mkdirSync(path.join(root, 'dest'));
  });

  it('copies files and folders, numbering a taken name', async () => {
    fs.writeFileSync(path.join(root, 'dest', 'x.ts'), 'old');
    const created = await copyLocalEntries([path.join(root, 'src', 'x.ts'), path.join(root, 'src')], path.join(root, 'dest'), false);
    expect(created).toEqual([path.join(root, 'dest', 'x (1).ts'), path.join(root, 'dest', 'src')]);
    expect(fs.readFileSync(path.join(root, 'dest', 'x.ts'), 'utf-8')).toBe('old');
    expect(ls(path.join(root, 'dest', 'src'))).toEqual(['x.ts']);
    expect(ls(path.join(root, 'src'))).toEqual(['x.ts']);
  });

  it('copying into the same folder makes a numbered copy', async () => {
    await copyLocalEntries([path.join(root, 'src', 'x.ts')], path.join(root, 'src'), false);
    expect(ls(path.join(root, 'src'))).toEqual(['x (1).ts', 'x.ts']);
  });

  it('moves, and moving into the same folder is a no-op', async () => {
    expect(await copyLocalEntries([path.join(root, 'src', 'x.ts')], path.join(root, 'src'), true)).toEqual([]);
    await copyLocalEntries([path.join(root, 'src', 'x.ts')], path.join(root, 'dest'), true);
    expect(ls(path.join(root, 'src'))).toEqual([]);
    expect(ls(path.join(root, 'dest'))).toEqual(['x.ts']);
  });

  it('refuses to paste a folder into itself', async () => {
    await expect(copyLocalEntries([path.join(root, 'src')], path.join(root, 'src'), false)).rejects.toThrow(/into itself/);
  });
});

describe('writeLocalFile', () => {
  it('writes bytes under a free name', async () => {
    fs.writeFileSync(path.join(root, 'shot.png'), 'old');
    const p = await writeLocalFile(root, 'shot.png', new Uint8Array([1, 2, 3]));
    expect(p).toBe(path.join(root, 'shot (1).png'));
    expect([...fs.readFileSync(p)]).toEqual([1, 2, 3]);
  });
});
