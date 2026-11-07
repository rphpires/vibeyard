// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// A diff tab of project B (detached into the sessions window) while main shows A:
// its relative path and its git diff resolve against B, not the active project.

const getDiff = vi.fn();
const watchDir = vi.fn();
const projectA = { id: 'A', path: '/a', sessions: [] as Array<{ id: string }> };
const projectB = { id: 'B', path: '/b', sessions: [{ id: 'b-diff' }] };

vi.mock('../state.js', () => ({
  appState: {
    get activeProject() { return projectA; },
    projects: [projectA, projectB],
    findSessionWithProject: (id: string) => {
      for (const project of [projectA, projectB]) {
        const session = project.sessions.find((s) => s.id === id);
        if (session) return { project, session };
      }
      return undefined;
    },
  },
}));
vi.mock('../session-close.js', () => ({ closeSessionIfFileMissing: vi.fn(() => Promise.resolve(false)) }));
vi.mock('./search-bar.js', () => ({ destroySearchBar: vi.fn() }));

const { createFileViewerPane, showFileViewerPane } = await import('./file-viewer.js');

beforeEach(() => {
  vi.clearAllMocks();
  getDiff.mockResolvedValue('@@ -1 +1 @@\n-a\n+b');
  (window as unknown as { vibeyard: unknown }).vibeyard = {
    git: { getDiff },
    fs: { watchDir, unwatchDir: vi.fn(), onFsChange: vi.fn(() => () => {}) },
  };
});

describe('file viewer of a non-active project', () => {
  it('resolves its relative path and loads its diff against its own project', async () => {
    createFileViewerPane('b-diff', 'src/x.ts', 'unstaged');
    showFileViewerPane('b-diff', false);
    expect(watchDir).toHaveBeenCalledWith('/b/src');
    await vi.waitFor(() => expect(getDiff).toHaveBeenCalledWith('/b', 'src/x.ts', 'unstaged'));
  });
});
