import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

export interface FunctionCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ModelReply {
  content: string | null;
  tool_calls?: FunctionCall[];
}

export interface AIClient {
  complete(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ModelReply>;
}

interface GitHubReply {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: unknown;
    };
  }>;
}

function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

function createGitHubClient(config: { apiKey: string; baseURL: string; model: string }): AIClient {
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/chat/completions`;
  return {
    async complete(messages, tools) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`GitHub Models ${response.status}: ${text.slice(0, 800)}`);
      }
      let payload: GitHubReply;
      try {
        payload = JSON.parse(text) as GitHubReply;
      } catch {
        throw new Error(`GitHub Models returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
      }
      const message = payload.choices?.[0]?.message;
      if (!message) {
        throw new Error(`GitHub Models response has no choices: ${text.slice(0, 800)}`);
      }
      const content = typeof message.content === 'string' ? message.content : null;
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as FunctionCall[] : undefined;
      if (toolCalls?.some((call) => call.type !== 'function')) {
        throw new Error('Invalid model response');
      }
      return { content, tool_calls: toolCalls };
    },
  };
}

export function createOpenAIClient(config: {
  apiKey: string;
  baseURL: string;
  model: string;
  authScheme?: string;
}): AIClient {
  const baseURL = normalizeBaseUrl(config.baseURL);
  if (new URL(baseURL).host === 'models.github.ai') {
    return createGitHubClient({ ...config, baseURL });
  }

  const scheme = config.authScheme?.trim();
  const sdk = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    timeout: 30000,
    maxRetries: 0,
    ...(scheme && scheme.toLowerCase() !== 'bearer'
      ? { defaultHeaders: { Authorization: `${scheme} ${config.apiKey}` } }
      : {}),
  });
  return {
    async complete(messages, tools) {
      const response = await sdk.chat.completions.create({ model: config.model, messages, tools });
      const message = response.choices?.[0]?.message;
      if (!message || message.tool_calls?.some((call) => call.type !== 'function')) {
        throw new Error('Invalid model response');
      }
      return { content: message.content, tool_calls: message.tool_calls as FunctionCall[] | undefined };
    },
  };
}
