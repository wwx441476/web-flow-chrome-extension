import type {
  BackgroundMessage,
  FillResult,
  RecordedStep,
  RecordingState,
  VariableMap,
  WorkflowRecord,
} from '../types';
import type { AgentStepRecord, PageSnapshot } from '../llm/types';
import { getSettings, resolveOpenMode, saveSettings } from '../storage/settings';
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  updateWorkflow,
} from '../storage/sites';
import { resolveWorkflowVariables } from '../storage/accounts';
import { variablesFromCredentials } from '../storage/variables';
import {
  clearRecordingDraft,
  getRecordingDraft,
  saveRecordingDraft,
  updateRecordingDraftSteps,
} from '../storage/session';
import {
  clearReplaySessionSnapshot,
  getReplaySessionSnapshot,
  saveReplaySessionSnapshot,
  type ReplaySessionSnapshot,
} from '../storage/replay-session-storage';
import {
  consumeElementPickerResult,
  saveElementPickerResult,
  setElementPickerActive,
} from '../storage/picker';
import { getDesignerContext } from '../storage/designer-context';
import {
  appendRecordedStep,
  getRecordingState,
  restoreRecordingForTab,
  startRecordingForTab,
  stopRecordingForTab,
} from './recording';
import {
  getLlmCaptchaSolver,
  getMaxAgentSteps,
  handleLlmPlanNext,
  handleLlmSolveCaptcha,
} from './llm';
import { broadcastToAllFrames, runFillAndSubmitOnTab, sendContentMessage, waitForTabComplete } from './tabs';

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function assertUsableTab(tab: chrome.tabs.Tab | undefined): number {
  if (!tab?.id) {
    throw new Error('未找到当前标签页');
  }
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
    throw new Error('无法在浏览器内部页面上运行');
  }
  return tab.id;
}

function entryUrlToQueryPattern(entryUrl: string): string | undefined {
  try {
    const url = new URL(entryUrl);
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return undefined;
  }
}

async function findTabByEntryUrl(entryUrl: string): Promise<number | undefined> {
  const pattern = entryUrlToQueryPattern(entryUrl);
  if (!pattern) return undefined;

  const tabs = await chrome.tabs.query({ url: pattern });
  const normalizedEntry = entryUrl.replace(/\/$/, '');

  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    const normalizedTab = tab.url.replace(/\/$/, '');
    if (normalizedTab === normalizedEntry || tab.url.startsWith(entryUrl)) {
      return tab.id;
    }
  }

  const fallback = tabs.find(
    (tab) =>
      tab.id &&
      tab.url &&
      !tab.url.startsWith('chrome://') &&
      !tab.url.startsWith('chrome-extension://'),
  );
  return fallback?.id;
}

async function tryGetUsableTabId(tabId: number): Promise<number | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return assertUsableTab(tab);
  } catch {
    return undefined;
  }
}

async function resolvePickerTargetTab(
  message: BackgroundMessage,
  senderTabId?: number,
): Promise<number> {
  if (message.tabId !== undefined) {
    const resolved = await tryGetUsableTabId(message.tabId);
    if (resolved !== undefined) return resolved;
  }

  if (senderTabId !== undefined) {
    const resolved = await tryGetUsableTabId(senderTabId);
    if (resolved !== undefined) return resolved;
  }

  const designerContext = await getDesignerContext();
  const entryUrl = message.entryUrl ?? designerContext?.entryUrl;

  if (designerContext?.targetTabId !== undefined) {
    const resolved = await tryGetUsableTabId(designerContext.targetTabId);
    if (resolved !== undefined) return resolved;
  }

  if (entryUrl) {
    const matched = await findTabByEntryUrl(entryUrl);
    if (matched !== undefined) return matched;
  }

  const activeTab = await getActiveTab();
  try {
    return assertUsableTab(activeTab);
  } catch {
    if (entryUrl) {
      throw new Error(`未找到目标页面标签，请先打开：${entryUrl}`);
    }
    throw new Error('请先在目标网站打开对应标签页，再从扩展打开流程画布');
  }
}

