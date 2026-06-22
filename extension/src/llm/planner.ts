import { parseJsonCompletion } from './client';
import type { AgentAction, AgentStepRecord, LlmSettings, PageSnapshot } from './types';

const PLAN_SYSTEM_PROMPT = `你是浏览器网页自动化助手。根据页面可交互元素列表，规划下一步操作以完成用户目标。

可用 Action 原语：
- click / dblclick / hover：需 ref
- scroll：ref 可选（省略则滚动页面），可带 top/left
- key：key 必填，ref 可选（先聚焦），可带 modifiers: ctrl/shift/alt/meta
- select：ref 必填，value 或 optionText 二选一
- fill_variable：ref + variableName
- fill_text：ref + text
- solve_captcha：ref 指向验证码输入框
- wait：delayMs
- done / failed：任务结束

规则：
1. 每次只返回一个 JSON 对象。
2. 使用元素 ref（如 el-3），不要编造 selector。
3. 短信/滑块等人机验证无法处理时用 failed。
4. 等待加载用 wait，delayMs 建议 500-2000。

响应格式：
{
  "action": "click" | "dblclick" | "hover" | "scroll" | "key" | "select" | "fill_variable" | "fill_text" | "solve_captcha" | "wait" | "done" | "failed",
  "ref": "el-N",
  "variableName": "变量名",
  "text": "固定文本",
  "key": "Enter",
  "value": "option-value",
  "optionText": "选项文字",
  "top": 0,
  "left": 0,
  "modifiers": ["ctrl"],
  "delayMs": 1000,
  "reason": "简短说明"
}`;

function formatElements(snapshot: PageSnapshot): string {
  return snapshot.elements
    .map((el) => {
      const parts = [`${el.ref}: <${el.tag}${el.type ? ` type=${el.type}` : ''}>`];
      if (el.role) parts.push(`role=${el.role}`);
      parts.push(`label="${el.label}"`);
      return parts.join(' ');
    })
    .join('\n');
}

function formatHistory(history: AgentStepRecord[]): string {
  if (history.length === 0) return '尚无已执行步骤。';
  return history
    .map((step, index) => {
      const ref = step.ref ? ` @${step.ref}` : '';
      const status = step.status === 'success' ? 'OK' : 'FAIL';
      return `${index + 1}. ${step.action}${ref} [${status}] ${step.reason ?? step.message ?? ''}`;
    })
    .join('\n');
}

function formatVariables(variables: Record<string, string>): string {
  const entries = Object.entries(variables).filter(([, value]) => value !== '');
  if (entries.length === 0) return '（无预设变量，可用 fill_text）';
  return entries
    .map(([key, value]) => {
      const masked =
        /pass|密码|secret|token/i.test(key) && value
          ? '*'.repeat(Math.min(value.length, 8))
          : value.slice(0, 40);
      return `${key}=${masked}`;
    })
    .join(', ');
}

export async function planNextAction(
  settings: LlmSettings,
  snapshot: PageSnapshot,
  variables: Record<string, string>,
  goal: string,
  history: AgentStepRecord[],
): Promise<AgentAction> {
  const userPrompt = [
    `目标: ${goal}`,
    `页面: ${snapshot.title}`,
    `URL: ${snapshot.url}`,
    `可用变量: ${formatVariables(variables)}`,
    '',
    '可交互元素:',
    formatElements(snapshot),
    '',
    '已执行步骤:',
    formatHistory(history),
    '',
    '请返回下一步操作的 JSON。',
  ].join('\n');

  const action = await parseJsonCompletion<AgentAction>(settings, [
    { role: 'system', content: PLAN_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]);

  if (!action.action) {
    throw new Error('大模型未返回有效 action');
  }

  if (action.action === 'fill_username') {
    return { ...action, action: 'fill_variable', variableName: action.variableName ?? 'username' };
  }

  if (action.action === 'fill_password') {
    return { ...action, action: 'fill_variable', variableName: action.variableName ?? 'password' };
  }

  return action;
}
