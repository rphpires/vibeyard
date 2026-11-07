/**
 * Bootstraps a secondary document (e.g. the session window, an about:blank
 * window sharing this JS context) with the chrome the shared UI components
 * expect: stylesheets, CSP, theme and the modal overlay markup.
 *
 * Returns a cleanup that stops following the source's theme.
 */
export function installDocChrome(target: Document, source: Document): () => void {
  // Stylesheets: about:blank has no base URL of its own, so hrefs must be absolute.
  for (const link of Array.from(source.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const copy = target.createElement('link');
    copy.rel = 'stylesheet';
    try {
      copy.href = new URL(href, source.baseURI).href;
    } catch {
      copy.href = href; // source has no resolvable base (e.g. about:blank)
    }
    target.head.appendChild(copy);
  }

  const csp = source.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (csp) target.head.appendChild(target.importNode(csp, true));

  const syncTheme = (): void => {
    const theme = source.documentElement.dataset.theme;
    if (theme === undefined) delete target.documentElement.dataset.theme;
    else target.documentElement.dataset.theme = theme;
  };
  syncTheme();
  const observer = new MutationObserver(syncTheme);
  observer.observe(source.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // Cloned (not duplicated as a string) so it cannot drift from index.html.
  const overlay = source.getElementById('modal-overlay');
  if (overlay && !target.getElementById('modal-overlay')) {
    const copy = target.importNode(overlay, true) as HTMLElement;
    copy.classList.add('hidden');
    target.body.appendChild(copy);
  }

  return () => observer.disconnect();
}
