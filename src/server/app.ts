import express from 'express';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Db } from './db/connection.js';
import { errorMiddleware } from './middleware.js';
import { tasksRouter } from './routes/tasks.js';
import { settingsRouter } from './routes/settings.js';
import { freeTimeRouter } from './routes/free-time.js';
import { chatRouter } from './routes/chat.js';
import type { AIClient } from './ai/client.js';

export function createApp(db: Db, client?: AIClient): express.Express {
  const app = express();
  app.set('json replacer', (key: string, value: unknown) => key === '_metadata' ? undefined : value);
  app.use(express.json());

  // Unauthenticated liveness endpoint for Render health checks and uptime monitors.
  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  const basicUser = process.env.APP_USER;
  const basicPass = process.env.APP_PASS;
  if (basicUser && basicPass) {
    app.use((req, res, next) => {
      const encoded = req.headers.authorization?.replace(/^Basic\s+/i, '');
      if (encoded) {
        const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
        const ok = (a = '', b = '') => {
          const left = Buffer.from(a);
          const right = Buffer.from(b);
          return left.length === right.length && timingSafeEqual(left, right);
        };
        if (ok(user, basicUser) && ok(pass, basicPass)) return next();
      }
      res.set('WWW-Authenticate', 'Basic realm="xWeek"').status(401).send('Authentication required');
    });
  }

  app.get('/api/hello', (_req, res) => {
    res.json({ message: 'hello from xWeek server' });
  });

  app.use('/api', tasksRouter(db));
  app.use('/api', settingsRouter(db));
  app.use('/api', freeTimeRouter(db));
  app.use('/api', chatRouter(db, client));

  const clientDir = join(process.cwd(), 'out/client');
  app.use(express.static(clientDir));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(join(clientDir, 'index.html'));
  });

  app.use(errorMiddleware);
  return app;
}
