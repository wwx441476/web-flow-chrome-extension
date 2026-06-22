import { buildSelector, isVisible } from './detect';
import { queryAllDeep } from './deep-query';
import type { SnapshotElement, PageSnapshot } from '../llm/types';

const MAX_ELEMENTS = 48;
const INTERACTIVE_SELECTOR =
  'input:not([type="hidden"]), textarea, button, a[href], select, [role="button"], [role="link"], [role="textbox"], [role="combobox"]';

function elementLabel(element: Element): string {
  const parts = [
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('title') ?? '',
    element.textContent?.trim().slice(0, 40) ?? '',
  ];

  if (element instanceof HTMLInputElement) {
    parts.push(element.labels?.[0]?.textContent?.trim() ?? '');
  }

  const joined = parts.filter(Boolean).join(' | ');
  return joined.slice(0, 80) || element.tagName.toLowerCase();
}

function isUsefulInteractive(element: Element): boolean {
  if (!isVisible(element)) return false;

  if (element instanceof HTMLAnchorElement) {
    const href = element.getAttribute('href');
    if (!href || href.startsWith('javascript:')) return false;
  }

  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === 'hidden' || type === 'file') return false;
  }

  const label = elementLabel(element);
  if (label.length < 1 && element.tagName !== 'INPUT') return false;

  return true;
}

export function buildPageSnapshot(): PageSnapshot {
  const candidates = queryAllDeep<Element>(INTERACTIVE_SELECTOR).filter(isUsefulInteractive);
  const elements: SnapshotElement[] = [];

  for (let index = 0; index < candidates.length && elements.length < MAX_ELEMENTS; index += 1) {
    const element = candidates[index];
    const ref = `el-${elements.length + 1}`;
    const tag = element.tagName.toLowerCase();
    const type =
      element instanceof HTMLInputElement ? element.type || 'text' : undefined;
    const role = element.getAttribute('role') ?? undefined;

    elements.push({
      ref,
      tag,
      type,
      label: elementLabel(element),
      selector: buildSelector(element),
      role,
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    elements,
  };
}

export function findSnapshotElement(snapshot: PageSnapshot, ref?: string): SnapshotElement | null {
  if (!ref) return null;
  return snapshot.elements.find((el) => el.ref === ref) ?? null;
}
