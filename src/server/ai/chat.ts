import { ZodError } from 'zod';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { stageDb, tx, warmDb, type Db } from '../db/connection.js';
import { ConflictError, NotFoundError, ProviderError, ValidationError, zodToMessage } from '../services/errors.js';
import { getSettings } from '../services/settings.js';
import { systemPrompt } from './prompts.js';
import { runTool, toolDefinitions } from './tools.js';
import type { AIClient } from './client.js';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ChatChange {
  task_id: number;
  action: 'create' | 'update' | 'delete';
  before: unknown;
  after: unknown;
}

export interface ChatResult {
  reply: string;
  changes: ChatChange[];
}

export function listMessages(db: Db): ChatMessage[] {
  return db.prepare('SELECT id, role, content, created_at FROM chat_messages ORDER BY id')
    .all() as ChatMessage[];
}

function scheduleRevision(db: Db): number {
  const row = db.prepare('SELECT value FROM schedule_revision WHERE id = 1').get() as
    | { value: number }
    | undefined;
  return row?.value ?? 0;
}

function toolError(error: unknown): string {
  if (error instanceof ZodError) return zodToMessage(error);
  if (error instanceof ValidationError || error instanceof ConflictError || error instanceof NotFoundError) {
    return error.message;
  }
  if (error instanceof SyntaxError) return 'Invalid JSON arguments';
  if (error instanceof Error && error.message.startsWith('Unknown tool:')) return error.message;
  throw error;
}

function changesFor(db: Db, messageId: number): ChatChange[] {
  const rows = db.prepare(
    'SELECT task_id, action, before_json, after_json FROM task_changes WHERE message_id = ? ORDER BY id',
  ).all(messageId) as Array<{ task_id: number; action: ChatChange['action']; before_json: string | null; after_json: string | null }>;
  return rows.map((row) => ({
    task_id: row.task_id,
    action: row.action,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
  }));
}

const HISTORY_MESSAGES = 8;
const HISTORY_CHARS = 1500;

export async function chat(db: Db, client: AIClient, input: string): Promise<ChatResult> {
  warmDb(db);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(getSettings(db)) },
    ...listMessages(db).slice(-HISTORY_MESSAGES).map(({ role, content }) => ({
      role,
      content: content.length > HISTORY_CHARS ? `${content.slice(0, HISTORY_CHARS)}…` : content,
    })),
    { role: 'user', content: input },
  ];
  // A trigger-maintained counter is stable across Turso reconnects, unlike
  // total_changes(), and only moves when the schedule itself changes.
  const revision = scheduleRevision(db);
  const staged = stageDb(db);
  const stagedMessageId = Number(staged.db.prepare(
    "INSERT INTO chat_messages (role, content) VALUES ('user', ?)",
  ).run(input).lastInsertRowid);
  const executed: Array<{ name: string; args: unknown }> = [];

  try {
    for (let turn = 0; turn < 6; turn++) {
      let reply;
      try {
        reply = await client.complete(messages, toolDefinitions);
      } catch (error) {
        console.error('AI provider request failed:', error);
        const status = (error as { status?: number }).status;
        throw new ProviderError(
          status === 429
            ? 'The free AI rate limit is busy. Wait about a minute and try again.'
            : undefined,
        );
      }
      if (!reply.tool_calls?.length) {
        if (!reply.content?.trim()) {
          console.error('AI returned an empty reply:', reply);
          throw new ProviderError();
        }
        const text = reply.content.trim();
        warmDb(db);
        return tx(db, () => {
          if (scheduleRevision(db) !== revision) {
            throw new ConflictError('The schedule changed while the assistant was replying. Please try again.', []);
          }
          const messageId = Number(db.prepare(
            "INSERT INTO chat_messages (role, content) VALUES ('user', ?)",
          ).run(input).lastInsertRowid);
          for (const { name, args } of executed) runTool(db, name, args, messageId);
          db.prepare("INSERT INTO chat_messages (role, content) VALUES ('assistant', ?)").run(text);
          return { reply: text, changes: changesFor(db, messageId) };
        });
      }

      messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
      for (const call of reply.tool_calls) {
        let content: string;
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          const result = runTool(staged.db, call.function.name, args, stagedMessageId);
          executed.push({ name: call.function.name, args });
          content = JSON.stringify(result);
        } catch (error) {
          content = JSON.stringify({ error: toolError(error) });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    console.error('AI did not finish within 6 tool turns');
    throw new ProviderError();
  } finally {
    staged.close();
  }
}
