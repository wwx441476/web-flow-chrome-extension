import type { FillResult, RecordedStep, ReplayProgressStatus, StepResult, VariableMap } from '../types';
import type { ReplaySessionSnapshot } from '../storage/replay-session-storage';
import { actionStepName } from '../actions/describe';
import { waitForManualLoginComplete } from './manual-login-panel';
import { executeStepAtIndex } from './replay';
import { stepSelector } from '../shared/step-form';

export type StepStatus = 'pending' | 'waiting' | ReplayProgressStatus;

export interface ReplaySessionCallbacks {
  onProgress: (index: number, status: StepStatus, message?: string) => void;
  onFlowChanged: (flow: RecordedStep[]) => void;
  onFinished: (result: FillResult) => void;
  onPaused: (index: number, reason: 'step' | 'failed') => void;
}

interface ReplaySessionState {
  flow: RecordedStep[];
  variables: VariableMap;
  nextIndex: number;
  results: StepResult[];
  statuses: StepStatus[];
  running: boolean;
  pendingNavigationStep: number | null;
  waitingManualLogin: boolean;
  manualLoginPageUrl?: string;
  callbacks: ReplaySessionCallbacks;
}

let session: ReplaySessionState | null = null;

function isNavigationSensitiveStep(step: RecordedStep): boolean {
  return step.type === 'navigate';
}

function buildSnapshot(
  overrides: Partial<
    Pick<ReplaySessionSnapshot, 'pendingNavigationStep' | 'waitingManualLogin' | 'nextIndex' | 'results' | 'statuses'>
  > = {},
): Omit<ReplaySessionSnapshot, 'tabId' | 'active' | 'updatedAt'> | null {
  if (!session) return null;
  return {
    flow: session.flow.map((step) => ({ ...step })),
    variables: { ...session.variables },
    nextIndex: overrides.nextIndex ?? session.nextIndex,
    results: overrides.results ?? [...session.results],
    statuses: overrides.statuses ?? [...session.statuses],
    pendingNavigationStep:
      overrides.pendingNavigationStep !== undefined
        ? overrides.pendingNavigationStep
        : session.pendingNavigationStep,
    waitingManualLogin:
      overrides.waitingManualLogin !== undefined ? overrides.waitingManualLogin : session.waitingManualLogin,
    manualLoginPageUrl: session.manualLoginPageUrl,
  };
}

export async function persistReplaySession(
  overrides: Partial<
    Pick<ReplaySessionSnapshot, 'pendingNavigationStep' | 'waitingManualLogin' | 'nextIndex' | 'results' | 'statuses'>
  > = {},
): Promise<void> {
  const payload = buildSnapshot(overrides);
  if (!payload) return;

  try {
    await chrome.runtime.sendMessage({
      action: 'SAVE_REPLAY_SESSION',
      replaySession: payload,
    });
  } catch {
    // Extension may be reloading.
  }
}

export function setManualLoginWaiting(waiting: boolean): void {
  if (!session) return;
  session.waitingManualLogin = waiting;
  if (waiting) {
    session.pendingNavigationStep = session.nextIndex;
    session.manualLoginPageUrl = window.location.href;
    session.statuses[session.nextIndex] = 'waiting';
    session.callbacks.onProgress(session.nextIndex, 'waiting');
  } else {
    if (session.pendingNavigationStep === session.nextIndex) {
      session.pendingNavigationStep = null;
    }
    session.manualLoginPageUrl = undefined;
  }
  void persistReplaySession();
}

export function getReplaySession(): ReplaySessionState | null {
  return session;
}

export function getReplayFlow(): RecordedStep[] {
  return session?.flow ?? [];
}

export function initReplaySession(
  flow: RecordedStep[],
  variables: VariableMap,
  callbacks: ReplaySessionCallbacks,
): void {
  session = {
    flow: flow.map((step) => ({ ...step })),
    variables,
    nextIndex: 0,
    results: [],
    statuses: flow.map(() => 'pending'),
    running: false,
    pendingNavigationStep: null,
    waitingManualLogin: false,
    manualLoginPageUrl: undefined,
    callbacks,
  };
  void persistReplaySession();
}

export function restoreReplaySession(snapshot: ReplaySessionSnapshot, callbacks: ReplaySessionCallbacks): void {
  session = {
    flow: snapshot.flow.map((step) => ({ ...step })),
    variables: { ...snapshot.variables },
    nextIndex: snapshot.nextIndex,
    results: [...snapshot.results],
    statuses: [...snapshot.statuses],
    running: false,
    pendingNavigationStep: snapshot.pendingNavigationStep,
    waitingManualLogin: snapshot.waitingManualLogin,
    manualLoginPageUrl: snapshot.manualLoginPageUrl,
    callbacks,
  };
}

