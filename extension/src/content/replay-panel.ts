import type { FillResult, RecordedStep, ReplayProgressStatus } from '../types';
import type { ReplaySessionSnapshot } from '../storage/replay-session-storage';
import { describeActionStep } from '../actions/describe';
import {
  autoStartManualLoginIfNeeded,
  canEditSelector,
  clearReplaySession,
  getReplayFlow,
  getReplaySession,
  initReplaySession,
  isSessionRunning,
  patchStepFields,
  persistFlowToDraft,
  persistReplaySession,
  restoreReplaySession,
  resolvePendingNavigationStep,
  resumeWaitingManualLogin,
  retryStep,
  runAllRemaining,
  runNextStep,
  stepEditableSelector,
  type ReplaySessionCallbacks,
  type StepStatus,
  updateReplayStep,
} from './replay-session';
import { hideManualLoginPanel, isManualLoginPanelActive } from './manual-login-panel';

const HOST_ID = 'web-flow-chrome-replay-host';
const PANEL_ID = 'web-flow-chrome-replay-panel';
const HEADER_ID = 'web-flow-chrome-replay-header';
const BODY_ID = 'web-flow-chrome-replay-body';
const LIST_ID = 'web-flow-chrome-replay-list';
const COUNTER_ID = 'web-flow-chrome-replay-counter';
const FOOTER_ID = 'web-flow-chrome-replay-footer';
const TOOLBAR_ID = 'web-flow-chrome-replay-toolbar';
const EDITOR_ID = 'web-flow-chrome-replay-editor';
const POS_KEY = 'web-flow-chrome-replay-panel-pos';
const MIN_KEY = 'web-flow-chrome-replay-panel-minimized';

let shadowRoot: ShadowRoot | null = null;
let flow: RecordedStep[] = [];
let statuses: StepStatus[] = [];
let panelMinimized = false;
let selectedIndex: number | null = null;
let editorOpen = false;
let pickerListenerBound = false;
let pickerActive = false;
let executingActive = false;
let minimizedBeforePick = false;
let navigationGuardAttached = false;

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

interface PanelPosition {
  left: number;
  top: number;
}

function readPanelPosition(): PanelPosition | null {
  try {
    const raw = sessionStorage.getItem(POS_KEY);
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
    sessionStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    // Ignore quota errors.
  }
}

function readPanelMinimized(): boolean {
  return sessionStorage.getItem(MIN_KEY) === '1';
}

function savePanelMinimized(minimized: boolean): void {
  try {
    sessionStorage.setItem(MIN_KEY, minimized ? '1' : '0');
  } catch {
    // Ignore quota errors.
  }
}

function applyPanelPosition(panel: HTMLElement): void {
  const saved = readPanelPosition();
  if (saved) {
    panel.style.left = `${saved.left}px`;
    panel.style.top = `${saved.top}px`;
    return;
  }
  panel.style.left = '16px';
  panel.style.top = '72px';
}

function clampPanelPosition(left: number, top: number, panel: HTMLElement): PanelPosition {
  const rect = panel.getBoundingClientRect();
  const width = rect.width || panel.offsetWidth || 260;
  const height = rect.height || panel.offsetHeight || 120;
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
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });
}

