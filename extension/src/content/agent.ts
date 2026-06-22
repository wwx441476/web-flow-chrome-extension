import type { FillResult, StepResult, VariableMap } from '../types';
import type { AgentAction, AgentStepRecord } from '../llm/types';
import { agentActionToStep } from '../actions/agent-adapter';
import { executeActionStep } from './action-executor';
import { buildPageSnapshot } from './page-snapshot';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestPlan(
  snapshot: ReturnType<typeof buildPageSnapshot>,
  variables: VariableMap,
  goal: string,
  history: AgentStepRecord[],
): Promise<AgentAction> {
  const response = await chrome.runtime.sendMessage({
    type: 'LLM_PLAN_NEXT',
    snapshot,
    variables,
    goal,
    history,
  });

  if (response?.error) {
    throw new Error(response.error);
  }
  if (!response?.action) {
    throw new Error('大模型未返回下一步操作');
  }
  return response.action as AgentAction;
}

function toStepResult(record: AgentStepRecord, index: number): StepResult {
  return {
    name: `ai_step_${index + 1}`,
    status: record.status === 'success' ? 'success' : 'failed',
    message: [record.action, record.ref, record.variableName, record.reason, record.message]
      .filter(Boolean)
      .join(' · '),
  };
}

export async function runAutomationAgent(
  variables: VariableMap,
  goal = '完成页面上的自动化任务',
): Promise<FillResult> {
  const maxStepsResponse = await chrome.runtime.sendMessage({ type: 'LLM_GET_MAX_STEPS' });
  const maxSteps = Number(maxStepsResponse?.maxSteps) || 20;

  const history: AgentStepRecord[] = [];
  const steps: StepResult[] = [];

  for (let round = 0; round < maxSteps; round += 1) {
    const snapshot = buildPageSnapshot();
    if (snapshot.elements.length === 0) {
      return {
        success: false,
        steps,
        error: '页面上未找到可交互元素',
      };
    }

    const planned = await requestPlan(snapshot, variables, goal, history);
    const record: AgentStepRecord = {
      action: planned.action,
      ref: planned.ref,
      variableName: planned.variableName,
      reason: planned.reason,
      status: 'success',
    };

    if (planned.action === 'done') {
      history.push(record);
      steps.push(toStepResult(record, round));
      return { success: true, steps };
    }

    if (planned.action === 'failed') {
      record.status = 'failed';
      record.message = planned.reason ?? '大模型无法继续';
      history.push(record);
      steps.push(toStepResult(record, round));
      return {
        success: false,
        steps,
        error: record.message,
      };
    }

    try {
      const actionStep = agentActionToStep(planned, snapshot);
      if (!actionStep) {
        throw new Error('无法转换为 Action 步骤');
      }
      await executeActionStep(actionStep, variables);
      history.push(record);
      steps.push(toStepResult(record, round));
      await sleep(400);
    } catch (error) {
      record.status = 'failed';
      record.message = error instanceof Error ? error.message : String(error);
      history.push(record);
      steps.push(toStepResult(record, round));
      return {
        success: false,
        steps,
        error: record.message,
      };
    }
  }

  return {
    success: false,
    steps,
    error: `已达到最大步数限制 (${maxSteps})，可在设置中调大或改用录制模式`,
  };
}

/** @deprecated */
export const runAutoLoginAgent = runAutomationAgent;
