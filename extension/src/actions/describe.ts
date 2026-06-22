import type { ActionStep } from './types';
import { isFillAction } from './types';

function fillKindLabel(step: Extract<ActionStep, { type: 'fill' }>): string {
  const kind = step.fillKind ?? (step.field === 'captcha' ? 'captcha' : step.value !== undefined ? 'literal' : 'variable');
  if (kind === 'captcha') return '识别图形验证码';
  if (kind === 'literal') {
    const preview = (step.value ?? '').slice(0, 12);
    return preview ? `输入固定文本 "${preview}"` : '输入固定文本';
  }
  const name = step.variableName ?? step.field ?? 'value';
  return `输入变量 ${name}`;
}

export function describeActionStep(step: ActionStep, index: number): string {
  const suffix = step.label ? ` (${step.label})` : '';

  switch (step.type) {
    case 'click': {
      const btn = step.button && step.button !== 'left' ? ` [${step.button}]` : '';
      return `${index + 1}. 点击${btn} ${step.label ?? '元素'}`;
    }
    case 'dblclick':
      return `${index + 1}. 双击 ${step.label ?? '元素'}${suffix}`;
    case 'hover':
      return `${index + 1}. 悬停 ${step.label ?? '元素'}${suffix}`;
    case 'scroll': {
      const target = step.selector ? '元素' : '页面';
      const pos = [step.top !== undefined ? `top=${step.top}` : '', step.left !== undefined ? `left=${step.left}` : '']
        .filter(Boolean)
        .join(', ');
      return `${index + 1}. 滚动${target}${pos ? ` (${pos})` : ''}${suffix}`;
    }
    case 'key': {
      const mods = step.modifiers?.length ? `${step.modifiers.join('+')}+` : '';
      return `${index + 1}. 按键 ${mods}${step.key}${suffix}`;
    }
    case 'select':
      return `${index + 1}. 选择 ${step.optionText ?? step.value ?? '选项'}${suffix}`;
    case 'fill':
      return `${index + 1}. ${fillKindLabel(step)}${suffix}`;
    case 'wait':
      return `${index + 1}. 等待 ${step.delayMs}ms`;
    case 'waitElement':
      return `${index + 1}. 等待元素出现 ${step.label ?? step.selector}${suffix}`;
    case 'navigate':
      return `${index + 1}. 打开网页 ${step.url}${suffix}`;
    case 'extract': {
      const attr = step.attribute && step.attribute !== 'text' ? `.${step.attribute}` : '';
      return `${index + 1}. 提取${attr} → ${step.variableName}${suffix}`;
    }
    case 'manualLogin':
      return `${index + 1}. 手工登录（等待用户操作）${suffix}`;
    default:
      return `${index + 1}. 未知操作`;
  }
}

export function actionStepName(step: ActionStep, index: number): string {
  if (step.type === 'wait') return `wait_${index + 1}`;
  if (step.type === 'waitElement') return `wait_element_${index + 1}`;
  if (step.type === 'navigate') return `navigate_${index + 1}`;
  if (step.type === 'manualLogin') return `manual_login_${index + 1}`;
  if (step.type === 'extract') return `extract_${step.variableName}_${index + 1}`;
  if (isFillAction(step)) {
    const kind = step.fillKind ?? step.field;
    if (kind === 'captcha') return 'fill_captcha';
    if (step.fillKind === 'literal') return 'fill_literal';
    return `fill_${step.variableName ?? step.field ?? 'value'}`;
  }
  return `${step.type}_${index + 1}`;
}
