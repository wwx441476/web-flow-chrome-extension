type QueryRoot = Document | ShadowRoot;

function collectShadowRoots(root: QueryRoot, results: ShadowRoot[]): void {
  const elements = Array.from(root.querySelectorAll('*'));
  for (const element of elements) {
    if (element.shadowRoot) {
      results.push(element.shadowRoot);
      collectShadowRoots(element.shadowRoot, results);
    }
  }
}

function getSameOriginDocuments(): Document[] {
  const documents: Document[] = [document];
  const iframes = Array.from(document.querySelectorAll('iframe'));

  for (const iframe of iframes) {
    try {
      const iframeDoc = iframe.contentDocument;
      if (iframeDoc) {
        documents.push(iframeDoc);
      }
    } catch {
      // Cross-origin iframe — skip
    }
  }

  return documents;
}

export function getSearchRoots(): QueryRoot[] {
  const roots: QueryRoot[] = [];

  for (const doc of getSameOriginDocuments()) {
    roots.push(doc);
    const shadowRoots: ShadowRoot[] = [];
    collectShadowRoots(doc, shadowRoots);
    roots.push(...shadowRoots);
  }

  return roots;
}

export function queryAllDeep<T extends Element>(selector: string): T[] {
  const seen = new Set<Element>();
  const results: T[] = [];

  for (const root of getSearchRoots()) {
    for (const element of Array.from(root.querySelectorAll<T>(selector))) {
      if (!seen.has(element)) {
        seen.add(element);
        results.push(element);
      }
    }
  }

  return results;
}

export function queryDeep<T extends Element>(selector: string): T | null {
  const matches = queryAllDeep<T>(selector);
  return matches[0] ?? null;
}

/** Hit-test through open shadow roots and same-origin iframes. */
export function deepElementFromPoint(
  x: number,
  y: number,
  root: Document | ShadowRoot = document,
): Element | null {
  const element = root.elementFromPoint(x, y);
  if (!element) return null;

  if (element.shadowRoot) {
    const inner = deepElementFromPoint(x, y, element.shadowRoot);
    if (inner) return inner;
  }

  if (element instanceof HTMLIFrameElement) {
    try {
      const frameDoc = element.contentDocument;
      if (frameDoc) {
        const rect = element.getBoundingClientRect();
        const inner = deepElementFromPoint(x - rect.left, y - rect.top, frameDoc);
        if (inner) return inner;
      }
    } catch {
      // Cross-origin iframe — handled by that frame's own content script.
    }
  }

  return element;
}

export function findElementDeep(
  selector: string,
  predicate?: (element: HTMLElement) => boolean,
): HTMLElement | null {
  const matches = queryAllDeep<HTMLElement>(selector);
  for (const element of matches) {
    if (!predicate || predicate(element)) {
      return element;
    }
  }
  return null;
}

export function getElementLabel(element: Element): string {
  const parts = [
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('title') ?? '',
  ];

  if (element instanceof HTMLInputElement) {
    parts.push(element.labels?.[0]?.textContent ?? '');
  }

  return parts.join(' ').trim();
}

export function getElementText(element: Element): string {
  return (element.textContent ?? element.getAttribute('value') ?? '').trim();
}
