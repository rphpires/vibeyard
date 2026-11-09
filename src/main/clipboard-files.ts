/**
 * What the OS clipboard holds that a file-tree paste can use: files copied in
 * the OS file manager (Explorer, Finder, Nautilus...) or an image (a
 * screenshot). Electron exposes neither a cross-platform file list nor a
 * change counter, so each platform is read its own way. The text formats
 * (and the paths a tree "Copy" writes as text) are deliberately ignored: they
 * are what makes a tree-internal copy win over a stale screenshot.
 */
import { clipboard } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isMac, isWin } from './platform';

export type ClipboardPasteable =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; png: Buffer }
  | { kind: 'none' };

/** Formats that can never carry a file list (Windows): with only these, PowerShell is not spawned. */
const NON_FILE_FORMATS = new Set(['text/plain', 'text/html', 'text/rtf', 'image/png', 'image/jpeg', 'image/bmp', 'image/gif']);

/** Absolute paths from a `text/uri-list` (or GNOME `copied-files`) payload; non-`file:` lines are skipped. */
export function parseUriList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('file://')) continue;
    try { out.push(fileURLToPath(line)); } catch { /* malformed URL */ }
  }
  return out;
}

/** Paths from a macOS `NSFilenamesPboardType` property list. */
export function parseFilenamesPlist(xml: string): string[] {
  const out: string[] = [];
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  for (const m of xml.matchAll(/<string>([^<]*)<\/string>/g)) out.push(decode(m[1]));
  return out;
}

function windowsFileDropList(): Promise<string[]> {
  const formats = clipboard.availableFormats();
  if (formats.length === 0 || formats.every((f) => NON_FILE_FORMATS.has(f))) return Promise.resolve([]);
  const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }';
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      resolve(stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => path.isAbsolute(l)));
    });
  });
}

async function clipboardFiles(): Promise<string[]> {
  if (isWin) return windowsFileDropList();
  if (isMac) {
    const plist = clipboard.read('NSFilenamesPboardType');
    if (plist) return parseFilenamesPlist(plist);
    return parseUriList(clipboard.read('public.file-url'));
  }
  return parseUriList(clipboard.read('x-special/gnome-copied-files') || clipboard.read('text/uri-list'));
}

/** Files first (an image file copied in Explorer may also put a bitmap on the clipboard), then an image. */
export async function readClipboardPasteable(): Promise<ClipboardPasteable> {
  const paths = await clipboardFiles();
  if (paths.length > 0) return { kind: 'files', paths };
  const image = clipboard.readImage();
  if (!image.isEmpty()) return { kind: 'image', png: image.toPNG() };
  return { kind: 'none' };
}