export function resolvePendingNavigationStep(message = '页面跳转后继续'): boolean {
  if (!session) return false;

  const index =
    session.pendingNavigationStep ??
    (session.waitingManualLogin ? session.nextIndex : null);
  if (index === null || index < 0 || index >= session.flow.length) {
    session.pendingNavigationStep = null;
    session.waitingManualLogin = false;
    session.manualLoginPageUrl = undefined;
    return false;
  }

  const step = session.flow[index];
  const name = actionStepName(step, index);
  session.statuses[index] = 'success';
  session.results.push({ name, status: 'success', message });
  session.nextIndex = Math.max(session.nextIndex, index + 1);
  session.pendingNavigationStep = null;
  session.waitingManualLogin = false;
  session.manualLoginPageUrl = undefined;
  session.callbacks.onProgress(index, 'success', message);
  return true;
}

export function clearReplaySession(): void {
  session = null;
  void chrome.runtime.sendMessage({ action: 'CLEAR_REPLAY_SESSION' }).catch(() => {
    // Extension may be reloading.
  });
}

export function patchStepFields(
  step: RecordedStep,
  patch: { selector?: string; label?: string },
): RecordedStep {
  const nextLabel = patch.label !== undefined ? patch.label.trim() || undefined : step.label;
  if (step.type === 'wait') {
    return step;
  }
  if (step.type === 'navigate') {
    return { ...step, label: nextLabel };
  }
  if (step.type === 'manualLogin') {
    return {
      ...step,
      label: nextLabel,
      successSelector: patch.selector !== undefined ? patch.selector || undefined : step.successSelector,
    };
  }
  if (step.type === 'scroll' || step.type === 'key') {
    return {
      ...step,
      label: nextLabel,
      selector: patch.selector !== undefined ? patch.selector || undefined : step.selector,
    };
  }
  if ('selector' in step) {
    return {
      ...step,
      label: nextLabel,
      selector: patch.selector !== undefined ? patch.selector : step.selector,
    };
  }
  return step;
}

export function updateReplayStep(index: number, step: RecordedStep): void {
  if (!session || index < 0 || index >= session.flow.length) return;
  session.flow[index] = step;
  session.callbacks.onFlowChanged([...session.flow]);
  void persistReplaySession();
}

export function resetStatusesFrom(index: number): void {
  if (!session) return;
  for (let i = index; i < session.statuses.length; i += 1) {
    session.statuses[i] = 'pending';
  }
  session.results = session.results.slice(0, index);
  session.nextIndex = index;
  session.pendingNavigationStep = null;
  session.waitingManualLogin = false;
  session.manualLoginPageUrl = undefined;
  void persistReplaySession();
}

function isManualLoginStep(step: RecordedStep | undefined): step is Extract<RecordedStep, { type: 'manualLogin' }> {
  return step?.type === 'manualLogin';
}

function shouldAutoStartManualLogin(): boolean {
  if (!session || session.running) return false;
  const index = session.nextIndex;
  const step = session.flow[index];
  if (!isManualLoginStep(step)) return false;
  const status = session.statuses[index];
  return status === 'pending' || (status === 'running' && !session.waitingManualLogin);
}

export async function autoStartManualLoginIfNeeded(): Promise<void> {
  if (!shouldAutoStartManualLogin()) return;
  await runNextStep();
}

export async function resumeWaitingManualLogin(): Promise<void> {
  if (!session || session.running || !session.waitingManualLogin) return;

  const index = session.nextIndex;
  const step = session.flow[index];
  if (!isManualLoginStep(step)) return;

  session.running = true;
  session.callbacks.onProgress(index, 'waiting');

  const name = actionStepName(step, index);
  try {
    setManualLoginWaiting(true);
    let message: string;
    try {
      const reason = await waitForManualLoginComplete({
        variables: session.variables,
        successSelector: step.successSelector,
        timeoutMs: step.timeoutMs,
        label: step.label,
      });
      message = reason === 'detected' ? '检测到登录成功，继续执行' : '用户确认登录完成，继续执行';
    } finally {
      setManualLoginWaiting(false);
    }
    session.pendingNavigationStep = null;
    session.waitingManualLogin = false;
    session.manualLoginPageUrl = undefined;
    session.results.push({ name, status: 'success', message });
    session.callbacks.onProgress(index, 'success', message);
    session.nextIndex = index + 1;
    await persistReplaySession();

    if (session.nextIndex >= session.flow.length) {
      session.callbacks.onFinished(buildFillResult(true));
      clearReplaySession();
      return;
    }
    session.callbacks.onPaused(session.nextIndex, 'step');
  } catch (error) {
    const failMessage = error instanceof Error ? error.message : String(error);
    session.pendingNavigationStep = null;
    session.waitingManualLogin = false;
    session.manualLoginPageUrl = undefined;
    session.results.push({ name, status: 'failed', message: failMessage });
    session.callbacks.onProgress(index, 'failed', failMessage);
    session.callbacks.onPaused(index, 'failed');
    await persistReplaySession();
  } finally {
    if (session) {
      session.running = false;
    }
  }
}

