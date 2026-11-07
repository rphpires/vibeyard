/**
 * Run `cb` on the next frame of the window that owns `doc`.
 *
 * The sessions window is driven from the main renderer, so a bare
 * `requestAnimationFrame` there waits on the *main* window's frames — which stop
 * while main is minimized or covered, leaving a sessions-window PTY unspawned or
 * a dialog unfocused. A document without its own window (or the main document)
 * uses the global one.
 */
export function requestFrameIn(doc: Document, cb: FrameRequestCallback): void {
  const win = doc === document ? null : doc.defaultView;
  if (win && typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(cb);
  else requestAnimationFrame(cb);
}