async function handleStartElementPicker(
  message: BackgroundMessage,
  senderTabId?: number,
): Promise<{ ok: boolean }> {
  const tabId = await resolvePickerTargetTab(message, senderTabId);

  await setElementPickerActive(true);
  await chrome.tabs.update(tabId, { active: true });
  const delivered = await broadcastToAllFrames(tabId, { action: 'START_ELEMENT_PICKER' });
  if (!delivered) {
    await setElementPickerActive(false);
    throw new Error('无法在页面上启动元素拾取，请刷新目标页面后重试');
  }

  return { ok: true };
}

async function handleStopElementPicker(): Promise<{ ok: boolean }> {
  const tab = await getActiveTab();
  if (tab?.id) {
    await broadcastToAllFrames(tab.id, { action: 'STOP_ELEMENT_PICKER' });
  }
  await setElementPickerActive(false);
  return { ok: true };
}

async function handleSaveDesignerFlow(message: BackgroundMessage): Promise<{ ok: boolean }> {
  const flow = message.flow ?? [];
  const name = message.workflowName ?? message.siteName ?? '未命名工作流';
  const source = message.designerSource ?? message.source ?? 'draft';

  if (source === 'workflow') {
    const workflowId = message.workflowId ?? message.siteId;
    if (!workflowId) {
      throw new Error('Missing workflowId');
    }
    const workflow = await getWorkflow(workflowId);
    if (!workflow) {
      throw new Error('工作流不存在');
    }
    await updateWorkflow({
      ...workflow,
      name,
      entryUrl: message.entryUrl ?? workflow.entryUrl,
      flow,
      updatedAt: Date.now(),
    });

    const draft = await getRecordingDraft();
    if (draft) {
      await saveRecordingDraft({
        ...draft,
        steps: flow,
        workflowName: name,
        entryUrl: message.entryUrl ?? draft.entryUrl,
        updatedAt: Date.now(),
      });
    }

    return { ok: true };
  }

  const draft = await getRecordingDraft();
  if (draft) {
    await saveRecordingDraft({
      ...draft,
      steps: flow,
      workflowName: name,
      entryUrl: message.entryUrl ?? draft.entryUrl,
      updatedAt: Date.now(),
    });
  }

  return { ok: true };
}

async function hydrateRecordingStateFromDraft(tabId: number): Promise<RecordingState | undefined> {
  const existing = getRecordingState(tabId);
  if (existing?.recording) {
    return existing;
  }

  const draft = await getRecordingDraft();
  if (draft && draft.tabId === tabId && draft.status === 'recording') {
    restoreRecordingForTab(tabId, draft.steps);
    return getRecordingState(tabId);
  }

  return existing;
}

async function restoreRecordingSessionsOnStartup(): Promise<void> {
  try {
    const draft = await getRecordingDraft();
    if (draft?.status === 'recording') {
      restoreRecordingForTab(draft.tabId, draft.steps);
    }
  } catch (error) {
    console.error('[Web Flow] Failed to restore recording session:', error);
  }
}

void restoreRecordingSessionsOnStartup();

function resolveMessageVariables(message: BackgroundMessage): VariableMap {
  if (message.variables) {
    return message.variables;
  }
  if (message.credentials) {
    return variablesFromCredentials(message.credentials);
  }
  return {};
}

async function handleStartRecording(message: BackgroundMessage): Promise<{ recording: boolean; steps: RecordedStep[] }> {
  const tab = await getActiveTab();
  const tabId = assertUsableTab(tab);
  const activeTab = tab!;

  const existing = getRecordingState(tabId);
  if (existing?.recording) {
    await stopRecordingByTabId(tabId);
  }

  startRecordingForTab(tabId);

  await saveRecordingDraft({
    tabId,
    entryUrl: message.entryUrl ?? activeTab.url ?? '',
    title: message.title ?? activeTab.title ?? '未命名工作流',
    workflowName:
      message.workflowName ??
      message.siteName ??
      message.title ??
      activeTab.title ??
      '未命名工作流',
    variables: resolveMessageVariables(message),
    steps: [],
    status: 'recording',
    updatedAt: Date.now(),
  });

  await chrome.action.setBadgeText({ text: '录', tabId });
  await chrome.action.setBadgeBackgroundColor({ color: '#991b1b', tabId });

  const delivered = await broadcastToAllFrames(tabId, { type: 'RECORDING_STARTED' });
  if (!delivered) {
    stopRecordingForTab(tabId);
    await clearRecordingDraft();
    throw new Error('无法在页面上启动录制，请刷新目标页面后重试');
  }

  return { recording: true, steps: [] };
}

