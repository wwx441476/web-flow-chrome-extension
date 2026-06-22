import type { RecordedStep, RecordedStepPayload } from '../types';
import { inferVariableName } from '../storage/variables';
import { findCaptchaImage, isGraphicCaptchaField } from './captcha';
import { buildSelector, isVisible } from './detect';
import { getElementLabel, getElementText } from './deep-query';

const HOST_ID = 'web-flow-chrome-recording-host';
const PANEL_ID = 'web-flow-chrome-recording-panel';
const PANEL_HEADER_ID = 'web-flow-chrome-recording-header';
const PANEL_BODY_ID = 'web-flow-chrome-recording-body';
const STOP_BTN_ID = 'web-flow-chrome-recording-stop';
const STOP_BTN_COMPACT_ID = 'web-flow-chrome-recording-stop-compact';
const MINIMIZE_BTN_ID = 'web-flow-chrome-recording-minimize';
const COUNT_ID = 'web-flow-chrome-recording-count';
const STATUS_ID = 'web-flow-chrome-recording-status';
const PANEL_POS_KEY = 'web-flow-chrome-recorder-panel-pos';
const PANEL_MIN_KEY = 'web-flow-chrome-recorder-panel-minimized';
const LISTENER_FLAG = '__webFlowRecorderListeners';

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

let recording = false;
let lastStepAt = 0;
let listenersAttached = false;
let navigationGuardAttached = false;
let stepCount = 0;
let startUrl = '';
let autoStopTriggered = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let panelMinimized = false;
let shadowRoot: ShadowRoot | null = null;

interface PanelPosition {
  left: number;
  top: number;
}

function readPanelPosition(): PanelPosition | null {
  try {
    const raw = sessionStorage.getItem(PANEL_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PanelPosition;
    if (Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
      return parsed;
    }
  } catch {
    // Ignore invalid saved position.
  }
  return null;
}

function savePanelPosition(left: number, top: number): void {
  try {
    sessionStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // Ignore quota errors.
  }
}

function readPanelMinimized(): boolean {
  return sessionStorage.getItem(PANEL_MIN_KEY) === '1';
}

function savePanelMinimized(minimized: boolean): void {
  try {
    sessionStorage.setItem(PANEL_MIN_KEY, minimized ? '1' : '0');
  } catch {
    // Ignore quota errors.
  }
}

function applyPanelPosition(panel: HTMLElement): void {
  const saved = readPanelPosition();
  if (saved) {
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
    panel.style.right = 'auto';
    return;
  }
  panel.style.right = '16px';
  panel.style.top = '16px';
  panel.style.left = 'auto';
}

function clampPanelPosition(left: number, top: number, panel: HTMLElement): PanelPosition {
  const rect = panel.getBoundingClientRect();
  const width = rect.width || panel.offsetWidth || 200;
  const height = rect.height || panel.offsetHeight || 60;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(8, window.innerHeight - height - 8);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top: Math.min(Math.max(8, top), maxTop),
  };
}

function attachPanelDrag(panel: HTMLElement, handle: HTMLElement): void {
  if (handle.dataset.dragBound === '1') return;
  handle.dataset.dragBound = '1';
  handle.style.cursor = 'move';
  handle.style.userSelect = 'none';

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const onMove = (event: MouseEvent): void => {
    if (!dragging) return;
    const next = clampPanelPosition(event.clientX - offsetX, event.clientY - offsetY, panel);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = 'auto';
  };

  const onUp = (): void => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    const left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      savePanelPosition(left, top);
    }
  };

  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button')) return;

    const rect = panel.getBoundingClientRect();
    dragging = true;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    panel.style.right = 'auto';
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });
}

function setPanelMinimized(minimized: boolean): void {
  panelMinimized = minimized;
  savePanelMinimized(minimized);

  const root = getShadowRoot();
  const panel = root.getElementById(PANEL_ID) as HTMLDivElement | null;
  const body = root.getElementById(PANEL_BODY_ID) as HTMLDivElement | null;
  const minimizeBtn = root.getElementById(MINIMIZE_BTN_ID) as HTMLButtonElement | null;
  const stopBtn = root.getElementById(STOP_BTN_ID) as HTMLButtonElement | null;
  const stopBtnCompact = root.getElementById(STOP_BTN_COMPACT_ID) as HTMLButtonElement | null;
  if (!panel || !body) return;

  body.style.display = minimized ? 'none' : 'block';
  panel.style.padding = minimized ? '8px 12px' : '12px 14px';
  if (minimizeBtn) {
    minimizeBtn.textContent = minimized ? '▢' : '—';
    minimizeBtn.title = minimized ? '展开' : '最小化';
  }
  if (stopBtn) {
    stopBtn.style.display = minimized ? 'none' : 'block';
  }
  if (stopBtnCompact) {
    stopBtnCompact.style.display = minimized ? 'inline-block' : 'none';
  }
}

