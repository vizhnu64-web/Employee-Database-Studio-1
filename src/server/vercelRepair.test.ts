import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { app } from '../../server.js';
import vercelHandler from '../../api/index.js';
import googleConfigHandler from '../../api/google/config.js';
import { normalizeVercelApiRequestUrl } from './vercelRouting.js';
import { logServerError, sanitizeRequestPath } from './logger.js';

function startTestServer(handler: http.RequestListener = app): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Vercel serverless configuration isolates /api/google/config and routes all other /api/* to /api/index before SPA fallback', () => {
  const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
  const vercelCfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf-8'));

  assert.equal(vercelCfg.buildCommand, 'vite build');
  assert.equal(vercelCfg.outputDirectory, 'dist');

  const rewrites: Array<{ source: string; destination: string }> = vercelCfg.rewrites || [];
  const apiRewriteIdx = rewrites.findIndex((r) => r.destination === '/api/index');
  const spaRewriteIdx = rewrites.findIndex((r) => r.destination === '/index.html');

  assert.ok(apiRewriteIdx >= 0, 'vercel.json must rewrite /api/* to /api/index');
  assert.ok(spaRewriteIdx > apiRewriteIdx, 'SPA fallback rewrite must come after /api/* rewrite');
  assert.ok(
    rewrites[apiRewriteIdx].source.includes('google/config'),
    'API catch-all rewrite must exclude /api/google/config so the isolated config function handles it directly'
  );
  assert.ok(
    rewrites[spaRewriteIdx].source.includes('(?!api'),
    'SPA fallback rewrite must exclude /api paths'
  );

  assert.equal(fs.existsSync(path.resolve(process.cwd(), 'api', 'index.ts')), true);
  assert.equal(fs.existsSync(path.resolve(process.cwd(), 'api', 'google', 'config.ts')), true);
  assert.equal(
    fs.existsSync(path.resolve(process.cwd(), 'api', '[...route].ts')),
    false,
    'Non-Next.js [...route].ts must not exist'
  );
});

test('Serverless ESM hygiene: package.json uses type=module + node 22.x, all api/ & src/server/ relative imports use .js, and umbrella googleapis is not imported', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '22.x');

  const roots = [
    path.resolve(process.cwd(), 'api'),
    path.resolve(process.cwd(), 'src', 'server'),
  ];
  const extensionlessImports: string[] = [];
  const umbrellaGoogleApis: string[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relMatches = content.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g);
        for (const m of relMatches) {
          if (!m[1].endsWith('.js') && !m[1].endsWith('.json')) {
            extensionlessImports.push(`${path.relative(process.cwd(), fullPath)} -> ${m[1]}`);
          }
        }
        if (/from\s+['"]googleapis['"]/.test(content)) {
          umbrellaGoogleApis.push(path.relative(process.cwd(), fullPath));
        }
      }
    }
  }

  for (const r of roots) walk(r);
  assert.deepEqual(extensionlessImports, []);
  assert.deepEqual(umbrellaGoogleApis, []);
});

test('normalizeVercelApiRequestUrl preserves /api/* subpaths, query params, malformed URLs, and avoids double /api/api prefixes', () => {
  assert.equal(
    normalizeVercelApiRequestUrl({ url: '/api/google/config', headers: {} }),
    '/api/google/config'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({
      url: '/api/payroll/payslip-pdf/rec_1?download=1&driveFileId=abc',
      headers: {},
    }),
    '/api/payroll/payslip-pdf/rec_1?download=1&driveFileId=abc'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({ url: '/google/verify-session', headers: {} }),
    '/api/google/verify-session'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({
      url: '/api/index',
      headers: { 'x-vercel-original-url': '/api/google/verify-session?foo=bar' },
    }),
    '/api/google/verify-session?foo=bar'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({
      url: '/api/index?__path=google/config&check=1',
      headers: {},
    }),
    '/api/google/config?check=1'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({ url: '/api/api/google/config', headers: {} }),
    '/api/google/config'
  );
  assert.equal(
    normalizeVercelApiRequestUrl({ url: 'http://[::1', headers: {} }),
    '/api'
  );
});

test('Structured server logger strips query strings and redacts OAuth tokens cleanly', () => {
  assert.equal(
    sanitizeRequestPath('/api/google/verify-session?access_token=ya29.secret_123'),
    '/api/google/verify-session'
  );
  const originalError = console.error;
  let captured = '';
  console.error = (msg?: any) => {
    captured = String(msg || '');
  };
  try {
    const entry = logServerError(
      'test:stage',
      new Error('Failed with Bearer ya29.super_secret_token and access_token=abc123'),
      { method: 'POST', url: '/api/google/verify-session?id_token=secret' }
    );
    assert.equal(entry.stage, 'test:stage');
    assert.equal(entry.path, '/api/google/verify-session');
    assert.equal(entry.message.includes('ya29.super_secret_token'), false);
    assert.equal(entry.message.includes('abc123'), false);
    assert.equal(captured.includes('ya29.super_secret_token'), false);
  } finally {
    console.error = originalError;
  }
});

test('Isolated api/google/config.ts serves configured and unconfigured states cleanly with zero secrets', async () => {
  const prevViteId = process.env.VITE_GOOGLE_CLIENT_ID;
  const prevGoogleId = process.env.GOOGLE_CLIENT_ID;
  const { server, baseUrl } = await startTestServer(googleConfigHandler);

  try {
    // 1. Unconfigured state returns HTTP 200 with clear configured: false payload
    delete process.env.VITE_GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;

    const uncfgRes = await fetch(`${baseUrl}/api/google/config`);
    assert.equal(uncfgRes.status, 200);
    assert.equal(uncfgRes.headers.get('cache-control'), 'no-store');
    const uncfgJson: any = await uncfgRes.json();
    assert.equal(uncfgJson.success, true);
    assert.equal(uncfgJson.configured, false);
    assert.equal(uncfgJson.clientId, null);
    assert.ok(typeof uncfgJson.message === 'string' && uncfgJson.message.includes('VITE_GOOGLE_CLIENT_ID'));
    assert.equal(uncfgJson.clientSecret, undefined);
    assert.equal(uncfgJson.accessToken, undefined);
    assert.equal(uncfgJson.refreshToken, undefined);

    // 2. Configured state returns HTTP 200 with public Client ID and scope metadata
    process.env.VITE_GOOGLE_CLIENT_ID = '1234567890-testclient.apps.googleusercontent.com';
    const cfgRes = await fetch(`${baseUrl}/api/google/config`);
    assert.equal(cfgRes.status, 200);
    const cfgJson: any = await cfgRes.json();
    assert.equal(cfgJson.success, true);
    assert.equal(cfgJson.configured, true);
    assert.equal(cfgJson.clientId, '1234567890-testclient.apps.googleusercontent.com');
    assert.equal(cfgJson.authModel, 'client_gis_in_memory');
    assert.equal(cfgJson.requestedScopesMetadata.length, 4);
    assert.equal(cfgJson.clientSecret, undefined);

    // 3. Non-GET method returns 405 cleanly
    const postRes = await fetch(`${baseUrl}/api/google/config`, { method: 'POST' });
    assert.equal(postRes.status, 405);
  } finally {
    if (prevViteId === undefined) delete process.env.VITE_GOOGLE_CLIENT_ID;
    else process.env.VITE_GOOGLE_CLIENT_ID = prevViteId;
    if (prevGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevGoogleId;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Codebase has zero PostgreSQL, Supabase, legacy JWT, or server client-secret references', () => {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const forbiddenPatterns = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_SECRET_KEY',
    'DATABASE_URL',
    'POSTGRES_URL',
    'JWT_SECRET',
    'GOOGLE_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'peopledesk_auth',
  ];
  const violations: Array<{ file: string; token: string }> = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(fullPath);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (entry.name.endsWith('.test.ts')) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        for (const token of forbiddenPatterns) {
          if (content.includes(token)) {
            violations.push({ file: fullPath, token });
          }
        }
      }
    }
  }

  walk(srcRoot);
  assert.deepEqual(violations, []);
});

test('Client Google Identity Services module stores access tokens strictly in memory (never in localStorage/sessionStorage/IndexedDB)', () => {
  const gisPath = path.resolve(process.cwd(), 'src', 'utils', 'googleAuthClient.ts');
  const source = fs.readFileSync(gisPath, 'utf-8');
  assert.ok(source.includes('https://accounts.google.com/gsi/client'));
  const setItemMatches = source.match(/localStorage\.setItem\([^)]+\)/g) || [];
  for (const match of setItemMatches) {
    assert.ok(match.includes('WORKSPACE_LINKS_KEY'), `Unexpected localStorage.setItem: ${match}`);
  }
  assert.equal(source.includes('sessionStorage.setItem'), false);
});

test('Vercel serverless entrypoint api/index.ts serves Google OAuth & stateless API endpoints without 404 or 500 crashes', async () => {
  const { server, baseUrl } = await startTestServer(vercelHandler);
  try {
    // 1. GET /api/health
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson: any = await healthRes.json();
    assert.equal(healthJson.status, 'healthy');
    assert.equal(healthJson.app, 'Employee Database Studio Enterprise Cloud');

    // 2. GET /api/google/config returns 200 JSON, no-store, and NEVER leaks secrets or tokens
    const cfgRes = await fetch(`${baseUrl}/api/google/config`);
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.headers.get('cache-control'), 'no-store');
    const cfgJson: any = await cfgRes.json();
    assert.equal(cfgJson.success, true);
    assert.equal(cfgJson.authModel, 'client_gis_in_memory');
    assert.equal(cfgJson.clientSecret, undefined);
    assert.equal(cfgJson.accessToken, undefined);
    assert.equal(cfgJson.refreshToken, undefined);

    // 3. POST /api/google/verify-session without auth returns 401 (never 404 or 500)
    const verifyUnauthRes = await fetch(`${baseUrl}/api/google/verify-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(verifyUnauthRes.status, 401);
    const verifyUnauthJson: any = await verifyUnauthRes.json();
    assert.equal(verifyUnauthJson.success, false);
    assert.equal(verifyUnauthJson.code, 'GOOGLE_AUTH_REQUIRED');

    // 4. POST /api/google/test without auth returns 401
    const testUnauthRes = await fetch(`${baseUrl}/api/google/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopeCheck: 'all' }),
    });
    assert.equal(testUnauthRes.status, 401);

    // 5. POST /api/google/revoke returns 200 cleanly
    const revokeRes = await fetch(`${baseUrl}/api/google/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(revokeRes.status, 200);

    // 6. Simulated Vercel rewrite where req.url is /api/index with x-vercel-original-url header
    const proxiedCfgRes = await fetch(`${baseUrl}/api/index`, {
      headers: { 'x-vercel-original-url': '/api/google/config' },
    });
    assert.equal(proxiedCfgRes.status, 200);
    const proxiedCfgJson: any = await proxiedCfgRes.json();
    assert.equal(proxiedCfgJson.success, true);

    const proxiedVerifyRes = await fetch(`${baseUrl}/api/index`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-vercel-original-url': '/api/google/verify-session',
      },
      body: JSON.stringify({}),
    });
    assert.equal(proxiedVerifyRes.status, 401);

    // 7. Unknown /api/* route returns controlled JSON 404 (not HTML)
    const missingApiRes = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
    assert.equal(missingApiRes.status, 404);
    const missingApiJson: any = await missingApiRes.json();
    assert.equal(missingApiJson.success, false);

    // 8. CORS does not reflect untrusted third-party Origin
    const evilCorsRes = await fetch(`${baseUrl}/api/google/config`, {
      headers: { Origin: 'https://untrusted-third-party.example' },
    });
    assert.equal(evilCorsRes.headers.get('access-control-allow-origin'), null);

    // 9. Protected endpoints still require Google Bearer token
    const employeesRes = await fetch(`${baseUrl}/api/employees`);
    assert.equal(employeesRes.status, 401);
    const employeesJson: any = await employeesRes.json();
    assert.equal(employeesJson.code, 'GOOGLE_AUTH_REQUIRED');

    const settingsRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(settingsRes.status, 401);

    const payslipPdfRes = await fetch(`${baseUrl}/api/payroll/save-payslip-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(payslipPdfRes.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
