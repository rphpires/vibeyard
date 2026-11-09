import { describe, it, expect } from 'vitest';
import { entryNameError, uniqueEntryName, assignEntryNames, pastedImageName } from './file-names';

describe('entryNameError', () => {
  it('accepts ordinary names, dotfiles and spaces', () => {
    for (const ok of ['a.ts', '.env', 'my file (1).pdf', 'ação.md']) expect(entryNameError(ok)).toBeNull();
  });

  it('refuses empty, dot names, separators and NUL', () => {
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\0b']) expect(entryNameError(bad)).not.toBeNull();
  });
});

describe('uniqueEntryName', () => {
  it('keeps a free name', () => {
    expect(uniqueEntryName('a.ts', new Set(['b.ts']))).toBe('a.ts');
  });

  it('numbers before the extension, skipping taken numbers', () => {
    expect(uniqueEntryName('report.pdf', new Set(['report.pdf', 'report (1).pdf']))).toBe('report (2).pdf');
  });

  it('ignoreCase counts a case-variant as taken', () => {
    expect(uniqueEntryName('README.md', new Set(['readme.md']))).toBe('README.md');
    expect(uniqueEntryName('README.md', new Set(['readme.md']), true)).toBe('README (1).md');
  });

  it('treats a dotfile and an extensionless folder as all base', () => {
    expect(uniqueEntryName('.env', new Set(['.env']))).toBe('.env (1)');
    expect(uniqueEntryName('src', new Set(['src']))).toBe('src (1)');
  });
});

describe('assignEntryNames', () => {
  it('keeps the batch distinct too', () => {
    expect(assignEntryNames(['a.ts', 'a.ts', 'b.ts'], new Set(['b.ts']))).toEqual(['a.ts', 'a (1).ts', 'b (1).ts']);
  });
});

describe('pastedImageName', () => {
  it('stamps the paste time', () => {
    expect(pastedImageName(new Date(2026, 10, 7, 9, 5, 3))).toBe('pasted-image-20261107-090503.png');
  });
});
