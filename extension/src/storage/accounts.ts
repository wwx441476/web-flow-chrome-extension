import type { AccountCredential, Credentials, VariableSet, WorkflowRecord } from '../types';
import { accountValuesToVariableSet } from './variables';

export function createAccount(input: {
  label?: string;
  username: string;
  password: string;
}): AccountCredential {
  return {
    id: crypto.randomUUID(),
    label: input.label?.trim() || input.username.trim(),
    username: input.username,
    password: input.password,
  };
}

export function createVariableSet(input: {
  label?: string;
  values: Record<string, string>;
}): VariableSet {
  const label = input.label?.trim() || '默认变量集';
  return {
    id: crypto.randomUUID(),
    label,
    values: { ...input.values },
  };
}

type LegacyWorkflowRecord = WorkflowRecord & {
  credentials?: Credentials;
  accounts?: AccountCredential[];
  defaultAccountId?: string;
};

export function normalizeWorkflow(workflow: LegacyWorkflowRecord): WorkflowRecord {
  if (workflow.variableSets?.length > 0) {
    const variableSets = workflow.variableSets;
    const defaultVariableSetId =
      workflow.defaultVariableSetId &&
      variableSets.some((item) => item.id === workflow.defaultVariableSetId)
        ? workflow.defaultVariableSetId
        : variableSets[0].id;
    const { credentials: _c, accounts: _a, ...rest } = workflow;
    return { ...rest, variableSets, defaultVariableSetId };
  }

  if (workflow.accounts && workflow.accounts.length > 0) {
    const variableSets = workflow.accounts.map((account) =>
      accountValuesToVariableSet({
        id: account.id,
        label: account.label,
        username: account.username,
        password: account.password,
      }),
    );
    const defaultVariableSetId =
      workflow.defaultAccountId &&
      variableSets.some((item) => item.id === workflow.defaultAccountId)
        ? workflow.defaultAccountId
        : variableSets[0]?.id;
    const { credentials: _c, accounts: _a, ...rest } = workflow;
    return { ...rest, variableSets, defaultVariableSetId };
  }

  if (workflow.credentials?.username) {
    const account = createAccount({
      label: workflow.credentials.username,
      username: workflow.credentials.username,
      password: workflow.credentials.password,
    });
    const variableSets = [
      accountValuesToVariableSet({
        id: account.id,
        label: account.label,
        username: account.username,
        password: account.password,
      }),
    ];
    const { credentials: _c, accounts: _a, ...rest } = workflow;
    return {
      ...rest,
      variableSets,
      defaultVariableSetId: variableSets[0].id,
    };
  }

  const { credentials: _c, accounts: _a, ...rest } = workflow;
  return { ...rest, variableSets: workflow.variableSets ?? [] };
}

/** @deprecated */
export const normalizeSite = normalizeWorkflow;

export function resolveWorkflowVariables(
  workflow: WorkflowRecord,
  variableSetId?: string,
): { variableSet: VariableSet; variables: Record<string, string> } {
  const normalized = normalizeWorkflow(workflow);
  if (normalized.variableSets.length === 0) {
    throw new Error('该工作流未配置变量集');
  }

  const variableSet =
    (variableSetId
      ? normalized.variableSets.find((item) => item.id === variableSetId)
      : undefined) ??
    normalized.variableSets.find((item) => item.id === normalized.defaultVariableSetId) ??
    normalized.variableSets[0];

  if (!variableSet) {
    throw new Error('变量集不存在');
  }

  return {
    variableSet,
    variables: { ...variableSet.values },
  };
}

/** @deprecated */
export function resolveSiteCredentials(
  site: WorkflowRecord,
  accountId?: string,
): { account: AccountCredential; credentials: Credentials } {
  const { variableSet, variables } = resolveWorkflowVariables(site, accountId);
  return {
    account: {
      id: variableSet.id,
      label: variableSet.label,
      username: variables.username ?? '',
      password: variables.password ?? '',
    },
    credentials: {
      username: variables.username ?? '',
      password: variables.password ?? '',
    },
  };
}