function togglePanelMinimized(): void {
  setPanelMinimized(!panelMinimized);
}

function createPanelButton(text: string, options: { danger?: boolean; compact?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  Object.assign(button.style, {
    border: 'none',
    background: options.danger ? '#dc2626' : '#374151',
    color: '#fff',
    padding: options.compact ? '4px 8px' : '6px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: options.compact ? '11px' : '12px',
    flexShrink: '0',
    lineHeight: '1.2',
  });
  return button;
}

function stepLabel(element: Element): string {
  const text = getElementText(element);
  if (text) return text.slice(0, 20);
  return getElementLabel(element).slice(0, 20) || element.tagName.toLowerCase();
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
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(host);
  }

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  return shadowRoot;
}

function updateStepCount(count: number): void {
  stepCount = count;
  if (!isTopFrame()) return;
  const counter = getShadowRoot().getElementById(COUNT_ID);
  if (counter) {
    counter.textContent = String(count);
  }
}

function setPanelStatus(text: string): void {
  if (!isTopFrame()) return;
  const status = getShadowRoot().getElementById(STATUS_ID);
  if (status) {
    status.textContent = text;
  }
}

async function syncStepCountFromBackground(): Promise<number> {
  try {
    const status = (await chrome.runtime.sendMessage({
      action: 'CHECK_RECORDING',
    })) as { recording?: boolean; stepCount?: number } | undefined;

    if (typeof status?.stepCount === 'number') {
      updateStepCount(status.stepCount);
      return status.stepCount;
    }
  } catch {
    // Extension may be reloading.
  }
  return stepCount;
}

function startSyncTimer(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (!recording) return;
    void syncStepCountFromBackground();
  }, 1000);
}

function stopSyncTimer(): void {
  if (!syncTimer) return;
  clearInterval(syncTimer);
  syncTimer = null;
}

function appendStep(step: RecordedStep): void {
  const now = Date.now();
  const delayMs = lastStepAt > 0 ? Math.min(now - lastStepAt, 3000) : 0;
  lastStepAt = now;

  const withDelay: RecordedStep =
    step.type === 'wait' ? step : { ...step, delayMs: delayMs || undefined };

  updateStepCount(stepCount + 1);

  void chrome.runtime
    .sendMessage({
      type: 'APPEND_RECORDED_STEP',
      step: withDelay,
    })
    .then((response: { steps?: RecordedStep[] } | undefined) => {
      if (response?.steps) {
        updateStepCount(response.steps.length);
      }
    })
    .catch(() => {
      void syncStepCountFromBackground();
    });
}

function isPanelTarget(target: Element): boolean {
  const host = document.getElementById(HOST_ID);
  if (!host) return false;
  return host.contains(target) || Boolean(host.shadowRoot?.contains(target));
}

function shouldSkipClick(target: Element): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (!isVisible(target)) return true;
  if (isPanelTarget(target)) return true;
  return false;
}

function recordFillFromElement(target: HTMLInputElement | HTMLTextAreaElement): void {
  if (!recording || !isVisible(target) || !target.value.trim()) return;

  if (isGraphicCaptchaField(target)) {
    const captchaImage = findCaptchaImage(target);
    appendStep({
      type: 'fill',
      fillKind: 'captcha',
      selector: buildSelector(target),
      imageSelector: captchaImage ? buildSelector(captchaImage) : undefined,
      label: stepLabel(target),
    });
    return;
  }

  if (target instanceof HTMLInputElement && target.type === 'password') {
    appendStep({
      type: 'fill',
      fillKind: 'variable',
      variableName: 'password',
      selector: buildSelector(target),
      label: stepLabel(target),
    });
    return;
  }

  const variableName = inferVariableName(target);
  appendStep({
    type: 'fill',
    fillKind: 'variable',
    variableName,
    selector: buildSelector(target),
    label: stepLabel(target),
  });
}