async function stopRecordingByTabId(tabId: number): Promise<{ recording: boolean; steps: RecordedStep[] }> {
  await broadcastToAllFrames(tabId, { type: 'RECORDING_STOPPED' });
  const state = await hydrateRecordingStateFromDraft(tabId);
  let steps = stopRecordingForTab(tabId);

  if (steps.length === 0 && state?.steps.length) {
    steps = state.steps;
  }

  const draft = await getRecordingDraft();

  if (draft && draft.tabId === tabId) {
    await saveRecordingDraft({
      ...draft,
      steps,
      status: 'completed',
      updatedAt: Date.now(),
    });
  }

  await chrome.action.setBadgeText({ text: steps.length > 0 ? String(steps.length) : '!', tabId });
  await chrome.action.setBadgeBackgroundColor({ color: '#059669', tabId });
  return { recording: false, steps };
}

async function handleStopRecording(): Promise<{ recording: boolean; steps: RecordedStep[] }> {
  const tab = await getActiveTab();
  const tabId = assertUsableTab(tab);
  return stopRecordingByTabId(tabId);
}

async function handleReplayRecording(
  variables: VariableMap,
  flow: RecordedStep[],
  workflowName?: string,
  tabIdOverride?: number,
): Promise<FillResult> {
  let tabId = tabIdOverride;
  if (tabId === undefined) {
    const tab = await getActiveTab();
    tabId = assertUsableTab(tab);
  }

  const draft = await getRecordingDraft();
  // Prefer draft steps: replay-panel edits persist to draft while popup may still hold stale flow.
  const stepsToRun = draft?.steps?.length ? draft.steps : (flow?.length ? flow : []);
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (draft) {
    await saveRecordingDraft({
      ...draft,
      tabId,
      variables,
      steps: stepsToRun,
      entryUrl: draft.entryUrl || tab?.url || '',
      title: draft.title || tab?.title || '未命名工作流',
      workflowName: workflowName ?? draft.workflowName,
      replayPendingSave: false,
      lastReplayResult: undefined,
      updatedAt: Date.now(),
    });
  } else {
    await saveRecordingDraft({
      tabId,
      entryUrl: tab?.url ?? '',
      title: tab?.title ?? '未命名工作流',
      workflowName: workflowName ?? tab?.title ?? '未命名工作流',
      variables,
      steps: stepsToRun,
      status: 'completed',
      updatedAt: Date.now(),
    });
  }

  const result = await sendContentMessage<FillResult>(tabId, {
    action: 'REPLAY_FLOW',
    flow: stepsToRun,
    variables,
  });

  const finalResult = result ?? { success: false, steps: [], error: '未收到页面响应，请刷新后重试' };

  if (finalResult.replayPending) {
    return finalResult;
  }

  const latestDraft = await getRecordingDraft();
  if (latestDraft) {
    await saveRecordingDraft({
      ...latestDraft,
      lastReplayResult: finalResult,
      replayPendingSave: finalResult.success,
      updatedAt: Date.now(),
    });
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'REPLAY_FINISHED', result: finalResult }, { frameId: 0 });
  } catch {
    // Panel may already have received finish event from content script.
  }

  return finalResult;
}

async function handleUpdateRecordingDraftFlow(
  flow: RecordedStep[],
  tabId?: number,
): Promise<{ ok: boolean }> {
  const draft = await getRecordingDraft();
  if (draft) {
    await saveRecordingDraft({
      ...draft,
      ...(tabId !== undefined ? { tabId } : {}),
      steps: flow,
      replayPendingSave: false,
      lastReplayResult: undefined,
      updatedAt: Date.now(),
    });
    return { ok: true };
  }

  const replaySession = await getReplaySessionSnapshot(tabId);
  const effectiveTabId = tabId ?? replaySession?.tabId;
  if (!effectiveTabId) {
    return { ok: false };
  }

  const tab = await chrome.tabs.get(effectiveTabId).catch(() => null);
  await saveRecordingDraft({
    tabId: effectiveTabId,
    entryUrl: tab?.url ?? replaySession?.manualLoginPageUrl ?? '',
    title: tab?.title ?? '未命名工作流',
    workflowName: tab?.title ?? '未命名工作流',
    variables: replaySession?.variables ?? { username: '', password: '' },
    steps: flow,
    status: 'completed',
    updatedAt: Date.now(),
  });
  return { ok: true };
}

