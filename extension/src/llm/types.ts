export type CaptchaSolver = 'tesseract' | 'llm' | 'auto';

export interface LlmSettings {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
  captchaSolver: CaptchaSolver;
  autoPlanEnabled: boolean;
  maxAgentSteps: number;
}

export interface SnapshotElement {
  ref: string;
  tag: string;
  type?: string;
  label: string;
  selector: string;
  role?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

export type AgentActionType =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'scroll'
  | 'key'
  | 'select'
  | 'fill_variable'
  | 'fill_text'
  | 'solve_captcha'
  | 'wait'
  | 'done'
  | 'failed'
  /** @deprecated */ | 'fill_username'
  /** @deprecated */ | 'fill_password';

export interface AgentAction {
  action: AgentActionType;
  ref?: string;
  variableName?: string;
  text?: string;
  key?: string;
  value?: string;
  optionText?: string;
  button?: 'left' | 'right' | 'middle';
  top?: number;
  left?: number;
  modifiers?: Array<'ctrl' | 'shift' | 'alt' | 'meta'>;
  delayMs?: number;
  reason?: string;
}

export interface AgentStepRecord {
  action: AgentActionType;
  ref?: string;
  variableName?: string;
  reason?: string;
  status: 'success' | 'failed';
  message?: string;
}
