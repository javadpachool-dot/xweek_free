import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db/connection.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createOpenAIClient } from './ai/client.js';

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
let db;
try {
  db = openDb(config.DATABASE_PATH, {
    syncUrl: config.TURSO_DATABASE_URL,
    authToken: config.TURSO_AUTH_TOKEN,
  });
} catch (error) {
  console.error('xWeek database startup failed:', error);
  process.exit(1);
}

const client = config.OPENAI_API_KEY
  ? createOpenAIClient({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASE_URL,
      model: config.OPENAI_MODEL,
      authScheme: process.env.OPENAI_AUTH_SCHEME,
    })
  : undefined;

console.log(
  client
    ? `AI configured: ${config.OPENAI_MODEL} via ${config.OPENAI_BASE_URL}`
    : 'AI not configured: OPENAI_API_KEY is missing',
);

createApp(db, client).listen(config.PORT, config.HOST, () => {
  console.log(`xWeek listening on http://${config.HOST}:${config.PORT}`);
});
