import type { IncomingMessage, ServerResponse } from 'http';
import app from '../src/server/app.js';
import { createVercelApiHandler } from '../src/server/vercelRouting.js';
import { logServerError } from '../src/server/logger.js';

const expressHandler = createVercelApiHandler(app);

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  try {
    expressHandler(req, res);
  } catch (err) {
    logServerError('api/index:invocation', err, req);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ success: false, error: 'Internal server error.' }));
    }
  }
}