async function handleReplayFinished(result: FillResult): Promise<{ ok: boolean }> {
  const draft = await getRecordingDraft();
  if (!draft) {
    return { ok: true };
  }
  await saveRecordingDraft({
    ...draft,
    steps: result.flow ?? draft.steps,
    lastReplayResult: result,
    replayPendingSave: result.success,
    updatedAt: Date.now(),
  });
  return { ok: true };
}

function ensureManualLoginStep(flow: RecordedStep[]): RecordedStep[] {
  if (flow.some((step) => step.type === 'manualLogin')) {
    return flow;
  }
  const navigateIndex = flow.findIndex((step) => step.type === 'navigate');
  const insertAt = navigateIndex >= 0 ? navigateIndex + 1 : 0;
  const next = [...flow];
  next.splice(insertAt, 0, { type: 'manualLogin', label: '手工登录' });
  return next;
}

async function handleManualLoginReplay(
  variables: VariableMap,
  flow: RecordedStep[],
  entryUrl: string,
  workflowName?: string,
): Promise<FillResult> {
  if (!entryUrl) {
    return { success: false, steps: [], error: '缺少入口地址' };
  }

  const tab = await chrome.tabs.create({ url: entryUrl, active: true });
  if (!tab.id) {
    return { success: false, steps: [], error: '无法打开新标签页' };
  }

  await waitForTabComplete(tab.id);
  await new Promise((resolve) => setTimeout(resolve, 800));

  const preparedFlow = ensureManualLoginStep(flow);
  return handleReplayRecording(variables, preparedFlow, workflowName, tab.id);
}

async function handleAiAutoRun(variables: VariableMap, goal?: string): Promise<FillResult> {
  const settings = await getSettings();
  if (!settings.llm.enabled || !settings.llm.apiKey) {
    return {
      success: false,
      steps: [],
      error: '请先在设置中启用大模型并填写 API Key',
    };
  }

  const tab = await getActiveTab();
  const tabId = assertUsableTab(tab);

  const result = await sendContentMessage<FillResult>(tabId, {
    action: 'AI_AUTO_RUN',
    variables,
    goal,
  });

  return result ?? { success: false, steps: [], error: '未收到页面响应，请刷新后重试' };
}

async function handleTestRun(
  variables: VariableMap,
  flow?: RecordedStep[],
): Promise<FillResult> {
  const tab = await getActiveTab();
  const tabId = assertUsableTab(tab);

  const result = await sendContentMessage<FillResult>(tabId, {
    action: 'TEST_RUN',
    variables,
    flow,
  });

  return result ?? { success: false, steps: [], error: '未收到页面响应，请刷新后重试' };
}

