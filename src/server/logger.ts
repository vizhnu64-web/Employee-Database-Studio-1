import type { IncomingMessage } from 'http';

export interface StructuredServerErrorLog {
  level: 'error';
  service: 'employee-database-studio-api';
  stage: string;
  method?: string;
  path?: string;
  code?: string;
  message: string;
  stack?: string;
  timestamp: string;
}

/**
 * Strips query parameters (which could accidentally carry tokens or IDs)
 * and limits path length before logging.
 */
export function sanitizeRequestPath(rawUrl?: string | null): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '/';
  const withoutQuery = rawUrl.split('?')[0] || '/';
  return withoutQuery.slice(0, 256);
}

/**
 * Redacts common bearer/token patterns from error messages before logging.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/ya29\.[A-Za-z0-9\-._~+/]+/g, '[REDACTED_GOOGLE_TOKEN]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]')
    .replace(/id_token=[^&\s]+/gi, 'id_token=[REDACTED]')
    .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=[REDACTED]');
}

export function logServerError(
  stage: string,
  err: unknown,
  req?: Pick<IncomingMessage, 'method' | 'url'> & { originalUrl?: string }
): StructuredServerErrorLog {
  const errorObj = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown server error');
  const code =
    typeof (err as any)?.code === 'string' || typeof (err as any)?.code === 'number'
      ? String((err as any).code)
      : undefined;

  const entry: StructuredServerErrorLog = {
    level: 'error',
    service: 'employee-database-studio-api',
    stage,
    method: req?.method,
    path: req ? sanitizeRequestPath(req.originalUrl || req.url) : undefined,
    code,
    message: redactSecrets(errorObj.message || 'Unknown error'),
    stack: errorObj.stack ? redactSecrets(errorObj.stack) : undefined,
    timestamp: new Date().toISOString(),
  };

  console.error(JSON.stringify(entry));
  return entry;
}
