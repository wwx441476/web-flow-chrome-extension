import type { ActionStep, FillAction, ManualLoginAction, MouseButton } from '../actions/types';
import type { VariableMap } from '../types';
import { normalizeFillStep, resolveFillValue } from '../storage/variables';
import { fillCaptchaField } from './captcha';
import { clickElement, fillField, waitForElement } from './fill';
import { getElementText } from './deep-query';
import { waitForManualLoginComplete } from './manual-login-panel';
import { setManualLoginWaiting } from './replay-session';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dispatchMouse(
  element: HTMLElement,
  type: 'mousedown' | 'mouseup' | 'click' | 'dblclick' | 'contextmenu' | 'mouseover' | 'mouseenter',
  button: MouseButton = 'left',
): void {
  const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      button: buttonCode,
      buttons: type === 'mouseup' || type === 'click' ? 0 : buttonCode,
    }),
  );
}

export function clickElementWithButton(element: HTMLElement, button: MouseButton = 'left'): void {
  if (button === 'left') {
    clickElement(element);
    return;
  }
  dispatchMouse(element, 'mousedown', button);
  dispatchMouse(element, 'mouseup', button);
  if (button === 'right') {
    dispatchMouse(element, 'contextmenu', button);
  }
}

export function doubleClickElement(element: HTMLElement): void {
  dispatchMouse(element, 'mousedown');
  dispatchMouse(element, 'mouseup');
  dispatchMouse(element, 'click');
  dispatchMouse(element, 'mousedown');
  dispatchMouse(element, 'mouseup');
  dispatchMouse(element, 'click');
  dispatchMouse(element, 'dblclick');
}

export function hoverElement(element: HTMLElement): void {
  dispatchMouse(element, 'mouseover');
  dispatchMouse(element, 'mouseenter');
}

export async function scrollTarget(
  selector: string | undefined,
  top?: number,
  left?: number,
): Promise<void> {
  const scrollTop = top ?? 0;
  const scrollLeft = left ?? 0;

  if (!selector) {
    window.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'smooth' });
    return;
  }

  const element = await waitForElement(selector);
  element.scrollTo({ top: scrollTop, left: scrollLeft, behavior: 'smooth' });
}

function keyboardInit(modifiers: string[] = []): KeyboardEventInit {
  return {
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.some((m) => /ctrl|control/i.test(m)),
    shiftKey: modifiers.some((m) => /shift/i.test(m)),
    altKey: modifiers.some((m) => /alt/i.test(m)),
    metaKey: modifiers.some((m) => /meta|cmd|command/i.test(m)),
  };
}

export async function pressKeyAction(
  key: string,
  selector?: string,
  modifiers: string[] = [],
): Promise<void> {
  let target: HTMLElement = document.body;
  if (selector) {
    target = await waitForElement(selector);
  }
  target.focus();

  const init = keyboardInit(modifiers);
  for (const mod of modifiers) {
    target.dispatchEvent(new KeyboardEvent('keydown', { ...init, key: mod, code: mod }));
  }
  target.dispatchEvent(new KeyboardEvent('keydown', { ...init, key, code: key }));
  target.dispatchEvent(new KeyboardEvent('keyup', { ...init, key, code: key }));
  for (const mod of [...modifiers].reverse()) {
    target.dispatchEvent(new KeyboardEvent('keyup', { ...init, key: mod, code: mod }));
  }
}

export async function selectOption(
  selector: string,
  value?: string,
  optionText?: string,
): Promise<void> {
  const element = await waitForElement(selector);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error('目标不是 select 元素');
  }

  if (value !== undefined) {
    element.value = value;
  } else if (optionText) {
    const option = Array.from(element.options).find(
      (item) => item.text.trim() === optionText || item.label.trim() === optionText,
    );
    if (!option) {
      throw new Error(`未找到选项: ${optionText}`);
    }
    element.value = option.value;
  } else {
    throw new Error('select 需要 value 或 optionText');
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function executeExtract(
  step: Extract<ActionStep, { type: 'extract' }>,
  variables: VariableMap,
): Promise<string> {
  const element = await waitForElement(step.selector, step.timeoutMs);
  let value = '';

  if (step.attribute === 'value') {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      value = element.value;
    } else if (element instanceof HTMLSelectElement) {
      value = element.value;
    }
  } else if (step.attribute === 'href' && element instanceof HTMLAnchorElement) {
    value = element.href;
  } else {
    value = getElementText(element) || element.textContent?.trim() || '';
  }

  variables[step.variableName] = value;
  const preview = value.length > 40 ? `${value.slice(0, 40)}…` : value;
  return `提取 ${step.variableName}: ${preview}`;
}

