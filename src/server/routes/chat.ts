import { Router } from 'express';
import type { Db } from '../db/connection.js';
import type { AIClient } from '../ai/client.js';
import { chat, listMessages } from '../ai/chat.js';
import { toolDefinitions } from '../ai/tools.js';
import { chatInputSchema } from '../../shared/schemas.js';
import { parseBody } from '../middleware.js';
import { ProviderError } from '../services/errors.js';

async function githubTokenInfo(): Promise<Record<string, unknown>> {
  if (!(process.env.OPENAI_BASE_URL ?? '').includes('models.github.ai')) {
    return { skipped: 'not GitHub Models' };
  }
  const token = process.env.OPENAI_API_KEY?.trim().replace(/^Bearer\s+/i, '');
  if (!token) return { status: 0, error: 'OPENAI_API_KEY is empty' };
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body = (await response.json().catch(() => ({}))) as { login?: string; message?: string };
    return {
      status: response.status,
      login: body.login,
      message: body.message,
      scopes: response.headers.get('x-oauth-scopes'),
      permissions: response.headers.get('x-accepted-github-permissions'),
    };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export function chatRouter(db: Db, client?: AIClient): Router {
  const router = Router();
  router.get('/chat/messages', (_req, res) => {
    res.json(listMessages(db));
  });
  router.get('/chat/diagnose', async (req, res) => {
    const github = await githubTokenInfo();
    if (!client) {
      res.status(503).json({
        configured: false,
        model: process.env.OPENAI_MODEL,
        baseURL: process.env.OPENAI_BASE_URL,
        github,
        error: 'OPENAI_API_KEY is missing',
      });
      return;
    }
    const testTools = req.query.tools === '1';
    try {
      const reply = await client.complete(
        [{
          role: 'user',
          content: testTools
            ? 'Call the get_tasks tool for 2026-10-01 to 2026-10-31. Do not answer in text.'
            : 'Reply with OK.',
        }],
        testTools ? toolDefinitions : [],
      );
      res.json({
        configured: true,
        ok: true,
        model: process.env.OPENAI_MODEL,
        baseURL: process.env.OPENAI_BASE_URL,
        github,
        ...(testTools ? {
          tools: {
            requested: true,
            called: Boolean(reply.tool_calls?.length),
            names: reply.tool_calls?.map((call) => call.function.name) ?? [],
          },
        } : {}),
        reply: reply.content,
      });
    } catch (error) {
      const detail = error as { status?: number; message?: string };
      console.error('AI diagnostic failed:', error);
      res.status(502).json({
        configured: true,
        ok: false,
        model: process.env.OPENAI_MODEL,
        baseURL: process.env.OPENAI_BASE_URL,
        github,
        status: detail.status,
        error: detail.message ?? String(error),
      });
    }
  });

  router.post('/chat', async (req, res) => {
    const { message } = parseBody(chatInputSchema, req.body);
    if (!client) {
      console.error('AI is not configured: OPENAI_API_KEY is missing');
      throw new ProviderError();
    }
    res.json(await chat(db, client, message));
  });
  return router;
}