async function handleRunWorkflowManual(
  workflowId: string,
  variableSetId?: string,
): Promise<FillResult> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    return { success: false, steps: [], error: '工作流不存在' };
  }

  let variables: VariableMap;
  try {
    ({ variables } = resolveWorkflowVariables(workflow, variableSetId));
  } catch (error) {
    return {
      success: false,
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const flow = workflow.flow?.length ? ensureManualLoginStep(workflow.flow) : workflow.flow;
  return handleManualLoginReplay(variables, flow, workflow.entryUrl, workflow.name);
}

async function handleRunWorkflow(
  workflowId: string,
  variableSetId?: string,
): Promise<FillResult> {
  const workflow = await getWorkflow(workflowId);
  if (!workflow) {
    return { success: false, steps: [], error: '工作流不存在' };
  }

  let variables: VariableMap;
  try {
    ({ variables } = resolveWorkflowVariables(workflow, variableSetId));
  } catch (error) {
    return {
      success: false,
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const settings = await getSettings();
  const openMode = resolveOpenMode(workflow.openMode, settings);

  let tabId: number;

  if (openMode === 'new_tab') {
    const tab = await chrome.tabs.create({ url: workflow.entryUrl, active: true });
    if (!tab.id) {
      return { success: false, steps: [], error: 'Failed to create tab' };
    }
    tabId = tab.id;
  } else {
    const tab = await getActiveTab();
    if (!tab?.id) {
      return { success: false, steps: [], error: 'No active tab' };
    }
    await chrome.tabs.update(tab.id, { url: workflow.entryUrl, active: true });
    tabId = tab.id;
  }

  try {
    return await runFillAndSubmitOnTab(tabId, {
      action: 'FILL_AND_SUBMIT',
      flow: workflow.flow,
      selectors: workflow.selectors,
      variables,
    });
  } catch (error) {
    return {
      success: false,
      steps: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleSaveWorkflow(workflow: WorkflowRecord): Promise<WorkflowRecord> {
  return saveWorkflow(workflow);
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage & {
  type?: string;
  step?: RecordedStep;
  imageBase64?: string;
  snapshot?: PageSnapshot;
  variables?: VariableMap;
  goal?: string;
  history?: AgentStepRecord[];
  selector?: string;
  label?: string;
  result?: FillResult;
}, sender, sendResponse) => {
  if (message.type === 'REPLAY_PROGRESS') {
    return false;
  }

  if (message.type === 'REPLAY_FINISHED' && message.result) {
    void handleReplayFinished(message.result as FillResult)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'ELEMENT_PICKED' && message.selector) {
    void saveElementPickerResult({
      selector: message.selector as string,
      label: typeof message.label === 'string' ? message.label : undefined,
      pickedAt: Date.now(),
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'ELEMENT_PICKER_CANCELLED') {
    void setElementPickerActive(false).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'LLM_SOLVE_CAPTCHA' && message.imageBase64) {
    void handleLlmSolveCaptcha(message.imageBase64 as string)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'LLM_PLAN_NEXT' && message.snapshot) {
    void handleLlmPlanNext({
      snapshot: message.snapshot,
      variables: message.variables ?? {},
      goal: message.goal,
      history: message.history ?? [],
    })
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'LLM_GET_CAPTCHA_SOLVER') {
    void getLlmCaptchaSolver()
      .then((solver) => sendResponse({ solver }))
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'LLM_GET_MAX_STEPS') {
    void getMaxAgentSteps()
      .then((maxSteps) => sendResponse({ maxSteps }))
      .catch((error: unknown) => {
        sendResponse({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (message.type === 'APPEND_RECORDED_STEP' && sender.tab?.id && message.step) {
    const tabId = sender.tab.id;
    const runAppend = async (): Promise<{ steps: RecordedStep[] }> => {
      await hydrateRecordingStateFromDraft(tabId);
      const steps = appendRecordedStep(tabId, message.step!);
      await updateRecordingDraftSteps(steps);
      await broadcastToAllFrames(tabId, { type: 'RECORDING_STEP_UPDATED', count: steps.length });
      return { steps };
    };

    runAppend()
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  const run = async (): Promise<unknown> => {
    switch (message.action) {
      case 'GET_SETTINGS':
        return getSettings();
      case 'SAVE_SETTINGS':
        if (!message.settings) throw new Error('Missing settings');
        await saveSettings(message.settings);
        return getSettings();
      case 'GET_WORKFLOWS':
      case 'GET_SITES':
        return listWorkflows();
      case 'GET_WORKFLOW':
      case 'GET_SITE': {
        const id = message.workflowId ?? message.siteId;
        if (!id) throw new Error('Missing workflowId');
        return getWorkflow(id);
      }
      case 'SAVE_WORKFLOW':
      case 'SAVE_SITE': {
        const workflow = message.workflow ?? message.site;
        if (!workflow) throw new Error('Missing workflow');
        return handleSaveWorkflow(workflow);
      }
      case 'UPDATE_WORKFLOW':
      case 'UPDATE_SITE': {
        const workflow = message.workflow ?? message.site;
        if (!workflow) throw new Error('Missing workflow');
        return updateWorkflow({ ...workflow, updatedAt: Date.now() });
      }
      case 'DELETE_WORKFLOW':
      case 'DELETE_SITE': {
        const id = message.workflowId ?? message.siteId;
        if (!id) throw new Error('Missing workflowId');
        await deleteWorkflow(id);
        return { ok: true };
      }
      case 'GET_ACTIVE_TAB': {
        const tab = await getActiveTab();
        return { id: tab?.id, url: tab?.url, title: tab?.title };
      }
      case 'START_RECORDING':
        return handleStartRecording(message);
      case 'STOP_RECORDING':
        return handleStopRecording();
      case 'STOP_RECORDING_FROM_PAGE':
        if (!sender.tab?.id) throw new Error('Missing tab');
        return stopRecordingByTabId(sender.tab.id);
      case 'GET_RECORDING_DRAFT': {
        const draft = await getRecordingDraft();
        if (!draft) return undefined;

        const state = await hydrateRecordingStateFromDraft(draft.tabId);
        if (draft.status === 'recording' && state?.recording) {
          return { ...draft, steps: state.steps };
        }

        return draft;
      }
      case 'CLEAR_RECORDING_DRAFT':
        await clearRecordingDraft();
        return { ok: true };
      case 'CHECK_RECORDING': {
        if (!sender.tab?.id) return { recording: false, stepCount: 0 };
        const state = await hydrateRecordingStateFromDraft(sender.tab.id);
        return {
          recording: state?.recording ?? false,
          stepCount: state?.steps.length ?? 0,
        };
      }
      case 'SAVE_DESIGNER_FLOW':
        return handleSaveDesignerFlow(message);
      case 'UPDATE_RECORDING_DRAFT_FLOW': {
        if (!message.flow) throw new Error('Missing flow');
        return handleUpdateRecordingDraftFlow(message.flow, sender.tab?.id);
      }
      case 'SAVE_REPLAY_SESSION': {
        if (!sender.tab?.id || !message.replaySession) {
          return { ok: false };
        }
        const replaySession = message.replaySession as Omit<
          ReplaySessionSnapshot,
          'tabId' | 'active' | 'updatedAt'
        >;
        await saveReplaySessionSnapshot({
          ...replaySession,
          tabId: sender.tab.id,
          active: true,
          updatedAt: Date.now(),
        });
        return { ok: true };
      }
      case 'CHECK_REPLAY_SESSION': {
        if (!sender.tab?.id) return { active: false };
        const replaySession = await getReplaySessionSnapshot(sender.tab.id);
        if (!replaySession) return { active: false };
        return { active: true, replaySession };
      }
      case 'CLEAR_REPLAY_SESSION':
        await clearReplaySessionSnapshot();
        return { ok: true };
      case 'GET_ELEMENT_PICKER_RESULT':
        return consumeElementPickerResult();
      case 'START_ELEMENT_PICKER':
        return handleStartElementPicker(message, sender.tab?.id);
      case 'STOP_ELEMENT_PICKER':
        return handleStopElementPicker();
      case 'REPLAY_RECORDING': {
        if (!message.flow) throw new Error('Missing flow');
        return handleReplayRecording(
          resolveMessageVariables(message),
          message.flow,
          message.workflowName ?? message.siteName,
        );
      }
      case 'MANUAL_LOGIN_REPLAY': {
        if (!message.flow) throw new Error('Missing flow');
        const entryUrl = message.entryUrl ?? '';
        return handleManualLoginReplay(
          resolveMessageVariables(message),
          message.flow,
          entryUrl,
          message.workflowName ?? message.siteName,
        );
      }
      case 'TEST_RUN':
        return handleTestRun(resolveMessageVariables(message), message.flow);
      case 'AI_AUTO_RUN':
      case 'AI_AUTO_LOGIN':
        return handleAiAutoRun(resolveMessageVariables(message), message.goal);
      case 'RUN_WORKFLOW':
      case 'ONE_CLICK_LOGIN': {
        const id = message.workflowId ?? message.siteId;
        if (!id) throw new Error('Missing workflowId');
        return handleRunWorkflow(id, message.variableSetId ?? message.accountId);
      }
      case 'RUN_WORKFLOW_MANUAL': {
        const id = message.workflowId ?? message.siteId;
        if (!id) throw new Error('Missing workflowId');
        return handleRunWorkflowManual(id, message.variableSetId ?? message.accountId);
      }
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  };

  run()
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

export { getRecordingState };

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;

  void (async () => {
    const state = await hydrateRecordingStateFromDraft(details.tabId);
    if (state?.recording) {
      await broadcastToAllFrames(details.tabId, {
        type: 'RECORDING_RESUMED',
        count: state.steps.length,
      });
    }

    const replaySession = await getReplaySessionSnapshot(details.tabId);
    if (!replaySession?.active) return;

    try {
      await chrome.tabs.sendMessage(
        details.tabId,
        { type: 'RESTORE_REPLAY_PANEL', replaySession },
        { frameId: 0 },
      );
    } catch {
      // Content script will restore on load via CHECK_REPLAY_SESSION.
    }
  })();
});
