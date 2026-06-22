import type { LlmSettings } from './types';

type ChatRole = 'system' | 'user' | 'assistant';

interface TextContent {
  type: 'text';
  text: string;
}

interface ImageContent {
  type: 'image_url';
  image_url: { url: string };
}

type MessageContent = string | Array<TextContent | ImageContent>;

interface ChatMessage {
  role: ChatRole;
  content: MessageContent;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

export async function chatCompletion(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: { model?: string; json?: boolean } = {},
): Promise<string> {
  if (!settings.apiKey) {
    throw new Error('请先在设置中填写大模型 API Key');
  }

  const model = options.model ?? settings.model;
  const url = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
  };

  if (options.json) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`大模型请求失败 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('大模型返回为空');
  }

  return content;
}

export async function solveCaptchaImage(
  settings: LlmSettings,
  imageBase64: string,
): Promise<string> {
  const content: Array<TextContent | ImageContent> = [
    {
      type: 'text',
      text: '这是网页上的图形验证码图片。请只输出验证码字符本身，不要解释。若包含字母请保持原样大小写，仅去掉空格和标点。',
    },
    {
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageBase64}` },
    },
  ];

  const text = await chatCompletion(settings, [{ role: 'user', content }], {
    model: settings.visionModel || settings.model,
  });

  return text.replace(/[\s"'`]/g, '').trim();
}

export async function parseJsonCompletion<T>(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: { model?: string } = {},
): Promise<T> {
  const text = await chatCompletion(settings, messages, { ...options, json: true });
  try {
    return JSON.parse(extractJsonObject(text)) as T;
  } catch {
    throw new Error(`无法解析大模型 JSON 响应: ${text.slice(0, 120)}`);
  }
}
