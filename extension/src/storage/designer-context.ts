import type { RecordedStep } from '../types';

const KEY = 'designerContext';

export type DesignerSource = 'draft' | 'workflow';

export interface DesignerContext {
  source: DesignerSource;
  workflowId?: string;
  name: string;
  entryUrl: string;
  /** 打开画布时的目标网站标签页，供元素拾取使用 */
  targetTabId?: number;
  steps: RecordedStep[];
  openedAt: number;
}

export async function saveDesignerContext(context: Omit<DesignerContext, 'openedAt'>): Promise<void> {
  await chrome.storage.session.set({
    [KEY]: { ...context, openedAt: Date.now() },
  });
}

export async function getDesignerContext(): Promise<DesignerContext | undefined> {
  const result = await chrome.storage.session.get(KEY);
  return result[KEY] as DesignerContext | undefined;
}

export async function clearDesignerContext(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
