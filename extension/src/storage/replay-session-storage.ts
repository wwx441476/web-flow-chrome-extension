import type { RecordedStep, ReplayProgressStatus, StepResult, VariableMap } from '../types';

const SESSION_KEY = 'replaySession';

export type ReplayPanelStepStatus = 'pending' | 'waiting' | ReplayProgressStatus;

export interface ReplaySessionSnapshot {
  tabId: number;
  flow: RecordedStep[];
  variables: VariableMap;
  nextIndex: number;
  results: StepResult[];
  statuses: ReplayPanelStepStatus[];
  /** Step index waiting on page navigation (manual login / navigate) */
  pendingNavigationStep: number | null;
  waitingManualLogin: boolean;
  /** Page URL when manual login wait started; used to detect post-login redirects */
  manualLoginPageUrl?: string;
  active: boolean;
  updatedAt: number;
}

export async function saveReplaySessionSnapshot(snapshot: ReplaySessionSnapshot): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: snapshot });
}

export async function getReplaySessionSnapshot(tabId?: number): Promise<ReplaySessionSnapshot | undefined> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const snapshot = result[SESSION_KEY] as ReplaySessionSnapshot | undefined;
  if (!snapshot?.active) return undefined;
  if (tabId !== undefined && snapshot.tabId !== tabId) return undefined;
  return snapshot;
}

export async function clearReplaySessionSnapshot(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