function onDblClick(event: MouseEvent): void {
  if (!recording) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  if (shouldSkipClick(target)) return;

  const clickable =
    target.closest(
      'button, a, input, textarea, input[type="submit"], input[type="button"], [role="button"], [role="menuitem"], [role="tab"], [contenteditable="true"], [onclick], [ng-click], li, span, div',
    ) ?? target;

  if (!(clickable instanceof HTMLElement) || !isVisible(clickable)) return;

  appendStep({
    type: 'dblclick',
    selector: buildSelector(clickable),
    label: stepLabel(clickable),
  });
}

function onClick(event: MouseEvent): void {
  if (!recording) return;

  const target = event.target;
  if (!(target instanceof Element)) return;
  if (shouldSkipClick(target)) return;

  const clickable =
    target.closest(
      'button, a, input, textarea, input[type="submit"], input[type="button"], [role="button"], [role="menuitem"], [role="tab"], [contenteditable="true"], [onclick], [ng-click], li, span, div',
    ) ?? target;

  if (!(clickable instanceof HTMLElement) || !isVisible(clickable)) return;

  appendStep({
    type: 'click',
    selector: buildSelector(clickable),
    label: stepLabel(clickable),
  });
}

function onInput(event: Event): void {
  if (!recording) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  recordFillFromElement(target);
}

function onChange(event: Event): void {
  if (!recording) return;
  const target = event.target;
  if (target instanceof HTMLSelectElement) {
    if (!isVisible(target) || isPanelTarget(target)) return;
    const selected = target.options[target.selectedIndex];
    appendStep({
      type: 'select',
      selector: buildSelector(target),
      value: target.value,
      optionText: selected?.text.trim(),
      label: stepLabel(target),
    });
    return;
  }
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  recordFillFromElement(target);
}

function onFocusIn(event: FocusEvent): void {
  if (!recording) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (!isVisible(target) || isPanelTarget(target)) return;

  appendStep({
    type: 'click',
    selector: buildSelector(target),
    label: stepLabel(target),
  });
}

