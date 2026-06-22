import type { ActionStep } from '../actions/types';
import { isFillAction } from '../actions/types';

export interface StepMeta {
  icon: string;
  title: string;
  detail: string;
  tone: string;
}

function truncate(text: string, max = 36): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function getStepMeta(step: ActionStep): StepMeta {
  if (step.type === 'click') {
    return {
      icon: '👆',
      title: '点击',
      detail: step.label ?? truncate(step.selector),
      tone: 'blue',
    };
  }
  if (step.type === 'dblclick') {
    return {
      icon: '👆👆',
      title: '双击',
      detail: step.label ?? truncate(step.selector),
      tone: 'blue',
    };
  }
  if (step.type === 'hover') {
    return {
      icon: '🖱',
      title: '悬停',
      detail: step.label ?? truncate(step.selector),
      tone: 'slate',
    };
  }
  if (step.type === 'scroll') {
    return {
      icon: '↕',
      title: '滚动',
      detail: step.selector ? truncate(step.selector) : '页面',
      tone: 'slate',
    };
  }
  if (step.type === 'key') {
    const mods = step.modifiers?.length ? `${step.modifiers.join('+')}+` : '';
    return {
      icon: '⌨',
      title: '按键',
      detail: `${mods}${step.key}`,
      tone: 'purple',
    };
  }
  if (step.type === 'select') {
    return {
      icon: '▾',
      title: '下拉选择',
      detail: step.optionText ?? step.value ?? truncate(step.selector),
      tone: 'teal',
    };
  }
  if (step.type === 'wait') {
    return {
      icon: '⏱',
      title: '等待',
      detail: `${step.delayMs} ms`,
      tone: 'amber',
    };
  }
  if (step.type === 'waitElement') {
    return {
      icon: '⏳',
      title: '等待元素',
      detail: step.label ?? truncate(step.selector),
      tone: 'amber',
    };
  }
  if (step.type === 'navigate') {
    return {
      icon: '🌐',
      title: '打开网页',
      detail: truncate(step.url, 48),
      tone: 'indigo',
    };
  }
  if (step.type === 'extract') {
    const attr = step.attribute && step.attribute !== 'text' ? `.${step.attribute}` : '';
    return {
      icon: '📋',
      title: '提取文本',
      detail: `${truncate(step.selector)} → ${step.variableName}${attr}`,
      tone: 'green',
    };
  }
  if (step.type === 'manualLogin') {
    const parts = [step.url ? truncate(step.url, 24) : '当前页'].filter(Boolean);
    if (step.successSelector) parts.push(`检测: ${truncate(step.successSelector, 20)}`);
    return {
      icon: '👤',
      title: '手工登录',
      detail: parts.join(' · ') || '等待用户完成登录',
      tone: 'rose',
    };
  }
  if (isFillAction(step)) {
    const kind = step.fillKind ?? step.field;
    if (kind === 'captcha') {
      return { icon: '🔐', title: '验证码', detail: truncate(step.selector), tone: 'orange' };
    }
    if (step.fillKind === 'literal') {
      return {
        icon: '✏',
        title: '固定文本',
        detail: truncate(step.value ?? step.selector),
        tone: 'green',
      };
    }
    const name = step.variableName ?? step.field ?? 'value';
    return {
      icon: '{x}',
      title: '输入变量',
      detail: `${name} · ${truncate(step.selector)}`,
      tone: 'green',
    };
  }

  return { icon: '?', title: '未知', detail: '', tone: 'slate' };
}
