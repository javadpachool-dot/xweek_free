import { Router } from 'express';
import type { Db } from '../db/connection.js';
import type { AIClient } from '../ai/client.js';
import { chat, listMessages } from '../ai/chat.js';
import { chatInputSchema } from '../../shared/schemas.js';
import { parseBody } from '../middleware.js';
import { ProviderError } from '../services/errors.js';

export function chatRouter(db: Db, client?: AIClient): Router {
  const router = Router();
  router.get('/chat/messages', (_req, res) => {
    res.json(listMessages(db));
  });
  router.get('/chat/diagnose', async (_req, res) => {
    if (!client) {
      res.status(503).json({ configured: false, error: 'OPENAI_API_KEY is missing' });
      return;
    }
    try {
      const reply = await client.complete([{ role: 'user', content: 'Reply with OK.' }], []);
      res.json({ configured: true, ok: true, reply: reply.content });
    } catch (error) {
      const detail = error as { status?: number; message?: string };
      console.error('AI diagnostic failed:', error);
      res.status(502).json({
        configured: true,
        ok: false,
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
