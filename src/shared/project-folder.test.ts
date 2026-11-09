import { describe, it, expect } from 'vitest';
import { localProjectFolder, projectFolderLocation } from './project-folder';

describe('localProjectFolder', () => {
  it('returns the path of a local project', () => {
    expect(localProjectFolder({ path: '/repo/app' })).toBe('/repo/app');
  });

  it('has no local folder for a remote project, the Temporary project, or an empty path', () => {
    expect(localProjectFolder({ path: '/srv/app', remoteHost: 'box' })).toBeUndefined();
    expect(localProjectFolder({ path: '', temporary: true })).toBeUndefined();
    expect(localProjectFolder({ path: '' })).toBeUndefined();
  });
});

describe('projectFolderLocation', () => {
  it('locates local and remote folders, none for Temporary', () => {
    expect(projectFolderLocation({ path: '/repo/app' })).toEqual({ path: '/repo/app' });
    expect(projectFolderLocation({ path: '/srv/app', remoteHost: 'box' })).toEqual({ path: '/srv/app', host: 'box' });
    expect(projectFolderLocation({ path: '', temporary: true })).toBeUndefined();
    expect(projectFolderLocation({ path: '' })).toBeUndefined();
  });
});
