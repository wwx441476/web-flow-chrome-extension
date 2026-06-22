import type {
  ActiveTabInfo,
  BackgroundMessage,
  FillResult,
  GlobalSettings,
  RecordedStep,
  VariableSet,
  WorkflowRecord,
  StepResult,
} from '../types';
import { createWorkflowRecord, createVariableSet } from '../storage/sites';
import { DEFAULT_LLM_SETTINGS } from '../storage/settings';
import { updateRecordingDraftSteps } from '../storage/session';
import { normalizeWorkflow } from '../storage/accounts';
import { describeActionStep } from '../actions/describe';
import { variablesFromCredentials } from '../storage/variables';
import { openDesignerPage } from '../shared/open-designer';

const STEP_LABELS: Record<string, string> = {
  fill_username: '填充用户名',
  fill_password: '填充密码',
  fill_captcha: '识别图形验证码',
  validate_flow: '校验流程',
  replay: '回放',
};

let recordedFlow: RecordedStep[] = [];
let editingStepIndex: number | 'add' | null = null;
let lastReplayResult: FillResult | null = null;
let lastContext: {
  entryUrl: string;
  title: string;
  variables: Record<string, string>;
} | null = null;

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

function sendMessage<T>(message: BackgroundMessage): Promise<T> {
  return chrome.runtime.sendMessage(message).then((result: unknown) => {
    if (result && typeof result === 'object') {
      const payload = result as { error?: string; success?: boolean; steps?: unknown };
      if (payload.success === false && payload.error && !('steps' in payload)) {
        throw new Error(payload.error);
      }
    }
    return result as T;
  });
}

