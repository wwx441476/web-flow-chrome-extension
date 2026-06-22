import { getSettings } from '../storage/settings';
import { solveCaptchaImage } from '../llm/client';
import { planNextAction } from '../llm/planner';
import type { AgentAction, AgentStepRecord, PageSnapshot } from '../llm/types';

export async function handleLlmSolveCaptcha(imageBase64: string): Promise<{ text?: string; error?: string }> {
  try {
    const settings = await getSettings();
    if (!settings.llm.enabled || !settings.llm.apiKey) {
      return { error: '请先在设置中启用大模型并填写 API Key' };
    }

    const text = await solveCaptchaImage(settings.llm, imageBase64);
    if (!text) {
      return { error: '大模型未能识别验证码' };
    }
    return { text };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleLlmPlanNext(payload: {
  snapshot: PageSnapshot;
  variables: Record<string, string>;
  goal?: string;
  history: AgentStepRecord[];
}): Promise<{ action?: AgentAction; error?: string }> {
  try {
    const settings = await getSettings();
    if (!settings.llm.enabled || !settings.llm.apiKey) {
      return { error: '请先在设置中启用大模型并填写 API Key' };
    }
    if (!settings.llm.autoPlanEnabled) {
      return { error: '自动规划未启用，请在设置中开启' };
    }

    const action = await planNextAction(
      settings.llm,
      payload.snapshot,
      payload.variables,
      payload.goal ?? '完成页面上的自动化任务',
      payload.history,
    );
    return { action };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getLlmCaptchaSolver(): Promise<'tesseract' | 'llm' | 'auto'> {
  const settings = await getSettings();
  if (!settings.llm.enabled) {
    return 'tesseract';
  }
  return settings.llm.captchaSolver;
}

export async function getMaxAgentSteps(): Promise<number> {
  const settings = await getSettings();
  return settings.llm.maxAgentSteps ?? 20;
}