async function executeFill(step: FillAction, variables: VariableMap): Promise<string> {
  const normalized = normalizeFillStep(step);
  if (normalized.fillKind === 'captcha') {
    const result = await fillCaptchaField(step.selector, step.imageSelector);
    return `验证码: ${result.text}`;
  }

  const element = await waitForElement(step.selector);
  const value = resolveFillValue(step, variables);
  fillField(element, value);
  return step.label ?? step.selector;
}

async function waitForManualLoginPanel(
  step: ManualLoginAction,
  variables: VariableMap,
): Promise<string> {
  setManualLoginWaiting(true);
  try {
    const reason = await waitForManualLoginComplete({
      variables,
      successSelector: step.successSelector,
      timeoutMs: step.timeoutMs,
      label: step.label,
    });

    return reason === 'detected' ? '检测到登录成功，继续执行' : '用户确认登录完成，继续执行';
  } finally {
    setManualLoginWaiting(false);
  }
}

async function executeManualLogin(step: ManualLoginAction, variables: VariableMap): Promise<string> {
  if (step.url) {
    window.location.assign(step.url);
    await sleep(1200);
  }

  return waitForManualLoginPanel(step, variables);
}

/** Resume manual login after page restore without re-navigating to step.url */
export async function resumeManualLoginPanel(
  step: ManualLoginAction,
  variables: VariableMap,
): Promise<string> {
  return waitForManualLoginPanel(step, variables);
}

export async function executeActionStep(step: ActionStep, variables: VariableMap): Promise<string> {
  switch (step.type) {
    case 'wait':
      await sleep(step.delayMs);
      return `等待 ${step.delayMs}ms`;
    case 'click': {
      const element = await waitForElement(step.selector);
      clickElementWithButton(element, step.button ?? 'left');
      await sleep(350);
      return step.label ?? step.selector;
    }
    case 'dblclick': {
      const element = await waitForElement(step.selector);
      doubleClickElement(element);
      return step.label ?? step.selector;
    }
    case 'hover': {
      const element = await waitForElement(step.selector);
      hoverElement(element);
      return step.label ?? step.selector;
    }
    case 'scroll':
      await scrollTarget(step.selector, step.top, step.left);
      return step.label ?? step.selector ?? 'window';
    case 'key':
      await pressKeyAction(step.key, step.selector, step.modifiers);
      return step.label ?? step.key;
    case 'select':
      await selectOption(step.selector, step.value, step.optionText);
      return step.label ?? step.optionText ?? step.value ?? step.selector;
    case 'fill':
      return executeFill(step, variables);
    case 'waitElement':
      await waitForElement(step.selector, step.timeoutMs);
      return step.label ?? `元素已出现: ${step.selector}`;
    case 'navigate':
      window.location.assign(step.url);
      return `打开 ${step.url}`;
    case 'extract':
      return executeExtract(step, variables);
    case 'manualLogin':
      return executeManualLogin(step, variables);
    default: {
      const _exhaustive: never = step;
      throw new Error(`未知操作: ${(_exhaustive as ActionStep).type}`);
    }
  }
}

export async function runActionSteps(
  flow: ActionStep[],
  variables: VariableMap,
  hooks?: {
    beforeStep?: (index: number, step: ActionStep) => void;
    afterStep?: (index: number, step: ActionStep, message: string) => void;
    onError?: (index: number, step: ActionStep, error: Error) => void;
  },
): Promise<{ messages: string[]; success: boolean; failedIndex?: number; error?: string }> {
  const messages: string[] = [];

  for (let index = 0; index < flow.length; index += 1) {
    const step = flow[index];
    hooks?.beforeStep?.(index, step);

    if (step.delayMs && step.delayMs > 0 && step.type !== 'wait') {
      await sleep(step.delayMs);
    }

    try {
      const message = await executeActionStep(step, variables);
      messages.push(message);
      hooks?.afterStep?.(index, step, message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      hooks?.onError?.(index, step, err);
      return {
        messages,
        success: false,
        failedIndex: index,
        error: err.message,
      };
    }
  }

  return { messages, success: true };
}
