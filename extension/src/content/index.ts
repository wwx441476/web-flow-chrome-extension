import type { ContentMessage, FillResult } from '../types';
import { variablesFromCredentials } from '../storage/variables';
import { detectFormSelectors } from './detect';
import { fillAndSubmit, fillOnly } from './fill';
import { handleRuntimeMessage, isRecording, restoreRecordingIfNeeded } from './recorder';
import {
  finishReplayPanel,
  handleReplayPanelRuntimeMessage,
  restoreReplayIfNeeded,
  showReplayPanel,
} from './replay-panel';
import { flowToLegacySelectors, validateFlow } from './replay';
import { runAutomationAgent } from './agent';
import { handleElementPickerMessage, stopElementPicker } from './element-picker';

function resolveMessageVariables(message: ContentMessage): Record<string, string> {
  if (message.variables) {
    return message.variables;
  }
  if (message.credentials) {
    return variablesFromCredentials(message.credentials);
  }
  return {};
}

async function handleReplay(message: ContentMessage): Promise<FillResult> {
  if (!message.flow) {
    return { success: false, steps: [], error: '缺少工作流步骤' };
  }

  const variables = resolveMessageVariables(message);

  const validationError = validateFlow(message.flow);
  if (validationError) {
    showReplayPanel(message.flow, variables);
    const failedResult: FillResult = {
      success: false,
      steps: [{ name: 'validate_flow', status: 'failed', message: validationError }],
      error: validationError,
    };
    finishReplayPanel(failedResult);
    void chrome.runtime.sendMessage({ type: 'REPLAY_FINISHED', result: failedResult });
    return failedResult;
  }

  showReplayPanel(message.flow, variables);

  return {
    success: true,
    steps: [],
    flow: message.flow,
    selectors: flowToLegacySelectors(message.flow) ?? undefined,
    replayPending: true,
  };
}

async function handleAiAutoRun(message: ContentMessage): Promise<FillResult> {
  const variables = resolveMessageVariables(message);
  return runAutomationAgent(variables, message.goal);
}

async function handleTestRun(message: ContentMessage): Promise<FillResult> {
  const variables = resolveMessageVariables(message);

  if (message.flow && message.flow.length > 0) {
    return handleReplay(message);
  }

  const selectors = detectFormSelectors();
  if (!selectors) {
    return {
      success: false,
      steps: [
        {
          name: 'detect_form',
          status: 'failed',
          message: '未识别到标准表单，请使用「录制操作」或「AI 自动执行」',
        },
      ],
      error: '未识别到标准表单，请使用「录制操作」或「AI 自动执行」',
    };
  }

  const detectStep = {
    name: 'detect_form',
    status: 'success' as const,
    message: `username: ${selectors.username}`,
  };

  const credentials = {
    username: variables.username ?? '',
    password: variables.password ?? '',
  };

  const result = await fillAndSubmit(selectors, credentials);
  return {
    success: result.success,
    steps: [detectStep, ...result.steps],
    selectors,
  };
}

async function handleFillAndSubmit(message: ContentMessage): Promise<FillResult> {
  if (message.flow && message.flow.length > 0) {
    return handleReplay(message);
  }

  if (!message.selectors) {
    return { success: false, steps: [], error: 'Missing selectors' };
  }

  const variables = resolveMessageVariables(message);
  const credentials = {
    username: variables.username ?? '',
    password: variables.password ?? '',
  };

  const result = await fillAndSubmit(message.selectors, credentials);
  return {
    success: result.success,
    steps: result.steps,
    selectors: message.selectors,
    error: result.success ? undefined : 'Fill or submit failed',
  };
}

async function handleFillOnly(message: ContentMessage): Promise<FillResult> {
  if (!message.selectors) {
    return { success: false, steps: [], error: 'Missing selectors' };
  }

  const variables = resolveMessageVariables(message);
  const credentials = {
    username: variables.username ?? '',
    password: variables.password ?? '',
  };

  const result = await fillOnly(message.selectors, credentials);
  return {
    success: result.success,
    steps: result.steps,
    selectors: message.selectors,
  };
}

async function handleDetectForm(): Promise<FillResult> {
  const selectors = detectFormSelectors();
  if (!selectors) {
    return {
      success: false,
      steps: [
        {
          name: 'detect_form',
          status: 'failed',
          message: '未识别到表单，请使用录制模式',
        },
      ],
      error: '未识别到表单，请使用录制模式',
    };
  }

  return {
    success: true,
    steps: [{ name: 'detect_form', status: 'success' }],
    selectors,
  };
}

chrome.runtime.onMessage.addListener((message: ContentMessage & { type?: string }, _sender, sendResponse) => {
  if (message.type && handleReplayPanelRuntimeMessage(message)) {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type && handleRuntimeMessage(message)) {
    sendResponse({ ok: true });
    return true;
  }

  if (message.action && handleElementPickerMessage(message)) {
    sendResponse({ ok: true });
    return true;
  }

  const run = async (): Promise<FillResult | { ok: boolean; recording?: boolean }> => {
    switch (message.action) {
      case 'SHOW_REPLAY_PANEL':
        if (message.flow) {
          showReplayPanel(message.flow, resolveMessageVariables(message));
        }
        return { ok: true };
      case 'START_RECORDING':
        return { ok: true, recording: isRecording() };
      case 'STOP_RECORDING':
        return { ok: true, recording: false };
      case 'START_ELEMENT_PICKER':
        handleElementPickerMessage({ action: 'START_ELEMENT_PICKER' });
        return { ok: true };
      case 'STOP_ELEMENT_PICKER':
        stopElementPicker();
        return { ok: true };
      case 'REPLAY_FLOW':
        return handleReplay(message);
      case 'DETECT_FORM':
        return handleDetectForm();
      case 'FILL_AND_SUBMIT':
        return handleFillAndSubmit(message);
      case 'FILL_ONLY':
        return handleFillOnly(message);
      case 'TEST_RUN':
        return handleTestRun(message);
      case 'AI_AUTO_RUN':
      case 'AI_AUTO_LOGIN':
        return handleAiAutoRun(message);
      default:
        return { success: false, steps: [], error: `Unknown action: ${message.action}` };
    }
  };

  run()
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({
        success: false,
        steps: [],
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

void restoreRecordingIfNeeded();
void restoreReplayIfNeeded();

(window as typeof window & { __webFlowContentLoaded?: boolean }).__webFlowContentLoaded = true;
