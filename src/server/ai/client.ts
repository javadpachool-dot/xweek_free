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

const RATE_LIMIT_RETRIES = 2;

function isRateLimit(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: number }).status === 429;
}

function retryAfterMs(error: unknown, attempt: number): number {
  const headers = (error as { headers?: { get?: (name: string) => string | null } }).headers;
  const raw = headers?.get?.('retry-after');
  const seconds = raw ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000 + 250, 30000);
  return Math.min(2000 * 2 ** attempt, 10000);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RATE_LIMIT_RETRIES || !isRateLimit(error)) throw error;
      const delay = retryAfterMs(error, attempt);
      console.warn(
        `AI rate limited; retrying in ${Math.ceil(delay / 1000)}s ` +
        `(${attempt + 1}/${RATE_LIMIT_RETRIES})`,
      );
      await sleep(delay);
    }
  }
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

function normalizeApiKey(apiKey: string): string {
  return apiKey.trim().replace(/^Bearer\s+/i, '');
}

function createGitHubClient(config: { apiKey: string; baseURL: string; model: string }): AIClient {
  const endpoint = `${normalizeBaseUrl(config.baseURL)}/chat/completions`;
  const apiKey = normalizeApiKey(config.apiKey);
  return {
    async complete(messages, tools) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
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
      if (text.trim() === 'OK') {
        throw new Error(
          'GitHub Models rejected the token (200 OK). Check that OPENAI_API_KEY is a valid GitHub PAT with models:read.',
        );
      }
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
  const apiKey = normalizeApiKey(config.apiKey);
  const sdk = new OpenAI({
    apiKey,
    baseURL,
    timeout: 30000,
    maxRetries: 0,
    ...(scheme && scheme.toLowerCase() !== 'bearer'
      ? { defaultHeaders: { Authorization: `${scheme} ${apiKey}` } }
      : {}),
  });
  return {
    async complete(messages, tools) {
      const response = await withRateLimitRetry(() =>
        sdk.chat.completions.create({ model: config.model, messages, tools }),
      );
      const message = response.choices?.[0]?.message;
      if (!message || message.tool_calls?.some((call) => call.type !== 'function')) {
        throw new Error('Invalid model response');
      }
      return { content: message.content, tool_calls: message.tool_calls as FunctionCall[] | undefined };
    },
  };
}
