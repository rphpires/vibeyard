// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addFileReaderSession = vi.fn();
const openExternal = vi.fn();
const exists = vi.fn();
const isDirectory = vi.fn();
const addBrowserTabSession = vi.fn();
const readFile = vi.fn();
let activeProject: { id: string; path: string } | null = { id: 'p1', path: '/repo' };
// B is detached into the sessions window and owns the file-reader tabs below.
const projectB = { id: 'B', path: '/b', sessions: [{ id: 'b-md' }, { id: 'b-html' }] };

vi.mock('../state.js', () => ({
  appState: {
    get activeProject() { return activeProject; },
    get projects() { return [activeProject, projectB].filter(Boolean); },
    projectOfSession(id: string) { return this.findSessionWithProject(id)?.project; },
    findSessionWithProject: (id: string) => {
      const session = projectB.sessions.find((s) => s.id === id);
      return session ? { project: projectB, session } : undefined;
    },
    addFileReaderSession,
    addBrowserTabSession,
  },
}));
vi.mock('../session-window-handle.js', () => ({ focusSessionWindow: vi.fn() }));
vi.mock('../session-close.js', () => ({ closeSessionIfFileMissing: vi.fn() }));
vi.mock('./search-bar.js', () => ({ destroySearchBar: vi.fn() }));

const { renderMarkdownContent, createFileReaderPane, showFileReaderPane, getFileReaderInstance } = await import('./file-reader.js');
const windowState = await import('../session-window-state.js');

beforeEach(() => {
  vi.clearAllMocks();
  exists.mockResolvedValue(true);
  isDirectory.mockResolvedValue(false);
  openExternal.mockResolvedValue(undefined);
  activeProject = { id: 'p1', path: '/repo' };
  document.body.innerHTML = '';
  // jsdom does not implement scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn();
  (globalThis as unknown as { window: { vibeyard: unknown } }).window.vibeyard = {
    app: { openExternal },
    fs: { exists, isDirectory, readFile, watchDir: vi.fn(), unwatchDir: vi.fn(), onFsChange: vi.fn(() => () => {}) },
  };
});

/** Render markdown, attach to the document, and click the first link. */
function clickFirstLink(markdown: string, baseDir?: string): { wrapper: HTMLElement; defaultPrevented: boolean } {
  const wrapper = renderMarkdownContent(markdown, baseDir);
  document.body.appendChild(wrapper);
  const anchor = wrapper.querySelector('a')!;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  return { wrapper, defaultPrevented: event.defaultPrevented };
}

describe('renderMarkdownContent link handling', () => {
  it('never lets a link navigate the app document', () => {
    for (const md of [
      '[x](other.md)',
      '[x](https://example.com)',
      '[x](file:///etc/hosts)',
      '[x](#heading)',
      '[x](/abs/doc.md)',
    ]) {
      expect(clickFirstLink(md, '/repo/docs').defaultPrevented).toBe(true);
    }
  });

  it('opens a relative file link in a file reader tab, resolved against the base dir', async () => {
    clickFirstLink('[x](../README.md)', '/repo/docs');
    await vi.waitFor(() => expect(addFileReaderSession).toHaveBeenCalledWith('p1', '/repo/README.md', undefined));
  });

  it('does not open a tab when the linked file is missing', async () => {
    exists.mockResolvedValue(false);
    clickFirstLink('[x](gone.md)', '/repo/docs');
    await vi.waitFor(() => expect(exists).toHaveBeenCalled());
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });

  it('does not open a tab for a directory link', async () => {
    isDirectory.mockResolvedValue(true);
    clickFirstLink('[x](../guides)', '/repo/docs');
    await vi.waitFor(() => expect(isDirectory).toHaveBeenCalledWith('/repo/guides'));
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });

  it('drops the tab when the project goes away mid-lookup', async () => {
    exists.mockImplementation(async () => {
      activeProject = null;
      return true;
    });
    clickFirstLink('[x](../README.md)', '/repo/docs');
    await vi.waitFor(() => expect(exists).toHaveBeenCalled());
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });

  it('ignores relative links when no base dir is known', async () => {
    clickFirstLink('[x](sibling.md)');
    await Promise.resolve();
    expect(exists).not.toHaveBeenCalled();
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });

  it('sends http(s) links to the system browser', () => {
    clickFirstLink('[x](https://example.com/a)', '/repo/docs');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });

  it('scrolls to the matching heading for in-document anchors', () => {
    const { wrapper } = clickFirstLink('## Notification Types\n\n[x](#notification-types)', '/repo/docs');
    const heading = wrapper.querySelector('h2')!;
    expect(heading.scrollIntoView).toHaveBeenCalled();
  });

  it('ignores clicks that are not on a link', () => {
    const wrapper = renderMarkdownContent('plain paragraph', '/repo/docs');
    document.body.appendChild(wrapper);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    wrapper.querySelector('p')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(addFileReaderSession).not.toHaveBeenCalled();
  });
});

describe('a file reader of the project detached into the sessions window (main shows p1)', () => {
  beforeEach(() => {
    windowState._resetForTesting();
    windowState.setDetachedProjectId('B');
  });

  it('a Markdown file link opens in B, resolved against the file, not in the active project', async () => {
    readFile.mockResolvedValue({ ok: true, content: '[x](../README.md)' });
    createFileReaderPane('b-md', '/b/docs/a.md');
    showFileReaderPane('b-md', false);
    const el = getFileReaderInstance('b-md')!.element;
    await vi.waitFor(() => expect(el.querySelector('.file-reader-markdown a')).not.toBeNull());
    el.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(addFileReaderSession).toHaveBeenCalledWith('B', '/b/README.md', undefined));
  });

  it('a selection in its body, in the sessions window document, survives a re-render', async () => {
    readFile.mockResolvedValue({ ok: true, content: '# Title\n\nsome text' });
    createFileReaderPane('b-md', '/b/docs/a.md');
    showFileReaderPane('b-md', false);
    const el = getFileReaderInstance('b-md')!.element;
    await vi.waitFor(() => expect(el.querySelector('.file-reader-markdown')).not.toBeNull());
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    childDoc.body.appendChild(el);
    const range = childDoc.createRange();
    range.selectNodeContents(el.querySelector('.file-reader-markdown p')!);
    childDoc.getSelection()!.addRange(range);

    [...el.querySelectorAll<HTMLButtonElement>('.search-toggle-btn')].find((b) => b.textContent === 'Raw')!.click();

    // Still the rendered body the user is selecting in: not wiped by the raw re-render.
    expect(el.querySelector('.file-reader-markdown')).not.toBeNull();
    iframe.remove();
  });

  it('"Open in Browser" opens the browser tab in B, with the path resolved against B', () => {
    createFileReaderPane('b-html', 'page.html');
    getFileReaderInstance('b-html')!.element.querySelector<HTMLButtonElement>('.file-reader-open-browser')!.click();
    expect(addBrowserTabSession).toHaveBeenCalledTimes(1);
    const [projectId, url] = addBrowserTabSession.mock.calls[0];
    expect(projectId).toBe('B');
    expect(url).toContain('/b/page.html');
  });
});
