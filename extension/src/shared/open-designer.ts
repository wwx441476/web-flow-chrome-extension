import { saveDesignerContext } from '../storage/designer-context';
import type { RecordedStep, WorkflowRecord } from '../types';

export async function openDesignerPage(input: {
  source: 'draft' | 'workflow';
  workflowId?: string;
  name: string;
  entryUrl: string;
  targetTabId?: number;
  steps: RecordedStep[];
}): Promise<void> {
  await saveDesignerContext({
    source: input.source,
    workflowId: input.workflowId,
    name: input.name,
    entryUrl: input.entryUrl,
    targetTabId: input.targetTabId,
    steps: input.steps,
  });

  const url = chrome.runtime.getURL('src/designer/index.html');
  await chrome.tabs.create({ url, active: true });
}

export function designerPayloadFromWorkflow(workflow: WorkflowRecord): {
  source: 'workflow';
  workflowId: string;
  name: string;
  entryUrl: string;
  steps: RecordedStep[];
} {
  return {
    source: 'workflow',
    workflowId: workflow.id,
    name: workflow.name,
    entryUrl: workflow.entryUrl,
    steps: workflow.flow ?? [],
  };
}
