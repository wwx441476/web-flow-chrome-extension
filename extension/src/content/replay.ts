import type { RecordedStep, ReplayProgressStatus, StepResult, VariableMap } from '../types';
import { actionStepName } from '../actions/describe';
import { executeActionStep } from './action-executor';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeStepAtIndex(
  flow: RecordedStep[],
  index: number,
  variables: VariableMap,
): Promise<{ message: string }> {
  const recorded = flow[index];
  if (!recorded) {
    throw new Error(`步骤 ${index + 1} 不存在`);
  }

  if (recorded.delayMs && recorded.delayMs > 0) {
    await sleep(recorded.delayMs);
  }

  const message = await executeActionStep(recorded, variables);
  return { message };
}

export async function replayFlow(
  flow: RecordedStep[],
  variables: VariableMap,
  onProgress?: (index: number, status: ReplayProgressStatus, message?: string) => void,
): Promise<{ steps: StepResult[]; success: boolean }> {
  const steps: StepResult[] = [];

  if (flow.length === 0) {
    return {
      steps: [{ name: 'replay', status: 'failed', message: '没有录制的操作' }],
      success: false,
    };
  }

  for (let index = 0; index < flow.length; index += 1) {
    const recorded = flow[index];
    const name = actionStepName(recorded, index);

    onProgress?.(index, 'running');

    if (recorded.delayMs && recorded.delayMs > 0) {
      await sleep(recorded.delayMs);
    }

    try {
      const { message } = await executeStepAtIndex(flow, index, variables);
      steps.push({ name, status: 'success', message });
      onProgress?.(index, 'success', message);
    } catch (error) {
      const failMessage = error instanceof Error ? error.message : String(error);
      steps.push({
        name,
        status: 'failed',
        message: failMessage,
      });
      onProgress?.(index, 'failed', failMessage);
      return { steps, success: false };
    }
  }

  return { steps, success: true };
}

export function flowToLegacySelectors(flow: RecordedStep[]): {
  username: string;
  password: string;
  submit: string;
} | null {
  const username = flow.find(
    (step) =>
      step.type === 'fill' &&
      (step.variableName === 'username' || step.field === 'username'),
  );
  const password = flow.find(
    (step) =>
      step.type === 'fill' &&
      (step.variableName === 'password' || step.field === 'password'),
  );
  const submit = [...flow].reverse().find((step) => step.type === 'click');

  if (
    !username ||
    username.type !== 'fill' ||
    !password ||
    password.type !== 'fill' ||
    !submit ||
    submit.type !== 'click'
  ) {
    return null;
  }

  return {
    username: username.selector,
    password: password.selector,
    submit: submit.selector,
  };
}

export function validateFlow(flow: RecordedStep[]): string | null {
  if (flow.length === 0) return '工作流为空，请录制或添加步骤';
  return null;
}
