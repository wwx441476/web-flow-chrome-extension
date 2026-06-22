export type MouseButton = 'left' | 'right' | 'middle';

export type KeyModifier = 'ctrl' | 'shift' | 'alt' | 'meta';

export interface ActionMeta {
  label?: string;
  delayMs?: number;
}

export type FillKind = 'variable' | 'literal' | 'captcha';

/** @deprecated */
export type CredentialField = 'username' | 'password' | 'captcha';

export type FillAction = ActionMeta & {
  type: 'fill';
  selector: string;
  fillKind?: FillKind;
  variableName?: string;
  value?: string;
  /** @deprecated */
  field?: CredentialField;
  imageSelector?: string;
};

export type ClickAction = ActionMeta & {
  type: 'click';
  selector: string;
  button?: MouseButton;
};

export type DblClickAction = ActionMeta & {
  type: 'dblclick';
  selector: string;
};

export type HoverAction = ActionMeta & {
  type: 'hover';
  selector: string;
};

export type ScrollAction = ActionMeta & {
  type: 'scroll';
  /** 省略则滚动窗口 */
  selector?: string;
  top?: number;
  left?: number;
};

export type KeyAction = ActionMeta & {
  type: 'key';
  key: string;
  /** 按键前先聚焦的元素 */
  selector?: string;
  modifiers?: KeyModifier[];
};

export type SelectAction = ActionMeta & {
  type: 'select';
  selector: string;
  value?: string;
  optionText?: string;
};

export type WaitAction = ActionMeta & {
  type: 'wait';
  delayMs: number;
};

export type WaitElementAction = ActionMeta & {
  type: 'waitElement';
  selector: string;
  timeoutMs?: number;
};

export type NavigateAction = ActionMeta & {
  type: 'navigate';
  url: string;
};

export type ExtractAttribute = 'text' | 'value' | 'href';

export type ExtractAction = ActionMeta & {
  type: 'extract';
  selector: string;
  variableName: string;
  attribute?: ExtractAttribute;
  timeoutMs?: number;
};

/** 暂停自动化，浮层展示凭据供用户手工登录，确认后继续后续步骤 */
export type ManualLoginAction = ActionMeta & {
  type: 'manualLogin';
  /** 可选：先跳转到登录页 */
  url?: string;
  /** 可选：登录成功后出现的元素，检测到则自动继续 */
  successSelector?: string;
  timeoutMs?: number;
};

export type ActionStep =
  | ClickAction
  | DblClickAction
  | HoverAction
  | ScrollAction
  | KeyAction
  | SelectAction
  | FillAction
  | WaitAction
  | WaitElementAction
  | NavigateAction
  | ExtractAction
  | ManualLoginAction;

/** 工作流步骤与 Action 原语同型 */
export type RecordedStep = ActionStep;

export type FillStep = FillAction;

export function isFillAction(step: ActionStep): step is FillAction {
  return step.type === 'fill';
}

export function hasSelector(step: ActionStep): step is ActionStep & { selector: string } {
  return 'selector' in step && typeof step.selector === 'string';
}
