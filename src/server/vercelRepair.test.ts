import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { app } from '../../server';
import vercelHandler from '../../api/index';
import { normalizeVercelApiRequestUrl } from './vercelRouting';

function startTestServer(handler: http.RequestListener = app): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('Vercel serverless configuration routes /api/* to /api/index before SPA fallback without invalid [...route].ts', () => {
  const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
  const vercelCfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf-8'));

  assert.equal(vercelCfg.buildCommand, 'vite build');
  assert.equal(vercelCfg.outputDirectory, 'dist');

  const rewrites: Array<{ source: string; destination: string }> = vercelCfg.rewrites || [];
  const apiRewriteIdx = rewrites.findIndex(
    (r) => r.source === '/api/(.*)' && r.destination === '/api/index'
  );
  const spaRewriteIdx = rewrites.findIndex(
    (r) => r.destination === '/index.html'
  );

  assert.ok(apiRewriteIdx >= 0, 'vercel.json must rewrite /api/(.*) to /api/index');
  assert.ok(spaRewriteIdx > apiRewriteIdx, 'SPA fallback rewrite must come after /api/(.*) rewrite');
  assert.ok(
    rewrites[spaRewriteIdx].source.includes('(?!api'),
    'SPA fallback rewrite must exclude /api paths'
  );

  const apiIndexPath = path.resolve(process.cwd(), 'api', 'index.ts');
  const legacyCatchAllPath = path.resolve(process.cwd(), 'api', '[...route].ts');
  assert.equal(fs.existsSync(apiIndexPath), true);
  assert.equal(fs.existsSync(legacyCatchAllPath), false, 'Non-Next.js [...route].ts must not exist');
});

test('normalizeVercelApiRequestUrl preserves /api/* subpaths, query params, and avoids double /api/api prefixes', () => {
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
  // Runtime strips /api prefix
  assert.equal(
    normalizeVercelApiRequestUrl({ url: '/google/verify-session', headers: {} }),
    '/api/google/verify-session'
  );
  // Proxy rewrites url to /api/index while passing original URL header
  assert.equal(
    normalizeVercelApiRequestUrl({
      url: '/api/index',
      headers: { 'x-vercel-original-url': '/api/google/verify-session?foo=bar' },
    }),
    '/api/google/verify-session?foo=bar'
  );
  // Proxy rewrites url to /api/index with __path query parameter + existing query string
  assert.equal(
    normalizeVercelApiRequestUrl({
      url: '/api/index?__path=google/config&check=1',
      headers: {},
    }),
    '/api/google/config?check=1'
  );
  // Guard against double /api/api prefix
  assert.equal(
    normalizeVercelApiRequestUrl({ url: '/api/api/google/config', headers: {} }),
    '/api/google/config'
  );
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
  // Only WORKSPACE_LINKS_KEY (non-secret IDs/URLs) may be persisted in localStorage
  const setItemMatches = source.match(/localStorage\.setItem\([^)]+\)/g) || [];
  for (const match of setItemMatches) {
    assert.ok(match.includes('WORKSPACE_LINKS_KEY'), `Unexpected localStorage.setItem: ${match}`);
  }
  assert.equal(source.includes('sessionStorage.setItem'), false);
});

test('Vercel serverless entrypoint api/index.ts serves Google OAuth & stateless API endpoints without 404s', async () => {
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

    // 3. POST /api/google/verify-session without auth returns 401 (never 404 or bypassed)
    const verifyUnauthRes = await fetch(`${baseUrl}/api/google/verify-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(verifyUnauthRes.status, 401);
    const verifyUnauthJson: any = await verifyUnauthRes.json();
    assert.equal(verifyUnauthJson.success, false);
    assert.equal(verifyUnauthJson.code, 'GOOGLE_AUTH_REQUIRED');

    // 4. POST /api/google/test without auth returns 401 (never 404)
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
