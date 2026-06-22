import type { LlmSettings } from './llm/types';
import type { RecordedStep } from './actions/types';

export type {
  ActionStep,
  ClickAction,
  DblClickAction,
  ExtractAction,
  ExtractAttribute,
  FillAction,
  FillKind,
  FillStep,
  HoverAction,
  KeyAction,
  KeyModifier,
  ManualLoginAction,
  MouseButton,
  NavigateAction,
  RecordedStep,
  ScrollAction,
  SelectAction,
  WaitAction,
  WaitElementAction,
} from './actions/types';
export { hasSelector, isFillAction } from './actions/types';

export type OpenMode = 'new_tab' | 'current_tab';

export interface GlobalSettings {
  defaultOpenMode: OpenMode;
  llm: LlmSettings;
}

/** @deprecated 登录表单快捷识别，通用场景请使用录制/AI 规划 */
export interface FormSelectors {
  username: string;
  password: string;
  submit: string;
}

/** 回放时注入的变量表，常见键如 username / password，也可自定义任意键 */
export type VariableMap = Record<string, string>;

/** @deprecated 使用 VariableMap；保留以兼容旧代码 */
export interface Credentials {
  username: string;
  password: string;
}

export interface VariableSet {
  id: string;
  label: string;
  values: VariableMap;
}

/** @deprecated 旧版账号模型，读取时自动迁移为 VariableSet */
export interface AccountCredential {
  id: string;
  label: string;
  username: string;
  password: string;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  entryUrl: string;
  urlPattern: string;
  flow: RecordedStep[];
  /** @deprecated 有 flow 时优先用 flow */
  selectors?: FormSelectors;
  variableSets: VariableSet[];
  defaultVariableSetId?: string;
  /** @deprecated 旧版多账号，读取时自动迁移到 variableSets */
  accounts?: AccountCredential[];
  credentials?: Credentials;
  openMode: OpenMode | null;
  createdAt: number;
  updatedAt: number;
}

/** @deprecated 使用 WorkflowRecord */
export type SiteRecord = WorkflowRecord;

export type StepStatus = 'success' | 'failed' | 'skipped';

export type ReplayProgressStatus = 'running' | 'success' | 'failed';

export interface ReplayProgressMessage {
  type: 'REPLAY_PROGRESS';
  index: number;
  status: ReplayProgressStatus;
  total: number;
  message?: string;
}

export interface StepResult {
  name: string;
  status: StepStatus;
  message?: string;
}

export interface FillResult {
  success: boolean;
  steps: StepResult[];
  selectors?: FormSelectors;
  flow?: RecordedStep[];
  error?: string;
  /** 单步调试模式：面板仍在运行，尚未完成全部步骤 */
  replayPending?: boolean;
}

export type ContentAction =
  | 'DETECT_FORM'
  | 'FILL_AND_SUBMIT'
  | 'FILL_ONLY'
  | 'TEST_RUN'
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'REPLAY_FLOW'
  | 'SHOW_REPLAY_PANEL'
  | 'AI_AUTO_RUN'
  | 'START_ELEMENT_PICKER'
  | 'STOP_ELEMENT_PICKER'
  /** @deprecated */ | 'AI_AUTO_LOGIN';

export interface ContentMessage {
  action: ContentAction;
  selectors?: FormSelectors;
  credentials?: Credentials;
  variables?: VariableMap;
  goal?: string;
  flow?: RecordedStep[];
}

export type BackgroundAction =
  | 'TEST_RUN'
  | 'AI_AUTO_RUN'
  | 'RUN_WORKFLOW'
  | 'GET_WORKFLOWS'
  | 'GET_WORKFLOW'
  | 'SAVE_WORKFLOW'
  | 'UPDATE_WORKFLOW'
  | 'DELETE_WORKFLOW'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'GET_ACTIVE_TAB'
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'STOP_RECORDING_FROM_PAGE'
  | 'REPLAY_RECORDING'
  | 'MANUAL_LOGIN_REPLAY'
  | 'RUN_WORKFLOW_MANUAL'
  | 'GET_RECORDING_DRAFT'
  | 'CLEAR_RECORDING_DRAFT'
  | 'CHECK_RECORDING'
  | 'START_ELEMENT_PICKER'
  | 'STOP_ELEMENT_PICKER'
  | 'GET_ELEMENT_PICKER_RESULT'
  | 'SAVE_DESIGNER_FLOW'
  | 'UPDATE_RECORDING_DRAFT_FLOW'
  | 'SAVE_REPLAY_SESSION'
  | 'CHECK_REPLAY_SESSION'
  | 'CLEAR_REPLAY_SESSION'
  /** @deprecated */ | 'AI_AUTO_LOGIN'
  /** @deprecated */ | 'ONE_CLICK_LOGIN'
  /** @deprecated */ | 'GET_SITES'
  /** @deprecated */ | 'GET_SITE'
  /** @deprecated */ | 'SAVE_SITE'
  /** @deprecated */ | 'UPDATE_SITE'
  /** @deprecated */ | 'DELETE_SITE';

export interface BackgroundMessage {
  action: BackgroundAction;
  credentials?: Credentials;
  variables?: VariableMap;
  workflow?: WorkflowRecord;
  /** @deprecated */ site?: WorkflowRecord;
  workflowId?: string;
  /** @deprecated */ siteId?: string;
  variableSetId?: string;
  /** @deprecated */ accountId?: string;
  settings?: GlobalSettings;
  flow?: RecordedStep[];
  entryUrl?: string;
  title?: string;
  workflowName?: string;
  /** @deprecated */ siteName?: string;
  goal?: string;
  replayPendingSave?: boolean;
  /** 更新草稿步骤时是否清除试跑成功状态（编辑步骤后需重新试跑） */
  invalidateReplay?: boolean;
  replaySession?: import('./storage/replay-session-storage').ReplaySessionSnapshot;
  source?: 'draft' | 'workflow';
  designerSource?: 'draft' | 'workflow';
  /** 元素拾取等操作的目标标签页（流程画布打开时非当前页） */
  tabId?: number;
}

export interface ActiveTabInfo {
  id?: number;
  url?: string;
  title?: string;
}

export interface RecordingState {
  recording: boolean;
  steps: RecordedStep[];
}

export interface RecordedStepPayload {
  tabId: number;
  frameId: number;
  step: RecordedStep;
}
