import type { RecordedStep, RecordingState } from '../types';

const recordings = new Map<number, RecordingState>();

export function startRecordingForTab(tabId: number, steps: RecordedStep[] = []): void {
  recordings.set(tabId, { recording: true, steps: [...steps] });
}

export function restoreRecordingForTab(tabId: number, steps: RecordedStep[]): void {
  recordings.set(tabId, { recording: true, steps: [...steps] });
}

export function stopRecordingForTab(tabId: number): RecordedStep[] {
  const state = recordings.get(tabId);
  recordings.delete(tabId);
  return state?.steps ?? [];
}

export function appendRecordedStep(tabId: number, step: RecordedStep): RecordedStep[] {
  const state = recordings.get(tabId) ?? { recording: true, steps: [] };
  const last = state.steps[state.steps.length - 1];

  if (
    last &&
    step.type === 'fill' &&
    last.type === 'fill' &&
    last.selector === step.selector &&
    last.field === step.field
  ) {
    state.steps[state.steps.length - 1] = step;
  } else {
    state.steps.push(step);
  }

  state.recording = true;
  recordings.set(tabId, state);
  return state.steps;
}

export function getRecordingState(tabId: number): RecordingState | undefined {
  return recordings.get(tabId);
}

export function isTabRecording(tabId: number): boolean {
  return recordings.get(tabId)?.recording ?? false;
}
