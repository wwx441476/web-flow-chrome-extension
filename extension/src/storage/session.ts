import type { Credentials, FillResult, RecordedStep, VariableMap } from '../types';

const SESSION_KEY = 'recordingDraft';

export interface RecordingDraft {
  tabId: number;
  entryUrl: string;
  title: string;
  workflowName: string;
  /** @deprecated */ siteName?: string;
  variables: VariableMap;
  /** @deprecated */ credentials?: Credentials;
  steps: RecordedStep[];
  status: 'recording' | 'completed';
  updatedAt: number;
  lastReplayResult?: FillResult;
  replayPendingSave?: boolean;
}

function normalizeDraft(draft: RecordingDraft): RecordingDraft {
  const variables =
    draft.variables ??
    (draft.credentials
      ? { username: draft.credentials.username, password: draft.credentials.password }
      : { username: '', password: '' });

  return {
    ...draft,
    workflowName: draft.workflowName ?? draft.siteName ?? draft.title,
    variables,
  };
}

export async function saveRecordingDraft(draft: RecordingDraft): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: normalizeDraft(draft) });
}

export async function getRecordingDraft(): Promise<RecordingDraft | undefined> {
  const result = await chrome.storage.session.get(SESSION_KEY);
  const draft = result[SESSION_KEY] as RecordingDraft | undefined;
  return draft ? normalizeDraft(draft) : undefined;
}

export async function clearRecordingDraft(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

export async function updateRecordingDraftSteps(steps: RecordedStep[]): Promise<void> {
  const draft = await getRecordingDraft();
  if (!draft) return;
  await saveRecordingDraft({
    ...draft,
    steps,
    replayPendingSave: false,
    lastReplayResult: undefined,
    updatedAt: Date.now(),
  });
}
