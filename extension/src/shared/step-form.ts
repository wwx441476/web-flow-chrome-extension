import type { RecordedStep } from '../types';

export interface StepFormRefs {
  typeSelect: HTMLSelectElement;
  selectorInput: HTMLInputElement;
  labelInput: HTMLInputElement;
  delayInput: HTMLInputElement;
  navigateUrlInput: HTMLInputElement;
  waitTimeoutInput: HTMLInputElement;
  extractVariableInput: HTMLInputElement;
  extractAttributeSelect: HTMLSelectElement;
  scrollTopInput: HTMLInputElement;
  scrollLeftInput: HTMLInputElement;
  keyInput: HTMLInputElement;
  modifiersInput: HTMLInputElement;
  selectValueInput: HTMLInputElement;
  selectTextInput: HTMLInputElement;
  variableNameInput: HTMLInputElement;
  literalValueInput: HTMLInputElement;
  imageSelectorInput: HTMLInputElement;
  selectorField: HTMLElement;
  selectorHint: HTMLElement | null;
  delayField: HTMLElement;
  navigateField: HTMLElement;
  waitElementField: HTMLElement;
  extractFields: HTMLElement;
  scrollFields: HTMLElement;
  keyFields: HTMLElement;
  selectFields: HTMLElement;
  variableNameField: HTMLElement;
  literalValueField: HTMLElement;
  imageSelectorField: HTMLElement;
  pickButton: HTMLButtonElement | null;
}

export function stepSelector(step: RecordedStep): string {
  if (step.type === 'wait' || step.type === 'navigate') {
    return '';
  }
  if (step.type === 'manualLogin') {
    return step.successSelector ?? '';
  }
  if (step.type === 'key') {
    return step.selector ?? '';
  }
  if ('selector' in step && typeof step.selector === 'string') {
    return step.selector;
  }
  return '';
}

export function stepTypeValue(step: RecordedStep): string {
  if (step.type === 'click') return 'click';
  if (step.type === 'dblclick') return 'dblclick';
  if (step.type === 'hover') return 'hover';
  if (step.type === 'scroll') return 'scroll';
  if (step.type === 'key') return 'key';
  if (step.type === 'select') return 'select';
  if (step.type === 'wait') return 'wait';
  if (step.type === 'waitElement') return 'wait-element';
  if (step.type === 'navigate') return 'navigate';
  if (step.type === 'manualLogin') return 'manual-login';
  if (step.type === 'extract') return 'extract';
  if (step.type === 'fill') {
    if (step.fillKind === 'captcha' || step.field === 'captcha') return 'fill-captcha';
    if (step.fillKind === 'literal') return 'fill-literal';
    if (step.variableName === 'password' || step.field === 'password') return 'fill-password';
    if (step.variableName === 'username' || step.field === 'username') return 'fill-username';
    return 'fill-variable';
  }
  return 'click';
}

export function updateStepFormVisibility(refs: StepFormRefs): void {
  const type = refs.typeSelect.value;
  const isWait = type === 'wait';
  const isWaitElement = type === 'wait-element';
  const isNavigate = type === 'navigate';
  const isManualLogin = type === 'manual-login';
  const isExtract = type === 'extract';
  const isScroll = type === 'scroll';
  const isKey = type === 'key';
  const isSelect = type === 'select';
  const isCaptcha = type === 'fill-captcha';
  const isLiteral = type === 'fill-literal';
  const isVariable = type === 'fill-variable';
  const needsSelector = !isWait && !isScroll && !isNavigate && !isManualLogin;

  refs.selectorField.classList.toggle('hidden', !needsSelector && !isScroll && !isManualLogin);
  refs.selectorHint?.classList.toggle('hidden', !isScroll && !isKey && !isManualLogin);
  refs.delayField.classList.toggle('hidden', !isWait);
  refs.navigateField.classList.toggle('hidden', !isNavigate && !isManualLogin);
  refs.waitElementField.classList.toggle('hidden', !isWaitElement && !isExtract && !isManualLogin);
  refs.extractFields.classList.toggle('hidden', !isExtract);
  refs.scrollFields.classList.toggle('hidden', !isScroll);
  refs.keyFields.classList.toggle('hidden', !isKey);
  refs.selectFields.classList.toggle('hidden', !isSelect);
  refs.variableNameField.classList.toggle('hidden', !isVariable);
  refs.literalValueField.classList.toggle('hidden', !isLiteral);
  refs.imageSelectorField.classList.toggle('hidden', !isCaptcha);
  if (refs.pickButton) {
    refs.pickButton.style.display = needsSelector || isWaitElement || isExtract || isManualLogin ? '' : 'none';
  }
}