function showToast(text: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const toast = $('toast');
  toast.textContent = text;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function switchTab(tabName: string): void {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-tab') === tabName);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
}

function flowStepLabel(step: RecordedStep, index: number): string {
  return describeActionStep(step, index);
}

function stepStatusHtml(index: number, editable: boolean): string {
  const status = replayStepStatuses?.[index] ?? 'pending';
  const showProgress = isReplaying || status !== 'pending';

  if (editable && !showProgress) {
    return `<span class="step-actions">
            <button type="button" class="step-action-btn" data-action="up" data-index="${index}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
            <button type="button" class="step-action-btn" data-action="down" data-index="${index}" ${index === recordedFlow.length - 1 ? 'disabled' : ''} title="下移">↓</button>
            <button type="button" class="step-action-btn" data-action="edit" data-index="${index}" title="编辑">✎</button>
            <button type="button" class="step-action-btn danger" data-action="delete" data-index="${index}" title="删除">×</button>
          </span>`;
  }

  if (status === 'running') {
    return '<span class="step-status running" title="执行中">…</span>';
  }
  if (status === 'success') {
    return '<span class="step-status success" title="已完成">✓</span>';
  }
  if (status === 'failed') {
    return '<span class="step-status failed" title="失败">✕</span>';
  }
  return '<span class="step-status pending"></span>';
}

function stepItemClass(index: number): string {
  const status = replayStepStatuses?.[index];
  if (status === 'running') return 'step-item running';
  if (status === 'success') return 'step-item success';
  if (status === 'failed') return 'step-item failed';
  return 'step-item';
}

function updateReplayProgress(index: number, status: StepReplayStatus): void {
  if (!replayStepStatuses) return;
  replayStepStatuses[index] = status;
  renderRecordedFlow(recordedFlow);

  if (status === 'running') {
    $('record-message').textContent = `正在执行第 ${index + 1}/${recordedFlow.length} 步...`;
    const item = $('recorded-steps').querySelector(`.step-item[data-index="${index}"]`);
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function clearReplayProgress(): void {
  replayStepStatuses = null;
  isReplaying = false;
}

function renderRecordedFlow(flow: RecordedStep[]): void {
  const container = $('recorded-steps');
  if (flow.length === 0) {
    container.classList.add('hidden');
    container.innerHTML = '';
    if (!isRecordingActive) {
      container.classList.remove('hidden');
      container.innerHTML =
        '<p class="empty-flow-hint">暂无步骤。完成录制后可在此编辑，或手动添加。</p><button type="button" id="add-step-btn" class="btn secondary small add-step-btn">+ 添加步骤</button>';
    }
    return;
  }

  const editable = !isRecordingActive && !isReplaying;
  const rows = flow
    .map((step, index) => {
      const actions = stepStatusHtml(index, editable);
      return `<div class="${stepItemClass(index)}" data-index="${index}"><span class="step-label">${escapeHtml(flowStepLabel(step, index))}</span>${actions}</div>`;
    })
    .join('');

  container.innerHTML = rows;
  if (editable) {
    container.insertAdjacentHTML(
      'beforeend',
      '<button type="button" id="add-step-btn" class="btn secondary small add-step-btn">+ 添加步骤</button>',
    );
  }
  container.classList.remove('hidden');
}

async function persistRecordedFlow(): Promise<void> {
  if (recordedFlow.length === 0) return;
  await updateRecordingDraftSteps(recordedFlow);
}

function invalidateReplayState(): void {
  lastReplayResult = null;
  clearReplayProgress();
  $('save-panel').classList.add('hidden');
  updateRecordingUi(isRecordingActive);
}

function applyPendingSaveState(draft: {
  replayPendingSave?: boolean;
  lastReplayResult?: FillResult;
}): void {
  if (draft.replayPendingSave && draft.lastReplayResult?.success) {
    lastReplayResult = draft.lastReplayResult;
    $('save-panel').classList.remove('hidden');
    $('record-message').textContent = '回放完成。若已达到预期效果，请确认保存。';
  }
}

async function applyFlowChange(message?: string): Promise<void> {
  invalidateReplayState();
  renderRecordedFlow(recordedFlow);
  await persistRecordedFlow();
  if (message) {
    $('record-message').textContent = message;
  }
}

function stepSelector(step: RecordedStep): string {
  if (step.type === 'wait' || step.type === 'navigate') {
    return '';
  }
  if (step.type === 'manualLogin') {
    return step.successSelector ?? '';
  }
  if (step.type === 'key') {
    return step.selector ?? '';
  }
  if ('selector' in step && typeof step.selector === 'string') {
    return step.selector;
  }
  return '';
}

function stepTypeValue(step: RecordedStep): string {
  if (step.type === 'click') return 'click';
  if (step.type === 'dblclick') return 'dblclick';
  if (step.type === 'hover') return 'hover';
  if (step.type === 'scroll') return 'scroll';
  if (step.type === 'key') return 'key';
  if (step.type === 'select') return 'select';
  if (step.type === 'wait') return 'wait';
  if (step.type === 'waitElement') return 'wait-element';
  if (step.type === 'navigate') return 'navigate';
  if (step.type === 'manualLogin') return 'manual-login';
  if (step.type === 'extract') return 'extract';
  if (step.type === 'fill') {
    if (step.fillKind === 'captcha' || step.field === 'captcha') return 'fill-captcha';
    if (step.fillKind === 'literal') return 'fill-literal';
    if (step.variableName === 'password' || step.field === 'password') return 'fill-password';
    if (step.variableName === 'username' || step.field === 'username') return 'fill-username';
    return 'fill-variable';
  }
  return 'click';
}

function buildStepFromEditor(): RecordedStep | null {
  const type = ($('edit-step-type') as HTMLSelectElement).value;
  const selector = ($('edit-step-selector') as HTMLInputElement).value.trim();
  const label = ($('edit-step-label') as HTMLInputElement).value.trim();

  if (type === 'wait') {
    const delayMs = Number(($('edit-step-delay') as HTMLInputElement).value);
    if (!Number.isFinite(delayMs) || delayMs < 100) {
      showToast('等待时间至少 100ms', 'error');
      return null;
    }
    return { type: 'wait', delayMs };
  }

  if (type === 'wait-element') {
    if (!selector) {
      showToast('请填写 CSS 选择器', 'error');
      return null;
    }
    const timeoutRaw = ($('edit-wait-timeout') as HTMLInputElement).value.trim();
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 8000;
    return {
      type: 'waitElement',
      selector,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000,
      label: label || undefined,
    };
  }

  if (type === 'navigate') {
    const url = ($('edit-navigate-url') as HTMLInputElement).value.trim();
    if (!url) {
      showToast('请填写网页地址', 'error');
      return null;
    }
    return { type: 'navigate', url, label: label || undefined };
  }

  if (type === 'manual-login') {
    const url = ($('edit-navigate-url') as HTMLInputElement).value.trim();
    const successSelector = ($('edit-step-selector') as HTMLInputElement).value.trim();
    const timeoutMs = Number(($('edit-wait-timeout') as HTMLInputElement).value.trim() || '300000');
    return {
      type: 'manualLogin',
      url: url || undefined,
      successSelector: successSelector || undefined,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 300000,
      label: label || undefined,
    };
  }

  if (type === 'extract') {
    if (!selector) {
      showToast('请填写 CSS 选择器', 'error');
      return null;
    }
    const variableName = ($('edit-extract-variable') as HTMLInputElement).value.trim() || 'result';
    const attribute = ($('edit-extract-attribute') as HTMLSelectElement).value as
      | 'text'
      | 'value'
      | 'href';
    const timeoutRaw = ($('edit-wait-timeout') as HTMLInputElement).value.trim();
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 8000;
    return {
      type: 'extract',
      selector,
      variableName,
      attribute,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000,
      label: label || undefined,
    };
  }

  if (type === 'scroll') {
    const topRaw = ($('edit-scroll-top') as HTMLInputElement).value.trim();
    const leftRaw = ($('edit-scroll-left') as HTMLInputElement).value.trim();
    return {
      type: 'scroll',
      selector: selector || undefined,
      top: topRaw ? Number(topRaw) : undefined,
      left: leftRaw ? Number(leftRaw) : undefined,
      label: label || undefined,
    };
  }

  if (type === 'key') {
    const key = ($('edit-step-key') as HTMLInputElement).value.trim();
    if (!key) {
      showToast('请填写按键名', 'error');
      return null;
    }
    const modsRaw = ($('edit-step-modifiers') as HTMLInputElement).value.trim();
    const modifiers = modsRaw
      ? (modsRaw.split(/[+,\s]+/).filter(Boolean) as Array<'ctrl' | 'shift' | 'alt' | 'meta'>)
      : undefined;
    return {
      type: 'key',
      key,
      selector: selector || undefined,
      modifiers,
      label: label || undefined,
    };
  }

  const needsSelector = !['wait', 'scroll', 'navigate'].includes(type);
  if (needsSelector && type !== 'key' && !selector) {
    showToast('请填写 CSS 选择器', 'error');
    return null;
  }

  if (type === 'click') {
    return { type: 'click', selector, label: label || undefined };
  }
  if (type === 'dblclick') {
    return { type: 'dblclick', selector, label: label || undefined };
  }
  if (type === 'hover') {
    return { type: 'hover', selector, label: label || undefined };
  }
  if (type === 'select') {
    const value = ($('edit-select-value') as HTMLInputElement).value.trim();
    const optionText = ($('edit-select-text') as HTMLInputElement).value.trim();
    if (!value && !optionText) {
      showToast('请填写 option 的 value 或显示文字', 'error');
      return null;
    }
    return {
      type: 'select',
      selector,
      value: value || undefined,
      optionText: optionText || undefined,
      label: label || undefined,
    };
  }

  const imageSelector = ($('edit-step-image-selector') as HTMLInputElement).value.trim();

  if (type === 'fill-captcha') {
    return {
      type: 'fill',
      fillKind: 'captcha',
      selector,
      label: label || undefined,
      imageSelector: imageSelector || undefined,
    };
  }

  if (type === 'fill-literal') {
    const value = ($('edit-step-literal') as HTMLInputElement).value;
    return {
      type: 'fill',
      fillKind: 'literal',
      selector,
      value,
      label: label || undefined,
    };
  }

  const variableName =
    type === 'fill-password'
      ? 'password'
      : type === 'fill-username'
        ? 'username'
        : ($('edit-step-variable') as HTMLInputElement).value.trim() || 'value';

  return {
    type: 'fill',
    fillKind: 'variable',
    selector,
    variableName,
    label: label || undefined,
  };
}

function updateStepEditorFields(): void {
  const type = ($('edit-step-type') as HTMLSelectElement).value;
  const isWait = type === 'wait';
  const isWaitElement = type === 'wait-element';
  const isNavigate = type === 'navigate';
  const isManualLogin = type === 'manual-login';
  const isExtract = type === 'extract';
  const isScroll = type === 'scroll';
  const isKey = type === 'key';
  const isSelect = type === 'select';
  const isCaptcha = type === 'fill-captcha';
  const isLiteral = type === 'fill-literal';
  const isVariable = type === 'fill-variable';
  const needsSelector = !isWait && !isScroll && !isNavigate && !isManualLogin;
  $('edit-selector-field').classList.toggle('hidden', !needsSelector && !isScroll && !isManualLogin);
  $('edit-selector-optional-hint')?.classList.toggle('hidden', !isScroll && !isKey && !isManualLogin);
  $('edit-delay-field').classList.toggle('hidden', !isWait);
  $('edit-navigate-field').classList.toggle('hidden', !isNavigate && !isManualLogin);
  $('edit-wait-element-field').classList.toggle('hidden', !isWaitElement && !isExtract && !isManualLogin);
  $('edit-extract-fields').classList.toggle('hidden', !isExtract);
  $('edit-image-selector-field').classList.toggle('hidden', !isCaptcha);
  $('edit-variable-name-field').classList.toggle('hidden', !isVariable);
  $('edit-literal-value-field').classList.toggle('hidden', !isLiteral);
  $('edit-scroll-fields').classList.toggle('hidden', !isScroll);
  $('edit-key-fields').classList.toggle('hidden', !isKey);
  $('edit-select-fields').classList.toggle('hidden', !isSelect);
  const pickBtn = $('pick-element-btn') as HTMLButtonElement;
  pickBtn.style.display = needsSelector || isWaitElement || isExtract || isManualLogin ? '' : 'none';
}

function openStepEditor(index: number | 'add', step?: RecordedStep): void {
  editingStepIndex = index;
  const editor = $('step-editor');
  editor.classList.remove('hidden');

  const title = editor.querySelector('.step-editor-title');
  if (title) {
    title.textContent = index === 'add' ? '添加步骤' : `编辑步骤 ${index + 1}`;
  }

  if (step) {
    ($('edit-step-type') as HTMLSelectElement).value = stepTypeValue(step);
    ($('edit-step-selector') as HTMLInputElement).value = stepSelector(step);
    ($('edit-step-label') as HTMLInputElement).value =
      step.type === 'wait' ? '' : step.label ?? '';
    ($('edit-step-delay') as HTMLInputElement).value =
      step.type === 'wait' ? String(step.delayMs) : '500';
    ($('edit-step-image-selector') as HTMLInputElement).value =
      step.type === 'fill' && (step.fillKind === 'captcha' || step.field === 'captcha')
        ? step.imageSelector ?? ''
        : '';
    ($('edit-step-variable') as HTMLInputElement).value =
      step.type === 'fill' ? step.variableName ?? step.field ?? '' : '';
    ($('edit-step-literal') as HTMLInputElement).value =
      step.type === 'fill' && step.fillKind === 'literal' ? step.value ?? '' : '';
    ($('edit-scroll-top') as HTMLInputElement).value =
      step.type === 'scroll' && step.top !== undefined ? String(step.top) : '';
    ($('edit-scroll-left') as HTMLInputElement).value =
      step.type === 'scroll' && step.left !== undefined ? String(step.left) : '';
    ($('edit-step-key') as HTMLInputElement).value = step.type === 'key' ? step.key : '';
    ($('edit-step-modifiers') as HTMLInputElement).value =
      step.type === 'key' && step.modifiers?.length ? step.modifiers.join('+') : '';
    ($('edit-select-value') as HTMLInputElement).value =
      step.type === 'select' ? step.value ?? '' : '';
    ($('edit-select-text') as HTMLInputElement).value =
      step.type === 'select' ? step.optionText ?? '' : '';
    ($('edit-navigate-url') as HTMLInputElement).value =
      step.type === 'navigate' ? step.url : step.type === 'manualLogin' ? step.url ?? '' : '';
    ($('edit-wait-timeout') as HTMLInputElement).value =
      step.type === 'waitElement' || step.type === 'extract'
        ? String(step.timeoutMs ?? 8000)
        : step.type === 'manualLogin'
          ? String(step.timeoutMs ?? 300000)
          : '8000';
    ($('edit-extract-variable') as HTMLInputElement).value =
      step.type === 'extract' ? step.variableName : '';
    ($('edit-extract-attribute') as HTMLSelectElement).value =
      step.type === 'extract' ? step.attribute ?? 'text' : 'text';
  } else {
    ($('edit-step-type') as HTMLSelectElement).value = 'click';
    ($('edit-step-selector') as HTMLInputElement).value = '';
    ($('edit-step-label') as HTMLInputElement).value = '';
    ($('edit-step-delay') as HTMLInputElement).value = '500';
    ($('edit-step-image-selector') as HTMLInputElement).value = '';
    ($('edit-step-variable') as HTMLInputElement).value = '';
    ($('edit-step-literal') as HTMLInputElement).value = '';
  }

  updateStepEditorFields();
}

function closeStepEditor(): void {
  editingStepIndex = null;
  $('step-editor').classList.add('hidden');
}

async function saveStepEditor(): Promise<void> {
  const step = buildStepFromEditor();
  if (!step || editingStepIndex === null) return;

  if (editingStepIndex === 'add') {
    recordedFlow = [...recordedFlow, step];
  } else {
    recordedFlow = recordedFlow.map((item, index) => (index === editingStepIndex ? step : item));
  }

  closeStepEditor();
  await applyFlowChange(`已更新，共 ${recordedFlow.length} 步。修改后请重新试跑回放。`);
  showToast('步骤已保存', 'success');
}

async function deleteStep(index: number): Promise<void> {
  recordedFlow = recordedFlow.filter((_, stepIndex) => stepIndex !== index);
  closeStepEditor();
  await applyFlowChange(
    recordedFlow.length > 0
      ? `已删除步骤，共 ${recordedFlow.length} 步。请重新试跑回放。`
      : '已删除全部步骤，可重新录制或手动添加。',
  );
  showToast('步骤已删除', 'success');
}

async function moveStep(index: number, direction: -1 | 1): Promise<void> {
  const target = index + direction;
  if (target < 0 || target >= recordedFlow.length) return;
  const next = [...recordedFlow];
  [next[index], next[target]] = [next[target], next[index]];
  recordedFlow = next;
  await applyFlowChange('步骤顺序已调整，请重新试跑回放。');
}

async function openFlowDesignerFromDraft(): Promise<void> {
  const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
  const draft = await sendMessage<{ tabId?: number; entryUrl?: string } | undefined>({
    action: 'GET_RECORDING_DRAFT',
  });
  const name = ($('site-name') as HTMLInputElement).value.trim() || tab.title || '未命名工作流';
  const entryUrl =
    ($('current-url') as HTMLInputElement).value.trim() || draft?.entryUrl || tab.url || '';

  await openDesignerPage({
    source: 'draft',
    name,
    entryUrl,
    targetTabId: draft?.tabId ?? tab.id,
    steps: recordedFlow,
  });
}

async function openFlowDesignerForWorkflow(workflow: WorkflowRecord): Promise<void> {
  const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
  let targetTabId: number | undefined;
  if (tab.id && tab.url && workflow.entryUrl) {
    try {
      const origin = new URL(workflow.entryUrl).origin;
      if (tab.url.startsWith(origin)) {
        targetTabId = tab.id;
      }
    } catch {
      // Ignore invalid entry URL.
    }
  }

  await openDesignerPage({
    source: 'workflow',
    workflowId: workflow.id,
    name: workflow.name,
    entryUrl: workflow.entryUrl,
    targetTabId,
    steps: workflow.flow ?? [],
  });
}

async function startElementPickerFromEditor(): Promise<void> {
  try {
    const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('请先在目标网站页面点击扩展图标');
    }

    await sendMessage({ action: 'START_ELEMENT_PICKER' });
    showToast('请在页面上点击要拾取的元素', 'info');
    setTimeout(() => window.close(), 300);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function applyElementPickerResult(): Promise<void> {
  const picked = await sendMessage<{ selector?: string; label?: string } | undefined>({
    action: 'GET_ELEMENT_PICKER_RESULT',
  });
  if (!picked?.selector) return;

  if (!$('step-editor').classList.contains('hidden')) {
    ($('edit-step-selector') as HTMLInputElement).value = picked.selector;
    const labelInput = $('edit-step-label') as HTMLInputElement;
    if (!labelInput.value.trim() && picked.label) {
      labelInput.value = picked.label;
    }
    showToast('元素已拾取', 'success');
    return;
  }

  openStepEditor('add');
  ($('edit-step-selector') as HTMLInputElement).value = picked.selector;
  if (picked.label) {
    ($('edit-step-label') as HTMLInputElement).value = picked.label;
  }
  showToast('元素已拾取，请完善步骤并保存', 'success');
}

function bindStepEditorEvents(): void {
  $('edit-step-type').addEventListener('change', updateStepEditorFields);
  $('save-step-btn').addEventListener('click', () => void saveStepEditor());
  $('cancel-step-btn').addEventListener('click', closeStepEditor);
  $('pick-element-btn').addEventListener('click', () => void startElementPickerFromEditor());

  $('recorded-steps').addEventListener('click', (event) => {
    if (isRecordingActive) return;
    const target = event.target as HTMLElement;

    if (target.id === 'add-step-btn') {
      openStepEditor('add');
      return;
    }

    const button = target.closest('.step-action-btn') as HTMLButtonElement | null;
    if (!button || button.disabled) return;

    const index = Number(button.dataset.index);
    if (!Number.isFinite(index)) return;

    const action = button.dataset.action;
    if (action === 'delete') {
      void deleteStep(index);
      return;
    }
    if (action === 'edit') {
      openStepEditor(index, recordedFlow[index]);
      return;
    }
    if (action === 'up') {
      void moveStep(index, -1);
      return;
    }
    if (action === 'down') {
      void moveStep(index, 1);
    }
  });
}

let isRecordingActive = false;
type StepReplayStatus = 'pending' | 'running' | 'success' | 'failed';
let replayStepStatuses: StepReplayStatus[] | null = null;
let isReplaying = false;

function updateRecordingUi(recording: boolean): void {
  isRecordingActive = recording;
  ($('start-record-btn') as HTMLButtonElement).disabled = recording;
  ($('stop-record-btn') as HTMLButtonElement).disabled = !recording;
  ($('replay-btn') as HTMLButtonElement).disabled = recording || recordedFlow.length === 0;
  ($('manual-login-replay-btn') as HTMLButtonElement).disabled = recording || recordedFlow.length === 0;
  ($('open-designer-btn') as HTMLButtonElement).disabled = recording;
}

function getVariables(): Record<string, string> {
  return {
    username: ($('username') as HTMLInputElement).value.trim(),
    password: ($('password') as HTMLInputElement).value,
  };
}

async function loadRecordingDraft(): Promise<void> {
  const draft = await sendMessage<{
    tabId: number;
    entryUrl: string;
    title: string;
    workflowName: string;
    siteName?: string;
    variables: Record<string, string>;
    credentials?: { username: string; password: string };
    steps: RecordedStep[];
    status: 'recording' | 'completed';
    lastReplayResult?: FillResult;
    replayPendingSave?: boolean;
  } | undefined>({ action: 'GET_RECORDING_DRAFT' });

  if (!draft) return;

  const variables =
    draft.variables ??
    (draft.credentials ? variablesFromCredentials(draft.credentials) : { username: '', password: '' });

  if (variables.username) {
    ($('username') as HTMLInputElement).value = variables.username;
  }
  if (variables.password) {
    ($('password') as HTMLInputElement).value = variables.password;
  }
  const workflowName = draft.workflowName ?? draft.siteName;
  if (workflowName) {
    ($('site-name') as HTMLInputElement).value = workflowName;
  }
  ($('current-url') as HTMLInputElement).value = draft.entryUrl;

  lastContext = {
    entryUrl: draft.entryUrl,
    title: draft.title,
    variables,
  };

  if (draft.status === 'recording') {
    updateRecordingUi(true);
    $('record-message').textContent =
      `录制进行中（${draft.steps.length} 步）。请点页面右上角「完成录制」，或在此点「停止录制」。`;
    return;
  }

  recordedFlow = draft.steps;
  renderRecordedFlow(recordedFlow);
  updateRecordingUi(false);

  if (recordedFlow.length > 0) {
    $('record-message').textContent = `已录制 ${recordedFlow.length} 步，可点击「试跑回放」验证。`;
  }

  applyPendingSaveState(draft);
}

async function startRecording(): Promise<void> {
  const message = $('record-message');
  const startBtn = $('start-record-btn') as HTMLButtonElement;
  message.textContent = '';

  startBtn.disabled = true;
  startBtn.textContent = '启动中...';
  message.textContent = '正在启动录制...';

  try {
    const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('请先在目标网站页面点击扩展图标，再开始录制');
    }

    const variables = getVariables();
    const workflowName = ($('site-name') as HTMLInputElement).value.trim();

    const result = await sendMessage<{ recording: boolean; steps: RecordedStep[] }>({
      action: 'START_RECORDING',
      entryUrl: tab.url,
      title: tab.title,
      workflowName: workflowName || tab.title,
      variables,
    });

    if (!result?.recording) {
      throw new Error('录制启动失败，请刷新页面后重试');
    }

    showToast('录制已开始，请看页面右上角', 'success');
    message.textContent = '录制已启动，请查看页面右上角浮层';
    setTimeout(() => window.close(), 500);
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    showToast(message.textContent, 'error');
    startBtn.disabled = false;
    startBtn.textContent = '开始录制';
  }
}

async function stopRecording(): Promise<void> {
  const message = $('record-message');

  try {
    const result = await sendMessage<{ recording: boolean; steps: RecordedStep[] }>({
      action: 'STOP_RECORDING',
    });
    recordedFlow = result.steps ?? [];
    renderRecordedFlow(recordedFlow);
    updateRecordingUi(false);

    if (recordedFlow.length === 0) {
      message.textContent = '未录到任何操作。请回到登录页重新录制，并确保点击了输入框、输入内容、点击登录。';
      return;
    }

    message.textContent = `已录制 ${recordedFlow.length} 步，可点击「试跑回放」验证。`;
    showToast('录制完成', 'success');
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    updateRecordingUi(false);
  }
}

async function manualLoginReplayRecording(): Promise<void> {
  const message = $('record-message');
  const variables = getVariables();

  if (recordedFlow.length === 0) {
    message.textContent = '请先录制操作步骤。';
    return;
  }

  const entryUrl = ($('current-url') as HTMLInputElement).value.trim();
  if (!entryUrl || entryUrl.startsWith('chrome://') || entryUrl.startsWith('chrome-extension://')) {
    message.textContent = '请填写有效的入口页面地址（当前页面）。';
    return;
  }

  ($('manual-login-replay-btn') as HTMLButtonElement).disabled = true;
  message.textContent = '正在新开页面并启动手工登录模式...';

  try {
    await loadRecordingDraft();

    lastContext = {
      entryUrl,
      title: ($('site-name') as HTMLInputElement).value.trim() || entryUrl,
      variables,
    };

    const workflowName = ($('site-name') as HTMLInputElement).value.trim();
    void chrome.runtime.sendMessage({
      action: 'MANUAL_LOGIN_REPLAY',
      variables,
      flow: recordedFlow,
      entryUrl,
      workflowName: workflowName || undefined,
    });

    window.close();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    ($('manual-login-replay-btn') as HTMLButtonElement).disabled = recordedFlow.length === 0;
  }
}

async function replayRecording(): Promise<void> {
  const message = $('record-message');
  const variables = getVariables();

  if (recordedFlow.length === 0) {
    message.textContent = '请先录制操作步骤。';
    return;
  }

  ($('replay-btn') as HTMLButtonElement).disabled = true;
  message.textContent = '正在启动试跑...';

  try {
    await loadRecordingDraft();

    const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('请先在目标网站页面点击扩展图标，再试跑回放');
    }

    lastContext = {
      entryUrl: tab.url ?? '',
      title: tab.title ?? '未命名工作流',
      variables,
    };

    const workflowName = ($('site-name') as HTMLInputElement).value.trim();
    void chrome.runtime.sendMessage({
      action: 'REPLAY_RECORDING',
      variables,
      flow: recordedFlow,
      workflowName: workflowName || tab.title || undefined,
    });

    window.close();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    ($('replay-btn') as HTMLButtonElement).disabled = recordedFlow.length === 0;
  }
}

async function aiAutoLogin(): Promise<void> {
  const message = $('record-message');
  const variables = getVariables();
  const goal = ($('ai-goal') as HTMLInputElement).value.trim() || undefined;

  const aiBtn = $('ai-login-btn') as HTMLButtonElement;
  aiBtn.disabled = true;
  message.textContent = 'AI 正在分析页面并规划操作...';

  try {
    const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      throw new Error('请先在目标网站页面点击扩展图标');
    }

    const result = await sendMessage<FillResult>({
      action: 'AI_AUTO_RUN',
      variables,
      goal,
    });

    if (result.success) {
      message.textContent = `AI 执行完成（${result.steps.length} 步）。若效果符合预期，可录制保存为工作流。`;
      showToast('AI 自动执行完成', 'success');
    } else {
      const detail = result.error ?? result.steps.at(-1)?.message ?? '未知错误';
      message.textContent = `AI 执行未完成：${detail}`;
      showToast(message.textContent, 'error');
    }
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    showToast(message.textContent, 'error');
  } finally {
    aiBtn.disabled = false;
  }
}

async function saveSiteFromRecording(): Promise<void> {
  await loadRecordingDraft();

  if (!lastReplayResult?.success || recordedFlow.length === 0 || !lastContext) {
    $('record-message').textContent = '回放未成功，无法保存。';
    return;
  }

  const nameInput = ($('site-name') as HTMLInputElement).value.trim();
  const workflow = createWorkflowRecord({
    name: nameInput || lastContext.title,
    entryUrl: lastContext.entryUrl,
    flow: recordedFlow,
    selectors: lastReplayResult.selectors,
    variableSets: [
      createVariableSet({
        label: lastContext.variables.username || '默认变量集',
        values: lastContext.variables,
      }),
    ],
  });

  await sendMessage<WorkflowRecord>({ action: 'SAVE_WORKFLOW', workflow });
  await sendMessage({ action: 'CLEAR_RECORDING_DRAFT' });
  $('save-panel').classList.add('hidden');
  $('record-message').textContent = `已保存：${workflow.name}`;
  showToast('工作流保存成功', 'success');
  await renderSites();
  switchTab('sites');
}

function resetRecording(): void {
  recordedFlow = [];
  lastReplayResult = null;
  clearReplayProgress();
  closeStepEditor();
  renderRecordedFlow([]);
  $('save-panel').classList.add('hidden');
  $('record-message').textContent = '';
  updateRecordingUi(false);
}

function openModeLabel(openMode: WorkflowRecord['openMode'], settings: GlobalSettings): string {
  const resolved = openMode ?? settings.defaultOpenMode;
  if (openMode === null) return `跟随全局 (${resolved === 'new_tab' ? '新开标签' : '当前标签'})`;
  return resolved === 'new_tab' ? '新开标签' : '当前标签';
}

const BUILTIN_VARIABLE_KEYS = ['username', 'password'] as const;

function getCustomVariableKeys(values: Record<string, string>): string[] {
  return Object.keys(values).filter((key) => !BUILTIN_VARIABLE_KEYS.includes(key as (typeof BUILTIN_VARIABLE_KEYS)[number]));
}

function renderCustomVariableRow(key = '', value = ''): string {
  const valueLabel = key ? `变量 ${escapeHtml(key)}` : '变量值';
  return `
    <div class="custom-variable-row">
      <div class="field custom-variable-key-field">
        <label>变量名</label>
        <input type="text" class="custom-variable-key" value="${escapeAttr(key)}" placeholder="如 code" />
      </div>
      <div class="field custom-variable-value-field">
        <label>${valueLabel}</label>
        <input type="text" class="custom-variable-value" value="${escapeAttr(value)}" />
      </div>
      <button type="button" class="btn danger small remove-custom-variable-btn">删除</button>
    </div>
  `;
}

function renderVariableSetRows(sets: VariableSet[]): string {
  if (sets.length === 0) {
    return renderVariableSetRow(
      createVariableSet({ label: '默认变量集', values: { username: '', password: '' } }),
      0,
    );
  }
  return sets.map((set, index) => renderVariableSetRow(set, index)).join('');
}

function renderVariableSetRow(set: VariableSet, index: number): string {
  const customKeys = getCustomVariableKeys(set.values);
  return `
    <div class="account-row" data-account-id="${set.id}">
      <div class="account-row-title">变量集 ${index + 1}</div>
      <div class="field">
        <label>备注名</label>
        <input type="text" class="account-label" value="${escapeAttr(set.label)}" placeholder="便于识别" />
      </div>
      <div class="field">
        <label>变量 username</label>
        <input type="text" class="account-username" value="${escapeAttr(set.values.username ?? '')}" />
      </div>
      <div class="field">
        <label>变量 password</label>
        <input type="password" class="account-password" value="${escapeAttr(set.values.password ?? '')}" />
      </div>
      <div class="custom-variables-list">
        ${customKeys.map((key) => renderCustomVariableRow(key, set.values[key] ?? '')).join('')}
      </div>
      <button type="button" class="btn secondary small add-custom-variable-btn">添加变量</button>
      <button type="button" class="btn danger small remove-account-btn" data-account-id="${set.id}">删除</button>
    </div>
  `;
}

function collectVariableSetsFromCard(card: Element): VariableSet[] {
  return Array.from(card.querySelectorAll('.account-row')).map((row) => {
    const username = (row.querySelector('.account-username') as HTMLInputElement).value.trim();
    const password = (row.querySelector('.account-password') as HTMLInputElement).value;
    const labelInput = (row.querySelector('.account-label') as HTMLInputElement).value.trim();
    const id = row.getAttribute('data-account-id') || crypto.randomUUID();
    const values: Record<string, string> = { username, password };

    row.querySelectorAll('.custom-variable-row').forEach((customRow) => {
      const key = (customRow.querySelector('.custom-variable-key') as HTMLInputElement).value.trim();
      const value = (customRow.querySelector('.custom-variable-value') as HTMLInputElement).value;
      if (!key || BUILTIN_VARIABLE_KEYS.includes(key as (typeof BUILTIN_VARIABLE_KEYS)[number])) {
        return;
      }
      values[key] = value;
    });

    return {
      id,
      label: labelInput || username || '未命名变量集',
      values,
    };
  });
}

function validateVariableSets(variableSets: VariableSet[]): string | null {
  for (const set of variableSets) {
    const keys = new Set<string>();
    for (const key of Object.keys(set.values)) {
      if (keys.has(key)) {
        return `变量集「${set.label}」存在重复的变量名：${key}`;
      }
      keys.add(key);
    }
  }
  return null;
}

async function renderSites(): Promise<void> {
  const workflows = await sendMessage<WorkflowRecord[]>({ action: 'GET_WORKFLOWS' });
  const settings = await sendMessage<GlobalSettings>({ action: 'GET_SETTINGS' });
  const list = $('sites-list');
  const empty = $('sites-empty');

  if (workflows.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = workflows
    .map((rawWorkflow) => {
      const workflow = normalizeWorkflow(rawWorkflow);
      const stepCount = workflow.flow?.length ?? 0;
      const variableOptions = workflow.variableSets
        .map(
          (set) =>
            `<option value="${set.id}" ${set.id === workflow.defaultVariableSetId ? 'selected' : ''}>${escapeHtml(set.label)}</option>`,
        )
        .join('');

      return `
      <article class="site-card" data-id="${workflow.id}">
        <h3>${escapeHtml(workflow.name)}</h3>
        <p class="meta-url">${escapeHtml(workflow.entryUrl)}</p>
        <div class="meta-tags">
          <span class="meta-tag">${stepCount} 步</span>
          <span class="meta-tag">${workflow.variableSets.length} 个变量集</span>
          <span class="meta-tag">${escapeHtml(openModeLabel(workflow.openMode, settings))}</span>
        </div>
        <div class="login-block">
          <label class="login-label">选择变量集</label>
          <select class="login-account-select" data-id="${workflow.id}" ${workflow.variableSets.length === 0 ? 'disabled' : ''}>
            ${variableOptions || '<option value="">暂无变量集</option>'}
          </select>
          <button class="btn primary small login-btn" data-id="${workflow.id}" ${workflow.variableSets.length === 0 ? 'disabled' : ''}>运行</button>
          <button class="btn secondary small manual-login-btn" data-id="${workflow.id}" ${workflow.variableSets.length === 0 ? 'disabled' : ''}>手工登录</button>
        </div>
        <div class="site-actions">
          <button class="btn secondary small canvas-btn" data-id="${workflow.id}">流程画布</button>
          <button class="btn secondary small edit-btn" data-id="${workflow.id}">编辑</button>
          <button class="btn danger small delete-btn" data-id="${workflow.id}">删除</button>
        </div>
        <div class="site-edit hidden" id="edit-${workflow.id}">
          <div class="accounts-list">
            ${renderVariableSetRows(workflow.variableSets)}
          </div>
          <button type="button" class="btn secondary small add-account-btn" data-id="${workflow.id}">添加变量集</button>
          <div class="field">
            <label>默认变量集</label>
            <select class="default-account-select">
              ${workflow.variableSets
                .map(
                  (set) =>
                    `<option value="${set.id}" ${set.id === workflow.defaultVariableSetId ? 'selected' : ''}>${escapeHtml(set.label)}</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label>打开方式</label>
            <select class="edit-open-mode">
              <option value="global" ${workflow.openMode === null ? 'selected' : ''}>跟随全局</option>
              <option value="new_tab" ${workflow.openMode === 'new_tab' ? 'selected' : ''}>新开标签</option>
              <option value="current_tab" ${workflow.openMode === 'current_tab' ? 'selected' : ''}>当前标签</option>
            </select>
          </div>
          <button class="btn success small save-edit-btn" data-id="${workflow.id}">保存修改</button>
        </div>
      </article>
    `;
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

async function handleRunWorkflowManual(workflowId: string, variableSetId?: string): Promise<void> {
  showToast('正在以手工登录模式运行...', 'info');
  try {
    const result = await sendMessage<FillResult>({
      action: 'RUN_WORKFLOW_MANUAL',
      workflowId,
      variableSetId,
    });

    if (result.success) {
      showToast('工作流已执行', 'success');
    } else {
      showToast(result.error ?? '执行失败', 'error');
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function handleRunWorkflow(workflowId: string, variableSetId?: string): Promise<void> {
  showToast('正在运行工作流...', 'info');
  try {
    const result = await sendMessage<FillResult>({
      action: 'RUN_WORKFLOW',
      workflowId,
      variableSetId,
    });

    if (result.success) {
      showToast('工作流已执行', 'success');
    } else {
      showToast(result.error ?? '执行失败，请重新录制或试跑', 'error');
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function loadSettings(): Promise<void> {
  const settings = await sendMessage<GlobalSettings>({ action: 'GET_SETTINGS' });
  ($('default-open-mode') as HTMLSelectElement).value = settings.defaultOpenMode;

  const llm = settings.llm ?? DEFAULT_LLM_SETTINGS;
  ($('llm-enabled') as HTMLInputElement).checked = llm.enabled;
  ($('llm-api-key') as HTMLInputElement).value = llm.apiKey;
  ($('llm-base-url') as HTMLInputElement).value = llm.baseUrl;
  ($('llm-model') as HTMLInputElement).value = llm.model;
  ($('llm-vision-model') as HTMLInputElement).value = llm.visionModel;
  ($('llm-captcha-solver') as HTMLSelectElement).value = llm.captchaSolver;
  ($('llm-auto-plan') as HTMLInputElement).checked = llm.autoPlanEnabled;
  ($('llm-max-steps') as HTMLInputElement).value = String(llm.maxAgentSteps);
}

async function saveSettingsPanel(): Promise<void> {
  const defaultOpenMode = ($('default-open-mode') as HTMLSelectElement)
    .value as GlobalSettings['defaultOpenMode'];

  const maxSteps = Number(($('llm-max-steps') as HTMLInputElement).value);
  const llm = {
    enabled: ($('llm-enabled') as HTMLInputElement).checked,
    apiKey: ($('llm-api-key') as HTMLInputElement).value.trim(),
    baseUrl: ($('llm-base-url') as HTMLInputElement).value.trim() || DEFAULT_LLM_SETTINGS.baseUrl,
    model: ($('llm-model') as HTMLInputElement).value.trim() || DEFAULT_LLM_SETTINGS.model,
    visionModel:
      ($('llm-vision-model') as HTMLInputElement).value.trim() || DEFAULT_LLM_SETTINGS.visionModel,
    captchaSolver: ($('llm-captcha-solver') as HTMLSelectElement).value as GlobalSettings['llm']['captchaSolver'],
    autoPlanEnabled: ($('llm-auto-plan') as HTMLInputElement).checked,
    maxAgentSteps: Number.isFinite(maxSteps) && maxSteps > 0 ? maxSteps : DEFAULT_LLM_SETTINGS.maxAgentSteps,
  };

  await sendMessage<GlobalSettings>({
    action: 'SAVE_SETTINGS',
    settings: { defaultOpenMode, llm },
  });
  ($('settings-message') as HTMLParagraphElement).textContent = '设置已保存';
  showToast('设置已保存', 'success');
}

function bindEvents(): void {
  bindStepEditorEvents();
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-tab');
      if (tab) switchTab(tab);
    });
  });

  $('start-record-btn').addEventListener('click', () => void startRecording());
  $('stop-record-btn').addEventListener('click', () => void stopRecording());
  $('replay-btn').addEventListener('click', () => void replayRecording());
  $('manual-login-replay-btn').addEventListener('click', () => void manualLoginReplayRecording());
  $('open-designer-btn').addEventListener('click', () => void openFlowDesignerFromDraft());
  $('ai-login-btn').addEventListener('click', () => void aiAutoLogin());
  $('save-btn').addEventListener('click', () => void saveSiteFromRecording());
  $('retry-btn').addEventListener('click', resetRecording);
  $('save-settings-btn').addEventListener('click', () => void saveSettingsPanel());

  $('sites-list').addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    if (target.classList.contains('add-custom-variable-btn')) {
      const row = target.closest('.account-row');
      const list = row?.querySelector('.custom-variables-list');
      list?.insertAdjacentHTML('beforeend', renderCustomVariableRow());
      return;
    }

    if (target.classList.contains('remove-custom-variable-btn')) {
      target.closest('.custom-variable-row')?.remove();
      return;
    }

    if (target.classList.contains('remove-account-btn')) {
      const row = target.closest('.account-row');
      const card = target.closest('.site-card');
      const rows = card?.querySelectorAll('.account-row');
      if (rows && rows.length <= 1) {
        showToast('至少保留一个变量集', 'error');
        return;
      }
      row?.remove();
      return;
    }

    const siteId = target.getAttribute('data-id');
    if (!siteId) return;

    if (target.classList.contains('login-btn')) {
      const card = target.closest('.site-card');
      const accountId = (card?.querySelector('.login-account-select') as HTMLSelectElement | null)?.value;
      void handleRunWorkflow(siteId, accountId || undefined);
    }

    if (target.classList.contains('manual-login-btn')) {
      const card = target.closest('.site-card');
      const accountId = (card?.querySelector('.login-account-select') as HTMLSelectElement | null)?.value;
      void handleRunWorkflowManual(siteId, accountId || undefined);
    }

    if (target.classList.contains('canvas-btn')) {
      void (async () => {
        const workflows = await sendMessage<WorkflowRecord[]>({ action: 'GET_WORKFLOWS' });
        const workflow = workflows.find((item) => item.id === siteId);
        if (!workflow) return;
        await openFlowDesignerForWorkflow(normalizeWorkflow(workflow));
      })();
    }

    if (target.classList.contains('add-account-btn')) {
      const editPanel = document.getElementById(`edit-${siteId}`);
      const list = editPanel?.querySelector('.accounts-list');
      if (!list) return;
      const newSet = createVariableSet({ label: '', values: { username: '', password: '' } });
      list.insertAdjacentHTML('beforeend', renderVariableSetRow(newSet, list.querySelectorAll('.account-row').length));
      editPanel?.classList.remove('hidden');
    }

    if (target.classList.contains('delete-btn')) {
      void sendMessage({ action: 'DELETE_WORKFLOW', workflowId: siteId }).then(() => {
        showToast('已删除', 'success');
        void renderSites();
      });
    }

    if (target.classList.contains('edit-btn')) {
      document.getElementById(`edit-${siteId}`)?.classList.toggle('hidden');
    }

    if (target.classList.contains('save-edit-btn')) {
      void (async () => {
        const card = target.closest('.site-card');
        if (!card) return;
        const workflows = await sendMessage<WorkflowRecord[]>({ action: 'GET_WORKFLOWS' });
        const workflow = workflows.find((item) => item.id === siteId);
        if (!workflow) return;

        const openModeValue = (card.querySelector('.edit-open-mode') as HTMLSelectElement).value;
        const variableSets = collectVariableSetsFromCard(card);
        if (variableSets.length === 0) {
          showToast('请至少配置一个变量集', 'error');
          return;
        }

        const validationError = validateVariableSets(variableSets);
        if (validationError) {
          showToast(validationError, 'error');
          return;
        }

        const defaultSelect = card.querySelector('.default-account-select') as HTMLSelectElement;
        let defaultVariableSetId = defaultSelect?.value ?? variableSets[0].id;
        if (!variableSets.some((item) => item.id === defaultVariableSetId)) {
          defaultVariableSetId = variableSets[0].id;
        }

        const updated: WorkflowRecord = {
          ...workflow,
          variableSets,
          defaultVariableSetId,
          openMode:
            openModeValue === 'global'
              ? null
              : (openModeValue as WorkflowRecord['openMode']),
          updatedAt: Date.now(),
        };

        await sendMessage({ action: 'UPDATE_WORKFLOW', workflow: updated });
        showToast('工作流已更新', 'success');
        void renderSites();
      })();
    }
  });
}

async function init(): Promise<void> {
  bindEvents();
  await loadRecordingDraft();
  await applyElementPickerResult();
  if (!($('current-url') as HTMLInputElement).value) {
    const tab = await sendMessage<ActiveTabInfo>({ action: 'GET_ACTIVE_TAB' });
    ($('current-url') as HTMLInputElement).value = tab.url ?? '';
    if (tab.title) {
      ($('site-name') as HTMLInputElement).placeholder = tab.title;
    }
  }
  await loadSettings();
  await renderSites();
  if (!isRecordingActive) {
    updateRecordingUi(false);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes.recordingDraft) return;
    const draft = changes.recordingDraft.newValue as {
      steps?: RecordedStep[];
      status?: string;
      replayPendingSave?: boolean;
      lastReplayResult?: FillResult;
    } | undefined;
    if (!draft || draft.status === 'recording') return;
    if (isRecordingActive) {
      if (Array.isArray(draft.steps)) {
        $('record-message').textContent =
          `录制进行中（${draft.steps.length} 步）。请点页面右上角「完成录制」，或在此点「停止录制」。`;
      }
      return;
    }
    if (Array.isArray(draft.steps)) {
      recordedFlow = draft.steps;
      renderRecordedFlow(recordedFlow);
    }
    applyPendingSaveState(draft);
  });
}

void init();
