import type { FormSelectors, RecordedStep, VariableSet, WorkflowRecord } from '../types';
import { createVariableSet, normalizeWorkflow } from './accounts';
import { accountValuesToVariableSet } from './variables';

const WORKFLOWS_KEY = 'workflows';
const LEGACY_SITES_KEY = 'sites';

export function generateUrlPattern(entryUrl: string): string {
  try {
    const url = new URL(entryUrl);
    return `*://${url.hostname}/*`;
  } catch {
    return entryUrl;
  }
}

async function readWorkflows(): Promise<WorkflowRecord[]> {
  const result = await chrome.storage.local.get([WORKFLOWS_KEY, LEGACY_SITES_KEY]);
  const workflows =
    (result[WORKFLOWS_KEY] as WorkflowRecord[] | undefined) ??
    (result[LEGACY_SITES_KEY] as WorkflowRecord[] | undefined) ??
    [];

  if (!result[WORKFLOWS_KEY] && result[LEGACY_SITES_KEY]) {
    await chrome.storage.local.set({ [WORKFLOWS_KEY]: workflows });
  }

  return workflows.map(normalizeWorkflow);
}

async function writeWorkflows(workflows: WorkflowRecord[]): Promise<void> {
  await chrome.storage.local.set({ [WORKFLOWS_KEY]: workflows.map(normalizeWorkflow) });
}

export async function listWorkflows(): Promise<WorkflowRecord[]> {
  const workflows = await readWorkflows();
  return workflows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** @deprecated */
export const listSites = listWorkflows;

export async function getWorkflow(id: string): Promise<WorkflowRecord | undefined> {
  const workflows = await readWorkflows();
  return workflows.find((workflow) => workflow.id === id);
}

/** @deprecated */
export const getSite = getWorkflow;

export async function saveWorkflow(workflow: WorkflowRecord): Promise<WorkflowRecord> {
  const workflows = await readWorkflows();
  const normalized = normalizeWorkflow(workflow);
  workflows.push(normalized);
  await writeWorkflows(workflows);
  return normalized;
}

/** @deprecated */
export const saveSite = saveWorkflow;

export async function updateWorkflow(workflow: WorkflowRecord): Promise<WorkflowRecord> {
  const workflows = await readWorkflows();
  const index = workflows.findIndex((item) => item.id === workflow.id);
  if (index === -1) {
    throw new Error(`Workflow not found: ${workflow.id}`);
  }
  const normalized = normalizeWorkflow({ ...workflow, updatedAt: Date.now() });
  workflows[index] = normalized;
  await writeWorkflows(workflows);
  return normalized;
}

/** @deprecated */
export const updateSite = updateWorkflow;

export async function deleteWorkflow(id: string): Promise<void> {
  const workflows = await readWorkflows();
  await writeWorkflows(workflows.filter((workflow) => workflow.id !== id));
}

/** @deprecated */
export const deleteSite = deleteWorkflow;

export function createWorkflowRecord(input: {
  name: string;
  entryUrl: string;
  flow: RecordedStep[];
  variableSets: VariableSet[];
  defaultVariableSetId?: string;
  openMode?: WorkflowRecord['openMode'];
  selectors?: FormSelectors;
}): WorkflowRecord {
  const now = Date.now();
  const variableSets = input.variableSets.length > 0 ? input.variableSets : [];
  return normalizeWorkflow({
    id: crypto.randomUUID(),
    name: input.name,
    entryUrl: input.entryUrl,
    urlPattern: generateUrlPattern(input.entryUrl),
    flow: input.flow,
    selectors: input.selectors,
    variableSets,
    defaultVariableSetId: input.defaultVariableSetId ?? variableSets[0]?.id,
    openMode: input.openMode ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/** @deprecated */
export function createSiteRecord(input: {
  name: string;
  entryUrl: string;
  flow: RecordedStep[];
  accounts: Array<{ id: string; label: string; username: string; password: string }>;
  defaultAccountId?: string;
  openMode?: WorkflowRecord['openMode'];
  selectors?: FormSelectors;
}): WorkflowRecord {
  return createWorkflowRecord({
    name: input.name,
    entryUrl: input.entryUrl,
    flow: input.flow,
    selectors: input.selectors,
    openMode: input.openMode,
    defaultVariableSetId: input.defaultAccountId,
    variableSets: input.accounts.map((account) =>
      accountValuesToVariableSet({
        id: account.id,
        label: account.label,
        username: account.username,
        password: account.password,
      }),
    ),
  });
}

export { createAccount, createVariableSet } from './accounts';