export function getStepStatus(index: number): StepStatus {
  return session?.statuses[index] ?? 'pending';
}

export function canEditSelector(step: RecordedStep): boolean {
  if (step.type === 'wait' || step.type === 'navigate') return false;
  return true;
}

export function isSessionRunning(): boolean {
  return session?.running ?? false;
}

function buildFillResult(success: boolean, error?: string): FillResult {
  if (!session) {
    return { success: false, steps: [], error: error ?? '回放会话已结束' };
  }
  return {
    success,
    steps: session.results,
    flow: session.flow,
    error: success ? undefined : error ?? '回放失败',
  };
}

async function executeAt(index: number): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!session) {
    return { ok: false, error: '回放会话已结束' };
  }

  const recorded = session.flow[index];
  const name = actionStepName(recorded, index);

  if (isNavigationSensitiveStep(recorded)) {
    session.pendingNavigationStep = index;
    await persistReplaySession({ pendingNavigationStep: index });
  }

  session.callbacks.onProgress(index, recorded.type === 'manualLogin' ? 'waiting' : 'running');

  try {
    const { message } = await executeStepAtIndex(session.flow, index, session.variables);
    session.pendingNavigationStep = null;
    session.waitingManualLogin = false;
    session.manualLoginPageUrl = undefined;
    session.results.push({ name, status: 'success', message });
    session.callbacks.onProgress(index, 'success', message);
    await persistReplaySession();
    return { ok: true, message };
  } catch (error) {
    const failMessage = error instanceof Error ? error.message : String(error);
    session.pendingNavigationStep = null;
    session.waitingManualLogin = false;
    session.manualLoginPageUrl = undefined;
    session.results.push({ name, status: 'failed', message: failMessage });
    session.callbacks.onProgress(index, 'failed', failMessage);
    await persistReplaySession();
    return { ok: false, error: failMessage };
  }
}

export async function runNextStep(): Promise<void> {
  if (!session || session.running) return;
  if (session.nextIndex >= session.flow.length) {
    session.callbacks.onFinished(buildFillResult(true));
    clearReplaySession();
    return;
  }

  session.running = true;
  const index = session.nextIndex;

  try {
    const result = await executeAt(index);
    if (result.ok) {
      session.nextIndex = index + 1;
      if (session.nextIndex >= session.flow.length) {
        session.callbacks.onFinished(buildFillResult(true));
        clearReplaySession();
        return;
      }
      session.callbacks.onPaused(session.nextIndex, 'step');
      await persistReplaySession();
      return;
    }
    session.callbacks.onPaused(index, 'failed');
    await persistReplaySession();
  } finally {
    if (session) {
      session.running = false;
    }
  }
}

export async function runAllRemaining(): Promise<void> {
  if (!session || session.running) return;

  session.running = true;
  try {
    while (session && session.nextIndex < session.flow.length) {
      const index = session.nextIndex;
      const result = await executeAt(index);
      if (!result.ok) {
        session.callbacks.onPaused(index, 'failed');
        await persistReplaySession();
        return;
      }
      session.nextIndex = index + 1;
    }
    if (session) {
      session.callbacks.onFinished(buildFillResult(true));
      clearReplaySession();
    }
  } finally {
    if (session) {
      session.running = false;
    }
  }
}

export async function retryStep(index: number): Promise<void> {
  if (!session || session.running) return;
  resetStatusesFrom(index);
  session.running = true;

  try {
    const result = await executeAt(index);
    if (result.ok) {
      session.nextIndex = index + 1;
      if (session.nextIndex >= session.flow.length) {
        session.callbacks.onFinished(buildFillResult(true));
        clearReplaySession();
        return;
      }
      session.callbacks.onPaused(session.nextIndex, 'step');
      await persistReplaySession();
      return;
    }
    session.callbacks.onPaused(index, 'failed');
    await persistReplaySession();
  } finally {
    if (session) {
      session.running = false;
    }
  }
}

export async function persistFlowToDraft(
  steps?: RecordedStep[],
  options?: { invalidateReplay?: boolean },
): Promise<boolean> {
  const flowToSave = steps ?? session?.flow;
  if (!flowToSave?.length) return false;

  if (session) {
    session.flow = flowToSave.map((step) => ({ ...step }));
    await persistReplaySession();
  }

  try {
    const response = (await chrome.runtime.sendMessage({
      action: 'UPDATE_RECORDING_DRAFT_FLOW',
      flow: flowToSave.map((step) => ({ ...step })),
      invalidateReplay: options?.invalidateReplay === true,
    })) as { ok?: boolean } | undefined;
    return response?.ok === true;
  } catch {
    return false;
  }
}

export function stepEditableSelector(step: RecordedStep): string {
  return stepSelector(step);
}
