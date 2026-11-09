// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { installDocChrome } from './doc-chrome';

function makeSource(): Document {
  const src = document.implementation.createHTMLDocument('src');
  const base = src.createElement('base');
  base.href = 'file:///app/dist/renderer/index.html';
  src.head.appendChild(base);
  const link = src.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('href', 'styles.css');
  src.head.appendChild(link);
  const meta = src.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = "default-src 'self'";
  src.head.appendChild(meta);
  src.documentElement.dataset.theme = 'dark';
  const overlay = src.createElement('div');
  overlay.id = 'modal-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML = '<div id="modal"><div id="modal-title"></div><div id="modal-body"></div><div id="modal-actions"><button id="modal-cancel">Cancel</button><button id="modal-confirm">Create</button></div></div>';
  src.body.appendChild(overlay);
  return src;
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

describe('installDocChrome', () => {
  it('copies stylesheet links with absolute hrefs', () => {
    const src = makeSource();
    const target = document.implementation.createHTMLDocument('t');
    cleanups.push(installDocChrome(target, src));
    const link = target.head.querySelector('link[rel="stylesheet"]') as HTMLLinkElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe(new URL('styles.css', src.baseURI).href);
  });

  it('copies the CSP meta', () => {
    const src = makeSource();
    const target = document.implementation.createHTMLDocument('t');
    cleanups.push(installDocChrome(target, src));
    const meta = target.head.querySelector('meta[http-equiv="Content-Security-Policy"]') as HTMLMetaElement;
    expect(meta.content).toBe("default-src 'self'");
  });

  it('mirrors theme and follows later changes on the source', async () => {
    const src = makeSource();
    const target = document.implementation.createHTMLDocument('t');
    cleanups.push(installDocChrome(target, src));
    expect(target.documentElement.dataset.theme).toBe('dark');
    src.documentElement.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 0));
    expect(target.documentElement.dataset.theme).toBe('light');
  });

  it('injects the modal overlay markup cloned from the source', () => {
    const src = makeSource();
    const target = document.implementation.createHTMLDocument('t');
    cleanups.push(installDocChrome(target, src));
    const overlay = target.getElementById('modal-overlay')!;
    expect(overlay).toBeTruthy();
    expect(overlay.outerHTML).toBe(src.getElementById('modal-overlay')!.outerHTML);
    expect(overlay.ownerDocument).toBe(target);
  });

  it('cleanup stops the theme observer', async () => {
    const src = makeSource();
    const target = document.implementation.createHTMLDocument('t');
    const cleanup = installDocChrome(target, src);
    cleanup();
    src.documentElement.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 0));
    expect(target.documentElement.dataset.theme).toBe('dark');
  });
});
