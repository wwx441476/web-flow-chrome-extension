import type { GlobalSettings } from '../types';
import type { LlmSettings } from '../llm/types';

const SETTINGS_KEY = 'settings';

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: false,
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  visionModel: 'gpt-4o-mini',
  captchaSolver: 'auto',
  autoPlanEnabled: true,
  maxAgentSteps: 20,
};

const DEFAULT_SETTINGS: GlobalSettings = {
  defaultOpenMode: 'new_tab',
  llm: DEFAULT_LLM_SETTINGS,
};

export async function getSettings(): Promise<GlobalSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<GlobalSettings> | undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    llm: {
      ...DEFAULT_LLM_SETTINGS,
      ...stored?.llm,
    },
  };
}

export async function saveSettings(settings: GlobalSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function resolveOpenMode(
  siteOpenMode: GlobalSettings['defaultOpenMode'] | null,
  settings: GlobalSettings,
): GlobalSettings['defaultOpenMode'] {
  return siteOpenMode ?? settings.defaultOpenMode;
}