export function populateStepForm(refs: StepFormRefs, step: RecordedStep): void {
  refs.typeSelect.value = stepTypeValue(step);
  refs.selectorInput.value = stepSelector(step);
  refs.labelInput.value = step.type === 'wait' ? '' : step.label ?? '';
  refs.delayInput.value = step.type === 'wait' ? String(step.delayMs) : '500';
  refs.imageSelectorInput.value =
    step.type === 'fill' && (step.fillKind === 'captcha' || step.field === 'captcha')
      ? step.imageSelector ?? ''
      : '';
  refs.variableNameInput.value =
    step.type === 'fill' ? step.variableName ?? step.field ?? '' : '';
  refs.literalValueInput.value =
    step.type === 'fill' && step.fillKind === 'literal' ? step.value ?? '' : '';
  refs.scrollTopInput.value =
    step.type === 'scroll' && step.top !== undefined ? String(step.top) : '';
  refs.scrollLeftInput.value =
    step.type === 'scroll' && step.left !== undefined ? String(step.left) : '';
  refs.keyInput.value = step.type === 'key' ? step.key : '';
  refs.modifiersInput.value =
    step.type === 'key' && step.modifiers?.length ? step.modifiers.join('+') : '';
  refs.selectValueInput.value = step.type === 'select' ? step.value ?? '' : '';
  refs.selectTextInput.value = step.type === 'select' ? step.optionText ?? '' : '';
  refs.navigateUrlInput.value = step.type === 'navigate' ? step.url : step.type === 'manualLogin' ? step.url ?? '' : '';
  refs.waitTimeoutInput.value =
    step.type === 'waitElement' || step.type === 'extract'
      ? String(step.timeoutMs ?? 8000)
      : step.type === 'manualLogin'
        ? String(step.timeoutMs ?? 300000)
        : '8000';
  refs.extractVariableInput.value = step.type === 'extract' ? step.variableName : '';
  refs.extractAttributeSelect.value =
    step.type === 'extract' ? step.attribute ?? 'text' : 'text';
  updateStepFormVisibility(refs);
}

export function clearStepForm(refs: StepFormRefs): void {
  refs.typeSelect.value = 'click';
  refs.selectorInput.value = '';
  refs.labelInput.value = '';
  refs.delayInput.value = '500';
  refs.imageSelectorInput.value = '';
  refs.variableNameInput.value = '';
  refs.literalValueInput.value = '';
  refs.scrollTopInput.value = '';
  refs.scrollLeftInput.value = '';
  refs.keyInput.value = '';
  refs.modifiersInput.value = '';
  refs.selectValueInput.value = '';
  refs.selectTextInput.value = '';
  refs.navigateUrlInput.value = '';
  refs.waitTimeoutInput.value = '8000';
  refs.extractVariableInput.value = '';
  refs.extractAttributeSelect.value = 'text';
  updateStepFormVisibility(refs);
}