function attachListeners(): void {
  const scope = window as typeof window & { [LISTENER_FLAG]?: boolean };
  if (listenersAttached || scope[LISTENER_FLAG]) return;
  document.addEventListener('click', onClick, true);
  document.addEventListener('dblclick', onDblClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('focusin', onFocusIn, true);
  listenersAttached = true;
  scope[LISTENER_FLAG] = true;
}

function detachListeners(): void {
  if (!listenersAttached) return;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('dblclick', onDblClick, true);
  document.removeEventListener('input', onInput, true);
  document.removeEventListener('change', onChange, true);
  document.removeEventListener('focusin', onFocusIn, true);
  listenersAttached = false;
  delete (window as typeof window & { [LISTENER_FLAG]?: boolean })[LISTENER_FLAG];
}

function stopFromPage(): void {
  void chrome.runtime.sendMessage({ action: 'STOP_RECORDING_FROM_PAGE' });
}

function maybeAutoStopAfterNavigation(): void {
  if (!recording || autoStopTriggered) return;

  void syncStepCountFromBackground().then((count) => {
    if (!recording || autoStopTriggered || count === 0) return;

    const urlChanged = location.href !== startUrl;
    if (!urlChanged || count < 2) {
      return;
    }

    autoStopTriggered = true;
    setPanelStatus(`页面已跳转，${count} 步已保存，正在完成录制...`);
    window.setTimeout(() => {
      stopFromPage();
    }, 1800);
  });
}

function onNavigation(): void {
  if (!recording) return;
  if (isTopFrame()) {
    showPanel(stepCount);
    void syncStepCountFromBackground();
  }
  maybeAutoStopAfterNavigation();
}

function attachNavigationGuard(): void {
  if (navigationGuardAttached) return;
  window.addEventListener('hashchange', onNavigation);
  window.addEventListener('popstate', onNavigation);
  navigationGuardAttached = true;
}

function detachNavigationGuard(): void {
  if (!navigationGuardAttached) return;
  window.removeEventListener('hashchange', onNavigation);
  window.removeEventListener('popstate', onNavigation);
  navigationGuardAttached = false;
}

function showPanel(initialCount = 0): void {
  if (!isTopFrame()) return;

  const root = getShadowRoot();
  let panel = root.getElementById(PANEL_ID) as HTMLDivElement | null;

  if (!panel) {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      zIndex: '2147483647',
      background: '#111827',
      color: '#fff',
      borderRadius: '12px',
      fontSize: '14px',
      boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      display: 'flex',
      flexDirection: 'column',
      gap: '0',
      pointerEvents: 'auto',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      maxWidth: '360px',
      minWidth: '180px',
      border: '2px solid #dc2626',
      padding: '12px 14px',
    });
    applyPanelPosition(panel);

    const header = document.createElement('div');
    header.id = PANEL_HEADER_ID;
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    });

    const title = document.createElement('span');
    title.style.flex = '1';
    title.style.fontWeight = '600';
    title.style.fontSize = '13px';
    title.innerHTML = '🔴 录制 <span id="' + COUNT_ID + '">0</span> 步';

    const minimizeBtn = createPanelButton('—', { compact: true });
    minimizeBtn.id = MINIMIZE_BTN_ID;
    minimizeBtn.title = '最小化';
    minimizeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePanelMinimized();
    });

    const stopBtnCompact = createPanelButton('完成', { danger: true, compact: true });
    stopBtnCompact.id = STOP_BTN_COMPACT_ID;
    stopBtnCompact.title = '完成录制';
    stopBtnCompact.style.display = 'none';
    stopBtnCompact.addEventListener('click', (event) => {
      event.stopPropagation();
      stopFromPage();
    });

    header.appendChild(title);
    header.appendChild(minimizeBtn);
    header.appendChild(stopBtnCompact);
    attachPanelDrag(panel, header);

    const body = document.createElement('div');
    body.id = PANEL_BODY_ID;

    const status = document.createElement('span');
    status.id = STATUS_ID;
    status.style.display = 'block';
    status.style.fontSize = '12px';
    status.style.color = '#d1d5db';
    status.style.marginTop = '6px';
    status.textContent = '拖动标题栏可移动 · 在页面上完成你的操作';

    const stopBtn = createPanelButton('完成录制', { danger: true });
    stopBtn.id = STOP_BTN_ID;
    stopBtn.style.width = '100%';
    stopBtn.style.marginTop = '8px';
    stopBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      stopFromPage();
    });

    body.appendChild(status);
    body.appendChild(stopBtn);
    panel.appendChild(header);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  updateStepCount(initialCount);
  setPanelMinimized(readPanelMinimized());
}

function hidePanel(): void {
  if (!isTopFrame()) return;
  getShadowRoot().getElementById(PANEL_ID)?.remove();
}

export function startRecording(initialStepCount = 0): void {
  recording = true;
  lastStepAt = 0;
  stepCount = initialStepCount;
  autoStopTriggered = false;
  startUrl = location.href;
  attachListeners();
  attachNavigationGuard();

  if (isTopFrame()) {
    showPanel(initialStepCount);
    startSyncTimer();
    void syncStepCountFromBackground();
  }
}

export function stopRecording(): void {
  recording = false;
  autoStopTriggered = false;
  stopSyncTimer();
  detachListeners();
  detachNavigationGuard();
  hidePanel();
}

export function isRecording(): boolean {
  return recording;
}

export function handleRuntimeMessage(message: { type?: string; count?: number }): boolean {
  if (message.type === 'RECORDING_STARTED') {
    startRecording(0);
    return true;
  }
  if (message.type === 'RECORDING_RESUMED' && typeof message.count === 'number') {
    startRecording(message.count);
    return true;
  }
  if (message.type === 'RECORDING_STOPPED') {
    stopRecording();
    return true;
  }
  if (message.type === 'RECORDING_STEP_UPDATED' && typeof message.count === 'number') {
    if (!recording) {
      startRecording(message.count);
    } else if (isTopFrame()) {
      updateStepCount(message.count);
    } else {
      stepCount = message.count;
    }
    return true;
  }
  return false;
}

export async function restoreRecordingIfNeeded(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({
      action: 'CHECK_RECORDING',
    })) as { recording?: boolean; stepCount?: number } | undefined;
    if (status?.recording) {
      startRecording(status.stepCount ?? 0);
    }
  } catch {
    // Ignore when extension is reloading.
  }
}

export type { RecordedStepPayload };
