import { buildSelector, isVisible } from './detect';
import { deepElementFromPoint, getElementLabel, getElementText } from './deep-query';
import { handleReplayPanelPickerEnd } from './replay-panel';

const HOST_ID = 'webflow-picker-host';
const OVERLAY_HOST_IDS = [
  HOST_ID,
  'web-flow-chrome-replay-host',
  'web-flow-chrome-manual-host',
  'web-flow-chrome-recording-host',
];
const HIGHLIGHT_ID = 'webflow-picker-highlight';
const HINT_ID = 'webflow-picker-hint';

let picking = false;
let shadowRoot: ShadowRoot | null = null;
let highlighted: Element | null = null;

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

function getShadowRoot(): ShadowRoot {
  if (shadowRoot) {
    return shadowRoot;
  }

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(host);
  }

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadowRoot.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = `
      #${HIGHLIGHT_ID} {
        position: fixed;
        border: 2px solid #2563eb;
        background: rgba(37, 99, 235, 0.12);
        border-radius: 4px;
        pointer-events: none;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.6);
        transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
      }
      #${HINT_ID} {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        background: #1e3a8a;
        color: #fff;
        padding: 10px 16px;
        border-radius: 999px;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        white-space: nowrap;
        pointer-events: none;
      }
    `;
    shadowRoot.appendChild(style);
  }

  return shadowRoot;
}

function ensureHighlightBox(): HTMLDivElement {
  const root = getShadowRoot();
  let box = root.getElementById(HIGHLIGHT_ID) as HTMLDivElement | null;
  if (!box) {
    box = document.createElement('div');
    box.id = HIGHLIGHT_ID;
    root.appendChild(box);
  }
  return box;
}

function ensureHint(): HTMLDivElement {
  const root = getShadowRoot();
  let hint = root.getElementById(HINT_ID) as HTMLDivElement | null;
  if (!hint) {
    hint = document.createElement('div');
    hint.id = HINT_ID;
    hint.textContent = '移动鼠标到目标元素，点击拾取 · Esc 取消';
    root.appendChild(hint);
  }
  return hint;
}

function positionHighlight(element: Element): void {
  const rect = element.getBoundingClientRect();
  const box = ensureHighlightBox();
  box.style.display = 'block';
  box.style.top = `${rect.top}px`;
  box.style.left = `${rect.left}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function clearHighlight(): void {
  highlighted = null;
  getShadowRoot().getElementById(HIGHLIGHT_ID)?.style.setProperty('display', 'none');
}

function isExtensionOverlay(element: Element): boolean {
  return OVERLAY_HOST_IDS.some((id) => element.id === id || element.closest(`#${id}`) !== null);
}

function resolveTarget(raw: Element | null): Element | null {
  if (!raw || !isVisible(raw)) return null;
  if (isExtensionOverlay(raw)) return null;

  const interactive = raw.closest(
    'a, button, input, textarea, select, label, [role="button"], [contenteditable="true"], img, h1, h2, h3, h4, h5, h6, p, span, div, li, td, th',
  );
  return interactive ?? raw;
}

function collectOverlayHosts(): HTMLElement[] {
  return OVERLAY_HOST_IDS.map((id) => document.getElementById(id)).filter(
    (element): element is HTMLElement => element !== null,
  );
}

function elementAtPoint(event: MouseEvent): Element | null {
  const overlays = collectOverlayHosts();
  const prevPointerEvents = overlays.map((element) => element.style.pointerEvents);
  overlays.forEach((element) => {
    element.style.pointerEvents = 'none';
  });

  try {
    const fromPoint = deepElementFromPoint(event.clientX, event.clientY);
    if (fromPoint && !isExtensionOverlay(fromPoint)) {
      return fromPoint;
    }

    for (const node of event.composedPath()) {
      if (node instanceof Element && !isExtensionOverlay(node)) {
        return node;
      }
    }

    const target = event.target instanceof Element ? event.target : null;
    return target && !isExtensionOverlay(target) ? target : null;
  } finally {
    overlays.forEach((element, index) => {
      element.style.pointerEvents = prevPointerEvents[index];
    });
  }
}

function onMouseMove(event: MouseEvent): void {
  if (!picking) return;
  const target = resolveTarget(elementAtPoint(event));
  if (!target || target === highlighted) return;
  highlighted = target;
  positionHighlight(target);
}

function onClick(event: MouseEvent): void {
  if (!picking) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const target = resolveTarget(elementAtPoint(event));
  if (!target) return;

  void finishPick(target);
}

function onKeyDown(event: KeyboardEvent): void {
  if (!picking || event.key !== 'Escape') return;
  event.preventDefault();
  stopElementPicker();
  handleReplayPanelPickerEnd(undefined);
  void chrome.runtime.sendMessage({ type: 'ELEMENT_PICKER_CANCELLED' });
}

async function finishPick(element: Element): Promise<void> {
  const selector = buildSelector(element);
  const text = getElementText(element);
  const label = (text || getElementLabel(element)).slice(0, 30) || element.tagName.toLowerCase();

  stopElementPicker();
  handleReplayPanelPickerEnd({ selector, label });

  try {
    await chrome.runtime.sendMessage({
      type: 'ELEMENT_PICKED',
      selector,
      label,
    });
  } catch {
    // Extension may be reloading.
  }
}

function attachListeners(): void {
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

function detachListeners(): void {
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKeyDown, true);
}

function teardownUi(): void {
  clearHighlight();
  document.getElementById(HOST_ID)?.remove();
  shadowRoot = null;
}

export function startElementPicker(): void {
  if (picking) return;

  picking = true;
  if (isTopFrame()) {
    ensureHint();
  }
  attachListeners();
  document.documentElement.style.cursor = 'crosshair';
}

export function stopElementPicker(): void {
  if (!picking) return;
  picking = false;
  detachListeners();
  document.documentElement.style.cursor = '';
  teardownUi();
}

export function isElementPicking(): boolean {
  return picking;
}

export function handleElementPickerMessage(message: { action?: string }): boolean {
  if (message.action === 'START_ELEMENT_PICKER') {
    startElementPicker();
    return true;
  }
  if (message.action === 'STOP_ELEMENT_PICKER') {
    stopElementPicker();
    return true;
  }
  return false;
}