export function buildStepFromForm(
  refs: StepFormRefs,
  onError: (message: string) => void,
): RecordedStep | null {
  const type = refs.typeSelect.value;
  const selector = refs.selectorInput.value.trim();
  const label = refs.labelInput.value.trim();

  if (type === 'wait') {
    const delayMs = Number(refs.delayInput.value);
    if (!Number.isFinite(delayMs) || delayMs < 100) {
      onError('等待时间至少 100ms');
      return null;
    }
    return { type: 'wait', delayMs };
  }

  if (type === 'wait-element') {
    if (!selector) {
      onError('请填写 CSS 选择器');
      return null;
    }
    const timeoutMs = Number(refs.waitTimeoutInput.value.trim() || '8000');
    return {
      type: 'waitElement',
      selector,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000,
      label: label || undefined,
    };
  }

  if (type === 'navigate') {
    const url = refs.navigateUrlInput.value.trim();
    if (!url) {
      onError('请填写网页地址');
      return null;
    }
    return { type: 'navigate', url, label: label || undefined };
  }

  if (type === 'manual-login') {
    const url = refs.navigateUrlInput.value.trim();
    const successSelector = refs.selectorInput.value.trim();
    const timeoutMs = Number(refs.waitTimeoutInput.value.trim() || '300000');
    return {
      type: 'manualLogin',
      url: url || undefined,
      successSelector: successSelector || undefined,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 300000,
      label: label || undefined,
    };
  }

  if (type === 'extract') {
    if (!selector) {
      onError('请填写 CSS 选择器');
      return null;
    }
    const variableName = refs.extractVariableInput.value.trim() || 'result';
    const attribute = refs.extractAttributeSelect.value as 'text' | 'value' | 'href';
    const timeoutMs = Number(refs.waitTimeoutInput.value.trim() || '8000');
    return {
      type: 'extract',
      selector,
      variableName,
      attribute,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000,
      label: label || undefined,
    };
  }

  if (type === 'scroll') {
    const topRaw = refs.scrollTopInput.value.trim();
    const leftRaw = refs.scrollLeftInput.value.trim();
    return {
      type: 'scroll',
      selector: selector || undefined,
      top: topRaw ? Number(topRaw) : undefined,
      left: leftRaw ? Number(leftRaw) : undefined,
      label: label || undefined,
    };
  }

  if (type === 'key') {
    const key = refs.keyInput.value.trim();
    if (!key) {
      onError('请填写按键名');
      return null;
    }
    const modsRaw = refs.modifiersInput.value.trim();
    const modifiers = modsRaw
      ? (modsRaw.split(/[+,\s]+/).filter(Boolean) as Array<'ctrl' | 'shift' | 'alt' | 'meta'>)
      : undefined;
    return {
      type: 'key',
      key,
      selector: selector || undefined,
      modifiers,
      label: label || undefined,
    };
  }

  const needsSelector = !['wait', 'scroll', 'navigate'].includes(type);
  if (needsSelector && type !== 'key' && !selector) {
    onError('请填写 CSS 选择器');
    return null;
  }

  if (type === 'click') {
    return { type: 'click', selector, label: label || undefined };
  }
  if (type === 'dblclick') {
    return { type: 'dblclick', selector, label: label || undefined };
  }
  if (type === 'hover') {
    return { type: 'hover', selector, label: label || undefined };
  }
  if (type === 'select') {
    const value = refs.selectValueInput.value.trim();
    const optionText = refs.selectTextInput.value.trim();
    if (!value && !optionText) {
      onError('请填写 option 的 value 或显示文字');
      return null;
    }
    return {
      type: 'select',
      selector,
      value: value || undefined,
      optionText: optionText || undefined,
      label: label || undefined,
    };
  }

  const imageSelector = refs.imageSelectorInput.value.trim();

  if (type === 'fill-captcha') {
    return {
      type: 'fill',
      fillKind: 'captcha',
      selector,
      label: label || undefined,
      imageSelector: imageSelector || undefined,
    };
  }

  if (type === 'fill-literal') {
    return {
      type: 'fill',
      fillKind: 'literal',
      selector,
      value: refs.literalValueInput.value,
      label: label || undefined,
    };
  }

  const variableName =
    type === 'fill-password'
      ? 'password'
      : type === 'fill-username'
        ? 'username'
        : refs.variableNameInput.value.trim() || 'value';

  return {
    type: 'fill',
    fillKind: 'variable',
    selector,
    variableName,
    label: label || undefined,
  };
}

export function collectStepFormRefs(root: ParentNode): StepFormRefs {
  const get = <T extends HTMLElement>(id: string): T => {
    const element = root.querySelector(`#${id}`);
    if (!element) throw new Error(`Missing #${id}`);
    return element as T;
  };

  return {
    typeSelect: get('edit-step-type'),
    selectorInput: get('edit-step-selector'),
    labelInput: get('edit-step-label'),
    delayInput: get('edit-step-delay'),
    navigateUrlInput: get('edit-navigate-url'),
    waitTimeoutInput: get('edit-wait-timeout'),
    extractVariableInput: get('edit-extract-variable'),
    extractAttributeSelect: get('edit-extract-attribute'),
    scrollTopInput: get('edit-scroll-top'),
    scrollLeftInput: get('edit-scroll-left'),
    keyInput: get('edit-step-key'),
    modifiersInput: get('edit-step-modifiers'),
    selectValueInput: get('edit-select-value'),
    selectTextInput: get('edit-select-text'),
    variableNameInput: get('edit-step-variable'),
    literalValueInput: get('edit-step-literal'),
    imageSelectorInput: get('edit-step-image-selector'),
    selectorField: get('edit-selector-field'),
    selectorHint: root.querySelector('#edit-selector-optional-hint'),
    delayField: get('edit-delay-field'),
    navigateField: get('edit-navigate-field'),
    waitElementField: get('edit-wait-element-field'),
    extractFields: get('edit-extract-fields'),
    scrollFields: get('edit-scroll-fields'),
    keyFields: get('edit-key-fields'),
    selectFields: get('edit-select-fields'),
    variableNameField: get('edit-variable-name-field'),
    literalValueField: get('edit-literal-value-field'),
    imageSelectorField: get('edit-image-selector-field'),
    pickButton: root.querySelector('#pick-element-btn') as HTMLButtonElement | null,
  };
}
