import type { Credentials, FillAction, RecordedStep, VariableSet } from '../types';
import { isFillAction } from '../actions/types';
import { describeActionStep } from '../actions/describe';

const USERNAME_KEY_PATTERN =
  /^(用户名|账号|user(name)?|login(name)?|account|email|手机(号)?|mobile|phone)$/i;
const PASSWORD_KEY_PATTERN = /^(密码|password|pwd|pass(word)?)$/i;

function isUsernameVariableKey(key: string): boolean {
  return key === 'username' || USERNAME_KEY_PATTERN.test(key.trim());
}

function isPasswordVariableKey(key: string): boolean {
  return key === 'password' || PASSWORD_KEY_PATTERN.test(key.trim());
}

export { isUsernameVariableKey, isPasswordVariableKey };

function classifyLoginFieldHint(text: string): 'username' | 'password' | null {
  const part = text.trim();
  if (!part) return null;
  if (isPasswordVariableKey(part) || /password|密码|pwd/i.test(part)) return 'password';
  if (isUsernameVariableKey(part) || /username|用户名|账号|user|login|account|email|手机/i.test(part)) {
    return 'username';
  }
  return null;
}

export function normalizeFillStep(step: FillAction): FillAction {
  if (step.fillKind === 'literal' || step.fillKind === 'variable' || step.fillKind === 'captcha') {
    return step;
  }

  if (step.field === 'captcha') {
    return { ...step, fillKind: 'captcha' };
  }

  if (step.field === 'password') {
    return { ...step, fillKind: 'variable', variableName: step.variableName ?? 'password' };
  }

  if (step.field === 'username') {
    return { ...step, fillKind: 'variable', variableName: step.variableName ?? 'username' };
  }

  if (step.value !== undefined) {
    return { ...step, fillKind: 'literal' };
  }

  if (step.variableName) {
    return { ...step, fillKind: 'variable' };
  }

  return { ...step, fillKind: 'variable', variableName: step.variableName ?? 'value' };
}

/** @deprecated 使用 isFillAction */
export const isFillStep = isFillAction;

export function resolveFillValue(step: FillAction, variables: Record<string, string>): string {
  const normalized = normalizeFillStep(step);

  if (normalized.fillKind === 'literal') {
    return normalized.value ?? '';
  }

  if (normalized.fillKind === 'captcha') {
    throw new Error('验证码步骤应使用 fill captcha 流程');
  }

  const key = normalized.variableName ?? normalized.field ?? 'value';
  if (variables[key] !== undefined) {
    return variables[key];
  }

  if (isUsernameVariableKey(key) && variables.username !== undefined) {
    return variables.username;
  }

  if (isPasswordVariableKey(key) && variables.password !== undefined) {
    return variables.password;
  }

  if (normalized.field === 'username' && variables.username !== undefined) {
    return variables.username;
  }

  if (normalized.field === 'password' && variables.password !== undefined) {
    return variables.password;
  }

  return '';
}

export function variablesFromCredentials(credentials: Credentials): Record<string, string> {
  return {
    username: credentials.username,
    password: credentials.password,
  };
}

export function credentialsFromVariables(variables: Record<string, string>): Credentials {
  return {
    username: variables.username ?? '',
    password: variables.password ?? '',
  };
}

export function variableSetToValues(set: VariableSet): Record<string, string> {
  return { ...set.values };
}

export function accountValuesToVariableSet(input: {
  id: string;
  label: string;
  username: string;
  password: string;
}): VariableSet {
  return {
    id: input.id,
    label: input.label,
    values: {
      username: input.username,
      password: input.password,
    },
  };
}

export function inferVariableName(element: Element): string {
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return 'password';
  }

  const parts = [
    element.getAttribute('name') ?? '',
    element.getAttribute('id') ?? '',
    element.getAttribute('placeholder') ?? '',
    element.getAttribute('aria-label') ?? '',
  ]
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const classified = classifyLoginFieldHint(part);
    if (classified) {
      return classified;
    }
  }

  for (const part of parts) {
    const normalized = part
      .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    if (normalized) {
      return normalized;
    }
  }

  return 'value';
}

/** @deprecated 使用 describeActionStep */
export const describeFlowStep = describeActionStep;