function flowStepLabel(step: RecordedStep, index: number): string {
  return describeActionStep(step, index).replace(/^\d+\.\s*/, '');
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
      zIndex: '2147483646',
      pointerEvents: 'none',
    });
    document.documentElement.appendChild(host);
  }

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadowRoot.querySelector('style')) {
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      #${PANEL_ID} {
        position: fixed;
        width: 300px;
        max-height: min(520px, calc(100vh - 24px));
        background: #ffffff;
        color: #1f2937;
        border-radius: 12px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
        border: 1px solid #e5e7eb;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #${HEADER_ID} {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 10px 12px;
        background: #eff6ff;
        border-bottom: 1px solid #dbeafe;
      }
      #${HEADER_ID} .title {
        flex: 1;
        font-weight: 600;
        font-size: 13px;
        color: #1d4ed8;
      }
      #${COUNTER_ID} {
        font-size: 11px;
        color: #2563eb;
        font-weight: 600;
      }
      .panel-btn {
        border: none;
        background: #dbeafe;
        color: #1d4ed8;
        width: 22px;
        height: 22px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        padding: 0;
        flex-shrink: 0;
      }
      .panel-btn:hover { background: #bfdbfe; }
      .panel-btn.close { color: #dc2626; background: #fee2e2; }
      .panel-btn.close:hover { background: #fecaca; }
      #${BODY_ID} { display: flex; flex-direction: column; min-height: 0; }
      #${LIST_ID} {
        overflow-y: auto;
        max-height: 220px;
        padding: 8px 10px;
      }
      .step-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 6px;
        border-radius: 8px;
        margin-bottom: 2px;
        cursor: pointer;
      }
      .step-row:hover { background: #f9fafb; }
      .step-row.selected { background: #eff6ff; box-shadow: inset 0 0 0 1px #93c5fd; }
      .step-row.running { background: #eff6ff; color: #1d4ed8; }
      .step-row.success { color: #059669; }
      .step-row.failed { background: #fef2f2; color: #dc2626; }
      .step-label {
        flex: 1;
        min-width: 0;
        word-break: break-word;
        line-height: 1.35;
      }
      .step-icon {
        flex-shrink: 0;
        width: 18px;
        text-align: center;
        font-weight: 700;
      }
      .step-icon.running { animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }
      #${TOOLBAR_ID} {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid #f3f4f6;
      }
      .action-btn {
        border: none;
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        flex: 1;
        min-width: calc(50% - 3px);
      }
      .action-btn.primary { background: #2563eb; color: #fff; }
      .action-btn.primary:hover { background: #1d4ed8; }
      .action-btn.primary:disabled { background: #93c5fd; cursor: not-allowed; }
      .action-btn.secondary { background: #f3f4f6; color: #374151; }
      .action-btn.secondary:hover { background: #e5e7eb; }
      .action-btn.secondary:disabled { opacity: 0.5; cursor: not-allowed; }
      #${EDITOR_ID} {
        display: none;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid #e5e7eb;
        background: #f9fafb;
      }
      #${EDITOR_ID}.open { display: flex; }
      .editor-label {
        font-size: 11px;
        color: #6b7280;
        font-weight: 600;
      }
      .editor-input {
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 11px;
      }
      .selector-row {
        display: flex;
        gap: 6px;
      }
      .selector-row .editor-input { flex: 1; min-width: 0; }
      .pick-btn {
        border: none;
        border-radius: 6px;
        background: #e5e7eb;
        color: #374151;
        padding: 0 8px;
        font-size: 11px;
        cursor: pointer;
        flex-shrink: 0;
      }
      .pick-btn:hover { background: #d1d5db; }
      .editor-actions {
        display: flex;
        gap: 6px;
      }
      .editor-actions .action-btn { min-width: 0; flex: 1; }
      #${FOOTER_ID} {
        padding: 8px 12px 10px;
        border-top: 1px solid #f3f4f6;
        color: #6b7280;
        font-size: 11px;
        line-height: 1.4;
      }
      #${FOOTER_ID}.success { color: #059669; }
      #${FOOTER_ID}.failed { color: #dc2626; }
    `;
    shadowRoot.appendChild(style);
  }

  return shadowRoot;
}

function createPanelButton(text: string, className = ''): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.className = `panel-btn ${className}`.trim();
  return button;
}

function createActionButton(text: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.className = `action-btn ${className}`.trim();
  return button;
}

function setPanelMinimized(minimized: boolean): void {
  panelMinimized = minimized;
  savePanelMinimized(minimized);

  const root = getShadowRoot();
  const body = root.getElementById(BODY_ID);
  const minimizeBtn = root.querySelector('.panel-btn.minimize') as HTMLButtonElement | null;
  if (!body) return;

  body.style.display = minimized ? 'none' : 'flex';
  if (minimizeBtn) {
    minimizeBtn.textContent = minimized ? '▢' : '—';
    minimizeBtn.title = minimized ? '展开' : '最小化';
  }
}

function updateCounter(): void {
  const root = getShadowRoot();
  const counter = root.getElementById(COUNTER_ID);
  if (!counter || flow.length === 0) return;

  const session = getReplaySession();
  if (session) {
    const cursor = Math.min(session.nextIndex + 1, flow.length);
    counter.textContent = `${cursor}/${flow.length}`;
    return;
  }

  const done = statuses.filter((status) => status === 'success').length;
  const runningIndex = statuses.findIndex((status) => status === 'running');
  if (runningIndex >= 0) {
    counter.textContent = `${runningIndex + 1}/${flow.length}`;
    return;
  }
  counter.textContent = `${done}/${flow.length}`;
}

function setFooter(text: string, tone: 'default' | 'success' | 'failed' = 'default'): void {
  const footer = getShadowRoot().getElementById(FOOTER_ID);
  if (!footer) return;
  footer.textContent = text;
  footer.className = tone;
}

function updateToolbarState(): void {
  const root = getShadowRoot();
  const nextBtn = root.querySelector('[data-action="next"]') as HTMLButtonElement | null;
  const runAllBtn = root.querySelector('[data-action="run-all"]') as HTMLButtonElement | null;
  const editBtn = root.querySelector('[data-action="edit"]') as HTMLButtonElement | null;
  const saveBtn = root.querySelector('[data-action="save"]') as HTMLButtonElement | null;

  const session = getReplaySession();
  const running = isSessionRunning();
  const finished = !session;

  if (nextBtn) {
    nextBtn.disabled = running || finished || (session?.nextIndex ?? 0) >= flow.length;
  }
  if (runAllBtn) {
    runAllBtn.disabled = running || finished || (session?.nextIndex ?? 0) >= flow.length;
  }
  if (editBtn) {
    editBtn.disabled = selectedIndex === null;
  }
  if (saveBtn) {
    saveBtn.disabled = running || flow.length === 0;
  }
}

function stepIcon(status: StepStatus): string {
  if (status === 'running') return '…';
  if (status === 'success') return '✓';
  if (status === 'failed') return '✕';
  return '';
}

function stepRowClass(status: StepStatus, selected: boolean): string {
  const visualStatus = status === 'waiting' ? 'pending' : status;
  const classes = ['step-row'];
  if (visualStatus !== 'pending') {
    classes.push(visualStatus);
  }
  if (selected && status !== 'waiting') {
    classes.push('selected');
  }
  return classes.join(' ');
}

function selectStep(index: number): void {
  selectedIndex = index;
  const root = getShadowRoot();
  root.querySelectorAll('.step-row').forEach((row) => {
    row.classList.toggle('selected', row.getAttribute('data-index') === String(index));
  });
  updateToolbarState();
}

function renderStepRow(index: number): void {
  const root = getShadowRoot();
  const list = root.getElementById(LIST_ID);
  if (!list) return;

  let row = list.querySelector(`.step-row[data-index="${index}"]`) as HTMLDivElement | null;
  const status = statuses[index] ?? 'pending';

  if (!row) {
    row = document.createElement('div');
    row.className = 'step-row';
    row.dataset.index = String(index);
    row.innerHTML = `<span class="step-label"></span><span class="step-icon"></span>`;
    row.addEventListener('click', () => {
      selectStep(index);
      if (status === 'failed') {
        openStepEditor(index);
      }
    });
    list.appendChild(row);
  }

  row.className = stepRowClass(status, selectedIndex === index);
  const label = row.querySelector('.step-label');
  const icon = row.querySelector('.step-icon');
  if (label) label.textContent = flowStepLabel(flow[index], index);
  if (icon) {
    icon.textContent = stepIcon(status);
    icon.className = `step-icon ${status}`;
  }
}

function renderAllSteps(): void {
  const root = getShadowRoot();
  const list = root.getElementById(LIST_ID);
  if (!list) return;

  list.innerHTML = '';
  flow.forEach((_, index) => renderStepRow(index));
  updateCounter();
}

function scrollToStep(index: number): void {
  const row = getShadowRoot().querySelector(`.step-row[data-index="${index}"]`);
  row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openStepEditor(index: number): void {
  const root = getShadowRoot();
  const editor = root.getElementById(EDITOR_ID);
  const selectorInput = root.querySelector('#replay-edit-selector') as HTMLInputElement | null;
  const labelInput = root.querySelector('#replay-edit-label') as HTMLInputElement | null;
  const pickBtn = root.querySelector('#replay-pick-btn') as HTMLButtonElement | null;
  if (!editor || !selectorInput || !labelInput) return;

  const step = flow[index];
  selectStep(index);
  editorOpen = true;
  editor.classList.add('open');

  const editable = canEditSelector(step);
  selectorInput.value = stepEditableSelector(step);
  selectorInput.disabled = !editable;
  labelInput.value = step.type === 'wait' ? '' : step.label ?? '';
  if (pickBtn) {
    pickBtn.style.display = editable ? '' : 'none';
  }
}

function stopElementPickerIfActive(): void {
  if (!pickerActive) return;
  setPanelPickingMode(false);
  void chrome.runtime.sendMessage({ action: 'STOP_ELEMENT_PICKER' }).catch(() => {
    // Extension may be reloading.
  });
}

function closeStepEditor(): void {
  stopElementPickerIfActive();
  const editor = getShadowRoot().getElementById(EDITOR_ID);
  if (!editor) return;
  editorOpen = false;
  editor.classList.remove('open');
}

async function applyStepEditorChanges(options?: { close?: boolean }): Promise<boolean> {
  if (selectedIndex === null) return false;
  const root = getShadowRoot();
  const selectorInput = root.querySelector('#replay-edit-selector') as HTMLInputElement | null;
  const labelInput = root.querySelector('#replay-edit-label') as HTMLInputElement | null;
  if (!selectorInput || !labelInput) return false;

  const index = selectedIndex;
  const step = flow[index];
  const next = patchStepFields(step, {
    selector: selectorInput.value.trim(),
    label: labelInput.value.trim(),
  });

  const activeSession = getReplaySession();
  if (activeSession) {
    updateReplayStep(index, next);
    flow = getReplayFlow();
  } else {
    flow = flow.map((item, stepIndex) => (stepIndex === index ? next : item));
    renderStepRow(index);
  }

  if (options?.close !== false) {
    closeStepEditor();
  }
  const saved = await persistFlowToDraft(flow, { invalidateReplay: true });
  if (!saved) {
    setFooter('步骤已更新，但写入录制草稿失败，请重试「保存修改」', 'failed');
    return false;
  }
  setFooter(`步骤 ${index + 1} 已更新`);
  return true;
}

function syncPanelPassthrough(): void {
  const host = document.getElementById(HOST_ID);
  const panel = getShadowRoot().getElementById(PANEL_ID);
  if (!panel) return;

  if (host) {
    host.style.removeProperty('visibility');
    host.style.pointerEvents = 'none';
  }

  const passthrough = pickerActive || executingActive;
  panel.style.pointerEvents = passthrough ? 'none' : 'auto';
  panel.style.opacity = passthrough ? (pickerActive ? '0.4' : '0.55') : '1';
}

function setPanelPickingMode(active: boolean): void {
  if (active && !pickerActive) {
    minimizedBeforePick = panelMinimized;
    setPanelMinimized(true);
  } else if (!active && pickerActive) {
    setPanelMinimized(minimizedBeforePick);
  }
  pickerActive = active;
  syncPanelPassthrough();
}

function applyPickedValuesToEditor(picked: { selector: string; label?: string }): void {
  const selectorInput = getShadowRoot().querySelector('#replay-edit-selector') as HTMLInputElement | null;
  const labelInput = getShadowRoot().querySelector('#replay-edit-label') as HTMLInputElement | null;
  if (selectorInput) selectorInput.value = picked.selector;
  if (labelInput && !labelInput.value.trim() && picked.label) {
    labelInput.value = picked.label;
  }
  if (!editorOpen && selectedIndex !== null) {
    openStepEditor(selectedIndex);
  }
}

export function handleReplayPanelPickerEnd(picked?: { selector?: string; label?: string }): void {
  if (!isTopFrame()) return;

  try {
    if (picked?.selector) {
      applyPickedValuesToEditor({ selector: picked.selector, label: picked.label });
      setFooter('元素已拾取，点击「应用」或「应用并重试」保存');
    } else if (pickerActive) {
      setFooter('元素拾取已取消');
    }
  } finally {
    if (pickerActive) {
      setPanelPickingMode(false);
    }
  }
}

export function setReplayPanelExecuting(active: boolean): void {
  executingActive = active;
  syncPanelPassthrough();
}

async function startElementPickerForEditor(): Promise<void> {
  try {
    setPanelPickingMode(true);
    const response = (await chrome.runtime.sendMessage({ action: 'START_ELEMENT_PICKER' })) as
      | { ok?: boolean; error?: string; success?: boolean }
      | undefined;
    if (response?.error || response?.success === false) {
      throw new Error(response.error ?? '无法启动元素拾取');
    }
    setFooter('请在页面上点击要拾取的元素');
  } catch (error) {
    setPanelPickingMode(false);
    setFooter(error instanceof Error ? error.message : String(error), 'failed');
  }
}

async function applyElementPickerToEditor(): Promise<void> {
  if (!pickerActive) return;

  try {
    const picked = (await chrome.runtime.sendMessage({
      action: 'GET_ELEMENT_PICKER_RESULT',
    })) as { selector?: string; label?: string } | undefined;
    handleReplayPanelPickerEnd(picked?.selector ? picked : undefined);
  } catch {
    handleReplayPanelPickerEnd(undefined);
  }
}

function bindToolbarEvents(toolbar: HTMLElement): void {
  if (toolbar.dataset.bound === '1') return;
  toolbar.dataset.bound = '1';

  toolbar.querySelector('[data-action="next"]')?.addEventListener('click', () => {
    closeStepEditor();
    void runNextStep().then(updateToolbarState);
  });

  toolbar.querySelector('[data-action="run-all"]')?.addEventListener('click', () => {
    closeStepEditor();
    void runAllRemaining().then(updateToolbarState);
  });

  toolbar.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
    if (selectedIndex !== null) {
      openStepEditor(selectedIndex);
    }
  });

  toolbar.querySelector('[data-action="save"]')?.addEventListener('click', () => {
    void (async () => {
      if (editorOpen) {
        const applied = await applyStepEditorChanges({ close: true });
        if (!applied) return;
      } else {
        const flowToSave = getReplaySession() ? getReplayFlow() : flow;
        flow = flowToSave;
        const saved = await persistFlowToDraft(flowToSave);
        if (!saved) {
          setFooter('保存失败，请刷新页面后重试', 'failed');
          return;
        }
      }
      setFooter('步骤已保存到草稿。打开扩展 → 点击「确认成功并保存」完成工作流保存', 'success');
    })();
  });
}

function bindEditorEvents(editor: HTMLElement): void {
  if (editor.dataset.bound === '1') return;
  editor.dataset.bound = '1';

  editor.querySelector('[data-action="apply"]')?.addEventListener('click', () => {
    void applyStepEditorChanges({ close: true });
  });

  editor.querySelector('[data-action="apply-retry"]')?.addEventListener('click', () => {
    void (async () => {
      const index = selectedIndex;
      if (index === null) return;
      const applied = await applyStepEditorChanges({ close: true });
      if (applied) {
        void retryStep(index).then(updateToolbarState);
      }
    })();
  });

  editor.querySelector('[data-action="cancel-edit"]')?.addEventListener('click', closeStepEditor);
  editor.querySelector('#replay-pick-btn')?.addEventListener('click', () => {
    void startElementPickerForEditor();
  });
}

function ensurePanel(): HTMLDivElement {
  const root = getShadowRoot();
  let panel = root.getElementById(PANEL_ID) as HTMLDivElement | null;

  if (panel) {
    const editor = root.getElementById(EDITOR_ID);
    if (editor) bindEditorEvents(editor);
    return panel;
  }

  panel = document.createElement('div');
  panel.id = PANEL_ID;

  const header = document.createElement('div');
  header.id = HEADER_ID;

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = '试跑回放';

  const counter = document.createElement('span');
  counter.id = COUNTER_ID;
  counter.textContent = '0/0';

  const minimizeBtn = createPanelButton('—', 'minimize');
  minimizeBtn.title = '最小化';
  minimizeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setPanelMinimized(!panelMinimized);
  });

  const closeBtn = createPanelButton('×', 'close');
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    hideReplayPanel();
  });

  header.appendChild(title);
  header.appendChild(counter);
  header.appendChild(minimizeBtn);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.id = BODY_ID;

  const list = document.createElement('div');
  list.id = LIST_ID;

  const toolbar = document.createElement('div');
  toolbar.id = TOOLBAR_ID;
  toolbar.innerHTML = `
    <button type="button" class="action-btn primary" data-action="next">下一步</button>
    <button type="button" class="action-btn secondary" data-action="run-all">全部执行</button>
    <button type="button" class="action-btn secondary" data-action="edit">编辑步骤</button>
    <button type="button" class="action-btn secondary" data-action="save">保存修改</button>
  `;

  const editor = document.createElement('div');
  editor.id = EDITOR_ID;
  editor.innerHTML = `
    <span class="editor-label">CSS 选择器</span>
    <div class="selector-row">
      <input id="replay-edit-selector" class="editor-input" type="text" placeholder="#search 或 .submit-btn" />
      <button type="button" id="replay-pick-btn" class="pick-btn">拾取</button>
    </div>
    <span class="editor-label">显示名称（可选）</span>
    <input id="replay-edit-label" class="editor-input" type="text" placeholder="步骤在列表中的显示名称" />
    <div class="editor-actions">
      <button type="button" class="action-btn primary" data-action="apply">应用</button>
      <button type="button" class="action-btn secondary" data-action="apply-retry">应用并重试</button>
      <button type="button" class="action-btn secondary" data-action="cancel-edit">取消</button>
    </div>
  `;

  const footer = document.createElement('div');
  footer.id = FOOTER_ID;

  body.appendChild(list);
  body.appendChild(toolbar);
  body.appendChild(editor);
  body.appendChild(footer);
  panel.appendChild(header);
  panel.appendChild(body);
  root.appendChild(panel);

  applyPanelPosition(panel);
  attachPanelDrag(panel, header);
  setPanelMinimized(readPanelMinimized());
  bindToolbarEvents(toolbar);
  bindEditorEvents(editor);

  if (!pickerListenerBound) {
    chrome.storage.onChanged.addListener(handlePickerStorageChange);
    pickerListenerBound = true;
  }

  return panel;
}

function handlePickerStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area !== 'session') return;

  if (changes.elementPickerResult?.newValue) {
    void applyElementPickerToEditor();
    return;
  }

  if (pickerActive && changes.elementPickerActive && !changes.elementPickerActive.newValue) {
    handleReplayPanelPickerEnd(undefined);
  }
}

function createSessionCallbacks(): ReplaySessionCallbacks {
  return {
    onProgress: (index, status, message) => {
      statuses[index] = status;
      renderStepRow(index);
      updateCounter();
      if (status === 'running') {
        setReplayPanelExecuting(true);
        scrollToStep(index);
        setFooter(`正在执行第 ${index + 1}/${flow.length} 步...`);
      } else if (status === 'waiting') {
        setReplayPanelExecuting(false);
        setFooter('请在本页完成登录，完成后点击凭据面板的「继续执行」');
      } else {
        setReplayPanelExecuting(false);
      }
      if (status === 'failed' && message) {
        setFooter(message, 'failed');
      }
      updateToolbarState();
    },
    onFlowChanged: (nextFlow) => {
      flow = nextFlow;
      renderAllSteps();
      if (selectedIndex !== null) {
        selectStep(selectedIndex);
      }
    },
    onPaused: (index, reason) => {
      setReplayPanelExecuting(false);
      selectStep(index);
      updateToolbarState();
      if (reason === 'failed') {
        const step = flow[index];
        if (step?.type !== 'manualLogin') {
          openStepEditor(index);
        }
        setFooter(`第 ${index + 1} 步失败，可修改选择器后「应用并重试」`, 'failed');
        return;
      }
      setFooter(`已完成 ${index}/${flow.length} 步。点击「下一步」继续，或「全部执行」跑完剩余步骤`);
    },
    onFinished: (result) => {
      setReplayPanelExecuting(false);
      if (result.flow?.length) {
        flow = result.flow.map((step) => ({ ...step }));
        renderAllSteps();
      }
      finishReplayPanel(result);
      updateToolbarState();
      void chrome.runtime.sendMessage({ type: 'REPLAY_FINISHED', result: { ...result, flow } });
    },
  };
}

function syncReplayPanelFromSession(preferredIndex?: number): void {
  const activeSession = getReplaySession();
  if (!activeSession) return;

  flow = activeSession.flow;
  statuses = [...activeSession.statuses];
  const nextIndex = preferredIndex ?? activeSession.nextIndex;
  selectedIndex = Math.min(Math.max(0, nextIndex), Math.max(0, flow.length - 1));
  editorOpen = false;

  const panel = ensurePanel();
  panel.style.display = 'flex';
  renderAllSteps();
  selectStep(selectedIndex);
  closeStepEditor();
  updateCounter();
  updateToolbarState();
  attachReplayNavigationGuard();
}

function onReplayPageHide(): void {
  if (getReplaySession()) {
    void persistReplaySession();
  }
}

function onReplayNavigation(): void {
  if (!getReplaySession()) {
    void restoreReplayIfNeeded();
    return;
  }
  if (isTopFrame()) {
    void persistReplaySession();
    const panel = getShadowRoot().getElementById(PANEL_ID);
    if (panel) {
      panel.style.display = 'flex';
    } else {
      syncReplayPanelFromSession();
    }
  }
}

function attachReplayNavigationGuard(): void {
  if (navigationGuardAttached) return;
  window.addEventListener('pagehide', onReplayPageHide);
  window.addEventListener('hashchange', onReplayNavigation);
  window.addEventListener('popstate', onReplayNavigation);
  navigationGuardAttached = true;
}

function finishResolvedNavigation(nextIndex: number): void {
  const activeSession = getReplaySession();
  if (nextIndex >= flow.length) {
    activeSession?.callbacks.onFinished({
      success: true,
      steps: activeSession.results,
      flow: activeSession.flow,
    });
    clearReplaySession();
    return;
  }
  selectStep(nextIndex);
  setFooter(`登录成功。已完成 ${nextIndex}/${flow.length} 步，点击「下一步」继续`);
  void persistReplaySession();
  void autoStartManualLoginIfNeeded();
}

export function restoreReplayPanel(snapshot: ReplaySessionSnapshot): void {
  if (!isTopFrame()) return;

  if (snapshot.waitingManualLogin && isManualLoginPanelActive()) {
    const existing = getReplaySession();
    if (existing) {
      existing.variables = { ...snapshot.variables };
      syncReplayPanelFromSession();
      setFooter('请在本页完成登录，可使用凭据面板复制账号密码');
      return;
    }
  }

  restoreReplaySession(snapshot, createSessionCallbacks());

  if (snapshot.waitingManualLogin) {
    const currentUrl = window.location.href;
    const startUrl = snapshot.manualLoginPageUrl;
    if (startUrl && currentUrl !== startUrl) {
      hideManualLoginPanel();
      syncReplayPanelFromSession();
      if (resolvePendingNavigationStep('登录完成，页面已跳转')) {
        const activeSession = getReplaySession();
        finishResolvedNavigation(activeSession?.nextIndex ?? snapshot.nextIndex);
      }
      return;
    }

    syncReplayPanelFromSession();
    setFooter('请在本页完成登录，可使用凭据面板复制账号密码');
    void resumeWaitingManualLogin();
    return;
  }

  hideManualLoginPanel();

  let resolvedNavigation = false;
  if (snapshot.pendingNavigationStep !== null) {
    resolvedNavigation = resolvePendingNavigationStep('页面跳转后继续');
  }

  syncReplayPanelFromSession();

  const activeSession = getReplaySession();
  const nextIndex = activeSession?.nextIndex ?? snapshot.nextIndex;
  if (resolvedNavigation) {
    finishResolvedNavigation(nextIndex);
    return;
  }

  if (shouldOfferManualLoginResume(snapshot)) {
    setFooter('正在恢复手工登录面板...');
    void autoStartManualLoginIfNeeded();
    return;
  }

  setFooter('页面已跳转，试跑回放已恢复。点击「下一步」继续');
}

function shouldOfferManualLoginResume(snapshot: ReplaySessionSnapshot): boolean {
  const step = snapshot.flow[snapshot.nextIndex];
  if (step?.type !== 'manualLogin') return false;
  const status = snapshot.statuses[snapshot.nextIndex];
  return status === 'pending' || status === 'running' || status === 'waiting';
}

export async function restoreReplayIfNeeded(): Promise<void> {
  if (!isTopFrame()) return;

  if (getReplaySession()) {
    syncReplayPanelFromSession();
    return;
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'CHECK_REPLAY_SESSION',
    })) as { active?: boolean; replaySession?: ReplaySessionSnapshot } | undefined;

    if (!response?.active || !response.replaySession) return;
    restoreReplayPanel(response.replaySession);
  } catch {
    // Extension may be reloading.
  }
}

export function showReplayPanel(steps: RecordedStep[], variables: Record<string, string>): void {
  if (!isTopFrame()) return;

  const panel = ensurePanel();
  panel.style.display = 'flex';
  setPanelMinimized(false);

  clearReplaySession();

  flow = steps;
  statuses = steps.map(() => 'pending');
  selectedIndex = 0;
  editorOpen = false;

  initReplaySession(steps, variables, createSessionCallbacks());
  syncReplayPanelFromSession(0);

  const session = getReplaySession();
  const nextStep = session?.flow[session.nextIndex ?? 0];
  if (nextStep?.type === 'manualLogin') {
    setFooter('正在打开手工登录面板，请复制凭据并完成登录');
    void autoStartManualLoginIfNeeded();
    return;
  }

  setFooter('单步模式：点击「下一步」执行当前步骤，失败后可编辑并重试');
}

export function updateReplayPanelProgress(index: number, status: ReplayProgressStatus): void {
  if (!isTopFrame() || index < 0 || index >= flow.length) return;

  statuses[index] = status;
  renderStepRow(index);
  updateCounter();

  if (status === 'running') {
    scrollToStep(index);
    setFooter(`正在执行第 ${index + 1}/${flow.length} 步...`);
  }
}

export function finishReplayPanel(result: FillResult): void {
  if (!isTopFrame()) return;

  if (result.success) {
    setFooter('回放成功！请打开扩展 → 确认保存', 'success');
    return;
  }

  const failedStep = result.steps.find((step) => step.status === 'failed');
  const detail = failedStep?.message ?? result.error ?? '回放失败';
  setFooter(`${detail}。可在此编辑步骤后重试`, 'failed');
}

export function hideReplayPanel(): void {
  if (!isTopFrame()) return;
  const panel = getShadowRoot().getElementById(PANEL_ID);
  if (panel) {
    panel.style.display = 'none';
  }
}

export function handleReplayPanelRuntimeMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const payload = message as {
    type?: string;
    index?: number;
    status?: ReplayProgressStatus;
    result?: FillResult;
    replaySession?: ReplaySessionSnapshot;
  };

  if (payload.type === 'RESTORE_REPLAY_PANEL' && payload.replaySession) {
    restoreReplayPanel(payload.replaySession);
    return true;
  }

  if (payload.type === 'REPLAY_PROGRESS') {
    if (typeof payload.index === 'number' && payload.status) {
      updateReplayPanelProgress(payload.index, payload.status);
    }
    return true;
  }

  if (payload.type === 'REPLAY_FINISHED' && payload.result) {
    finishReplayPanel(payload.result);
    return true;
  }

  return false;
}
