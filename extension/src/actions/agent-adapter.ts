import type { ActionStep } from './types';
import type { AgentAction } from '../llm/types';
import type { PageSnapshot } from '../llm/types';

export function resolveAgentSelector(action: AgentAction, snapshot: PageSnapshot): string {
  if (!action.ref) {
    throw new Error(`操作 ${action.action} 缺少 ref`);
  }
  const element = snapshot.elements.find((item) => item.ref === action.ref);
  if (!element) {
    throw new Error(`找不到元素 ref: ${action.ref}`);
  }
  return element.selector;
}

export function agentActionToStep(action: AgentAction, snapshot: PageSnapshot): ActionStep | null {
  if (action.action === 'done' || action.action === 'failed') {
    return null;
  }

  if (action.action === 'wait') {
    return { type: 'wait', delayMs: action.delayMs ?? 1000, label: action.reason };
  }

  const selector = action.ref ? resolveAgentSelector(action, snapshot) : undefined;

  switch (action.action) {
    case 'click':
      return { type: 'click', selector: selector!, label: action.reason, button: action.button };
    case 'dblclick':
      return { type: 'dblclick', selector: selector!, label: action.reason };
    case 'hover':
      return { type: 'hover', selector: selector!, label: action.reason };
    case 'scroll':
      return {
        type: 'scroll',
        selector: selector,
        top: action.top,
        left: action.left,
        label: action.reason,
      };
    case 'key':
      return {
        type: 'key',
        key: action.key ?? 'Enter',
        selector,
        modifiers: action.modifiers,
        label: action.reason,
      };
    case 'select':
      return {
        type: 'select',
        selector: selector!,
        value: action.value,
        optionText: action.optionText,
        label: action.reason,
      };
    case 'fill_variable':
    case 'fill_username':
    case 'fill_password':
      return {
        type: 'fill',
        fillKind: 'variable',
        selector: selector!,
        variableName:
          action.variableName ??
          (action.action === 'fill_password' ? 'password' : action.action === 'fill_username' ? 'username' : 'value'),
        label: action.reason,
      };
    case 'fill_text':
      return {
        type: 'fill',
        fillKind: 'literal',
        selector: selector!,
        value: action.text ?? '',
        label: action.reason,
      };
    case 'solve_captcha':
      return {
        type: 'fill',
        fillKind: 'captcha',
        selector: selector!,
        label: action.reason,
      };
    default:
      throw new Error(`未知 AI 操作: ${action.action}`);
  }
}
