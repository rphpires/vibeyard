// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// "Ask AI" on a selection in a diff pane of project B, shown in the sessions window
// (another document, another realm) while the main window's active project is A.

const { addPlanSession, setPendingPrompt, promptNewSession } = vi.hoisted(() => ({
  addPlanSession: vi.fn(() => ({ id: 'new-plan' })),
  setPendingPrompt: vi.fn(),
  promptNewSession: vi.fn(),
}));
const projectA = { id: 'A', sessions: [] };
const projectB = { id: 'B', sessions: [{ id: 'b-diff', type: 'diff-viewer' }] };

vi.mock('../state.js', () => ({
  appState: {
    get activeProject() { return projectA; },
    projectOfSession: (id: string) => (id === 'b-diff' ? projectB : undefined),
    addPlanSession,
  },
}));
vi.mock('./tab-bar.js', () => ({ promptNewSession }));
vi.mock('./terminal-pane.js', () => ({ setPendingPrompt }));
vi.mock('./file-viewer.js', () => ({ getFileViewerInstance: (id: string) => (id === 'b-diff' ? { filePath: 'src/x.ts' } : undefined) }));
vi.mock('./file-reader.js', () => ({ getFileReaderInstance: vi.fn() }));

const { attachFilePrompt } = await import('./file-prompt.js');

let iframe: HTMLIFrameElement;
let childDoc: Document;
let detach: () => void;

function diffPane(): { pane: HTMLElement; line: HTMLElement } {
  const pane = childDoc.createElement('div');
  pane.dataset.paneKind = 'file-viewer';
  pane.dataset.sessionId = 'b-diff';
  const body = childDoc.createElement('div');
  body.className = 'file-viewer-body';
  const line = childDoc.createElement('span');
  line.textContent = '+ added();';
  body.appendChild(line);
  pane.appendChild(body);
  childDoc.body.appendChild(pane);
  return { pane, line };
}

function selectIn(node: HTMLElement): void {
  const range = childDoc.createRange();
  range.selectNodeContents(node);
  const sel = childDoc.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

beforeEach(() => {
  vi.useFakeTimers();
  iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  childDoc = iframe.contentDocument!;
  const RangeProto = (iframe.contentWindow as unknown as { Range: typeof Range }).Range.prototype;
  const rect = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } as DOMRect;
  RangeProto.getClientRects = () => [rect] as unknown as DOMRectList;
  RangeProto.getBoundingClientRect = () => rect;
  detach = attachFilePrompt(childDoc);
});

afterEach(() => {
  detach();
  iframe.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('file prompt in the sessions window', () => {
  it('shows the bubble for a selection in that document and sends to the pane\'s own project', () => {
    const { pane, line } = diffPane();
    selectIn(line);
    line.dispatchEvent(new (iframe.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mouseup', { bubbles: true }));
    vi.runAllTimers();

    const bubble = pane.querySelector('.file-prompt-bubble') as HTMLButtonElement | null;
    expect(bubble).not.toBeNull();
    expect(bubble!.style.display).not.toBe('none');

    bubble!.click();
    const textarea = pane.querySelector('textarea')!;
    textarea.value = 'why?';
    textarea.dispatchEvent(new Event('input'));
    (pane.querySelector('.inspect-submit-btn') as HTMLButtonElement).click();

    expect(addPlanSession).toHaveBeenCalledWith('B', expect.any(String), true);
    expect(setPendingPrompt).toHaveBeenCalledWith('new-plan', expect.stringContaining('+ added();'));
  });

  it('opens the custom-session dialog for the pane\'s project, in its document', () => {
    const { pane, line } = diffPane();
    selectIn(line);
    line.dispatchEvent(new (iframe.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mouseup', { bubbles: true }));
    vi.runAllTimers();
    (pane.querySelector('.file-prompt-bubble') as HTMLButtonElement).click();
    const textarea = pane.querySelector('textarea')!;
    textarea.value = 'why?';
    textarea.dispatchEvent(new Event('input'));
    (pane.querySelector('.inspect-dropdown-btn') as HTMLButtonElement).click();

    expect(promptNewSession).toHaveBeenCalledWith(expect.any(Function), { projectId: 'B', doc: childDoc });
  });

  it('stops listening once detached', () => {
    detach();
    const { pane, line } = diffPane();
    selectIn(line);
    line.dispatchEvent(new (iframe.contentWindow as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent('mouseup', { bubbles: true }));
    vi.runAllTimers();
    expect(pane.querySelector('.file-prompt-bubble')).toBeNull();
    detach = () => {};
  });
});
