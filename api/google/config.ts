import type { IncomingMessage, ServerResponse } from 'http';
import { buildGoogleConfigPayload } from '../../src/server/googleConfig.js';
import { logServerError } from '../../src/server/logger.js';

/**
 * Isolated, zero-dependency Vercel Serverless Function for GET /api/google/config.
 * Never loads Express, googleapis, nodemailer, multer, or any database driver.
 * Never returns client secrets, access tokens, or refresh tokens.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    res.end(JSON.stringify({ success: false, error: 'Method not allowed. Use GET.' }));
    return;
  }

  try {
    const payload = buildGoogleConfigPayload();
    res.statusCode = 200;
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(JSON.stringify(payload));
  } catch (err) {
    logServerError('api/google/config', err, req);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: 'Internal server error.' }));
    }
  }
}
