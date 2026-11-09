import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { remoteScripts, parseStatOutput, localSafeName, remoteCopyPath, REMOTE_FILES_DIR } from './remote-file-ops';
import { isWin } from './platform';

describe('parseStatOutput', () => {
  it('reads "<size> <mtime>" from GNU or BSD stat', () => {
    expect(parseStatOutput('1234 1700000000\n')).toEqual({ size: 1234, mtimeMs: 1_700_000_000_000 });
    expect(parseStatOutput('stat: cannot stat')).toBeNull();
  });
});

describe('remoteCopyPath', () => {
  it('mirrors the host path under the remote-files dir', () => {
    expect(remoteCopyPath('box', '/srv/app/src/a.ts')).toBe(path.join(REMOTE_FILES_DIR, 'box', 'srv', 'app', 'src', 'a.ts'));
  });

  it.skipIf(!isWin)('makes host names valid Windows file names', () => {
    expect(localSafeName('a:b?.txt')).toBe('a_b_.txt');
    expect(localSafeName('con.txt')).toBe('_con.txt');
    expect(localSafeName('trailing. ')).toBe('trailing__');
  });
});

describe('remote scripts', () => {
  it('quote every path', () => {
    const evil = "/srv/app/it's $(rm -rf ~).txt";
    const root = '/srv/app';
    for (const script of [remoteScripts.mkdir(root, evil), remoteScripts.touch(root, evil), remoteScripts.remove(root, evil), remoteScripts.transfer(root, [[evil, `${evil}2`]], true)]) {
      expect(script).toContain(`'/srv/app/it'\\''s $(rm -rf ~).txt'`);
    }
  });

  // Run them for real under sh, against a temp folder standing in for the host.
  const shAvailable = !isWin && spawnSync('sh', ['-c', 'true']).status === 0;
  describe.skipIf(!shAvailable)('under sh', () => {
    let root: string;
    const sh = (script: string, input?: Buffer | string) => spawnSync('sh', ['-s'], { input: input === undefined ? script : undefined, encoding: 'utf-8' });
    const shc = (script: string, input: Buffer) => spawnSync('sh', ['-c', script], { input });
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-rops-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('touch and move refuse an existing target', () => {
      const a = path.join(root, 'a');
      expect(sh(remoteScripts.touch(root, a)).status).toBe(0);
      const again = sh(remoteScripts.touch(root, a));
      expect(again.status).not.toBe(0);
      expect(again.stderr).toContain('already exists');
      fs.writeFileSync(path.join(root, 'b'), 'b');
      expect(sh(remoteScripts.transfer(root, [[a, path.join(root, 'b')]], true)).status).not.toBe(0);
      expect(fs.readFileSync(path.join(root, 'b'), 'utf-8')).toBe('b');
    });

    it('copy is recursive; remove deletes a tree', () => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'x'), 'x');
      expect(sh(remoteScripts.transfer(root, [[path.join(root, 'src'), path.join(root, 'src (1)')]], false)).status).toBe(0);
      expect(fs.readFileSync(path.join(root, 'src (1)', 'x'), 'utf-8')).toBe('x');
      expect(sh(remoteScripts.remove(root, path.join(root, 'src'))).status).toBe(0);
      expect(fs.existsSync(path.join(root, 'src'))).toBe(false);
    });

    it('the guard refuses a folder that a symlink takes outside the project', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vy-out-'));
      try {
        fs.writeFileSync(path.join(outside, 'secret'), 's');
        fs.symlinkSync(outside, path.join(root, 'link'));
        const res = sh(remoteScripts.remove(root, path.join(root, 'link', 'secret')));
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('leaves the project folder');
        expect(fs.existsSync(path.join(outside, 'secret'))).toBe(true);
        // The link itself (its folder is the project) may still be deleted, without following it.
        expect(sh(remoteScripts.remove(root, path.join(root, 'link'))).status).toBe(0);
        expect(fs.existsSync(path.join(outside, 'secret'))).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('fetch sends the bytes only when the copy is stale', () => {
      fs.writeFileSync(path.join(root, 'f'), 'hello');
      const fresh = sh(remoteScripts.fetch(root, path.join(root, 'f'), '', 1024)).stdout;
      const nl = fresh.indexOf('\n');
      const statLine = fresh.slice(0, nl);
      expect(fresh.slice(nl + 1)).toBe('hello');
      expect(sh(remoteScripts.fetch(root, path.join(root, 'f'), statLine, 1024)).stdout).toBe(`${statLine}\n`);
      expect(sh(remoteScripts.fetch(root, path.join(root, 'f'), '', 2)).stderr).toContain('too large');
    });

    it('stat reports size', () => {
      fs.writeFileSync(path.join(root, 'f'), 'hello');
      expect(parseStatOutput(sh(remoteScripts.stat(root, path.join(root, 'f'))).stdout)?.size).toBe(5);
    });

    it('write refuses to clobber; pack/unpack moves a folder under a new name', () => {
      const f = path.join(root, 'img.png');
      expect(shc(remoteScripts.write(root, f), Buffer.from([0, 1, 2])).status).toBe(0);
      expect([...fs.readFileSync(f)]).toEqual([0, 1, 2]);
      expect(shc(remoteScripts.write(root, f), Buffer.from([9])).status).not.toBe(0);

      fs.mkdirSync(path.join(root, 'srcdir'));
      fs.writeFileSync(path.join(root, 'srcdir', 'x'), 'x');
      fs.mkdirSync(path.join(root, 'dest'));
      const tar = spawnSync('sh', ['-c', remoteScripts.pack(root, path.join(root, 'srcdir'))]);
      expect(tar.status).toBe(0);
      expect(shc(remoteScripts.unpack(root, path.join(root, 'dest'), 'srcdir', 'srcdir (1)'), tar.stdout).status).toBe(0);
      expect(fs.readdirSync(path.join(root, 'dest'))).toEqual(['srcdir (1)']);
      expect(fs.readFileSync(path.join(root, 'dest', 'srcdir (1)', 'x'), 'utf-8')).toBe('x');
    });
  });
});
