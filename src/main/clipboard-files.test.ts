import { describe, it, expect, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

vi.mock('electron', () => ({ clipboard: {} }));

import { parseUriList, parseFilenamesPlist } from './clipboard-files';

describe('parseUriList', () => {
  it('keeps file URLs (GNOME copied-files header and other schemes skipped)', () => {
    const a = path.resolve('/tmp/a b.png');
    const b = path.resolve('/tmp/ação.txt');
    const text = `copy\n${pathToFileURL(a).href}\r\nhttps://example.com\n${pathToFileURL(b).href}\n`;
    expect(parseUriList(text)).toEqual([a, b]);
  });
});

describe('parseFilenamesPlist', () => {
  it('reads every string entry, decoding XML entities', () => {
    const xml = '<plist><array><string>/Users/me/a &amp; b.png</string><string>/Users/me/c.txt</string></array></plist>';
    expect(parseFilenamesPlist(xml)).toEqual(['/Users/me/a & b.png', '/Users/me/c.txt']);
  });
});
