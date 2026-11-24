import type { IncomingMessage, ServerResponse } from 'http';
import type { Express } from 'express';
import { logServerError } from './logger.js';

export interface VercelLikeRequest extends IncomingMessage {
  url?: string;
  headers: IncomingMessage['headers'];
}

function getHeaderString(
  headers: IncomingMessage['headers'] | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) {
    return raw[0].trim();
  }
  return null;
}

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw, 'http://localhost');
  } catch {
    return null;
  }
}

/**
 * Normalizes incoming URLs for the Vercel Serverless Function at /api/index.ts
 * so Express routes mounted under /api/* always receive their canonical path
 * without double /api/api prefixes or lost subpaths.
 */
export function normalizeVercelApiRequestUrl(req: Pick<VercelLikeRequest, 'url' | 'headers'>): string {
  const rawUrl = typeof req.url === 'string' && req.url.trim() ? req.url.trim() : '/api';
  const parsed = safeParseUrl(rawUrl);
  if (!parsed) {
    return '/api';
  }
  let pathname = parsed.pathname || '/api';

  // Case 1: Proxy or rewrite forwarded the destination path (/api/index or /index)
  // rather than the original incoming URL. Recover original path from proxy headers or __path.
  if (pathname === '/api/index' || pathname === '/api/index.ts' || pathname === '/index') {
    const headerOriginal =
      getHeaderString(req.headers, 'x-vercel-original-url') ||
      getHeaderString(req.headers, 'x-original-url') ||
      getHeaderString(req.headers, 'x-forwarded-uri') ||
      getHeaderString(req.headers, 'x-invoke-path');

    const querySubPath = parsed.searchParams.get('__path');
    if (querySubPath !== null) {
      parsed.searchParams.delete('__path');
    }

    const originalUrl = headerOriginal ? safeParseUrl(headerOriginal) : null;
    if (originalUrl) {
      const originalPath = originalUrl.pathname || '/api';
      if (originalPath !== '/api/index' && originalPath !== '/api/index.ts') {
        pathname = originalPath;
        originalUrl.searchParams.forEach((value, key) => {
          if (key !== '__path' && !parsed.searchParams.has(key)) {
            parsed.searchParams.append(key, value);
          }
        });
      }
    } else if (querySubPath !== null) {
      const cleanedSub = querySubPath.replace(/^\/+/, '');
      pathname = cleanedSub
        ? cleanedSub.startsWith('api/') || cleanedSub === 'api'
          ? `/${cleanedSub}`
          : `/api/${cleanedSub}`
        : '/api';
    } else {
      pathname = '/api';
    }
  } else if (parsed.searchParams.has('__path')) {
    parsed.searchParams.delete('__path');
  }

  // Case 2: Runtime stripped the /api mount prefix (e.g. "/google/config")
  if (pathname !== '/api' && !pathname.startsWith('/api/')) {
    pathname = `/api${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  }

  // Case 3: Guard against accidental duplicate /api/api/ prefix
  if (pathname.startsWith('/api/api/')) {
    pathname = pathname.slice(4);
  }

  const queryString = parsed.searchParams.toString();
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function createVercelApiHandler(expressApp: Express) {
  return function vercelApiHandler(req: VercelLikeRequest, res: ServerResponse) {
    try {
      req.url = normalizeVercelApiRequestUrl(req);
      return (expressApp as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
    } catch (err) {
      logServerError('vercelRouting:handler', err, req);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ success: false, error: 'Internal server error.' }));
      }
    }
  };
}
