import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import settingsRoutes from './routes/settings.js';
import employeeRoutes from './routes/employees.js';
import documentRoutes from './routes/documents.js';
import backupRoutes from './routes/backup.js';
import emailRoutes, { getResolvedSmtpConfig } from './routes/email.js';
import payrollRoutes from './routes/payroll.js';
import googleAuthRoutes, { getPublicGoogleClientId } from './routes/googleAuth.js';
import sheetsRoutes from './routes/sheets.js';
import driveRoutes from './routes/drive.js';
import { logServerError } from './logger.js';

dotenv.config();

const app = express();

// Trust first proxy (Vercel, Cloud Run, Load Balancers)
app.set('trust proxy', 1);

function buildAllowedOriginChecker() {
  const configuredOrigins = new Set<string>();
  const envOrigins = [
    process.env.APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '',
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : '',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
  ];

  for (const raw of envOrigins) {
    const trimmed = String(raw || '').trim().replace(/\/+$/, '');
    if (trimmed) configuredOrigins.add(trimmed);
  }

  return (req: express.Request): cors.CorsOptions => {
    const origin = req.headers.origin;
    if (!origin) {
      return { origin: false };
    }

    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    const isSameHost =
      Boolean(hostHeader) &&
      (origin === `https://${hostHeader}` || origin === `http://${hostHeader}`);
    const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    const isConfigured = configuredOrigins.has(origin.replace(/\/+$/, ''));

    if (isSameHost || isLocalDev || isConfigured) {
      return {
        origin: true,
        credentials: false,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'X-Spreadsheet-Id',
          'X-Drive-Folder-Id',
          'X-Google-Email',
        ],
      };
    }

    return { origin: false };
  };
}

const getCorsOptions = buildAllowedOriginChecker();
app.use((req, res, next) => {
  cors(getCorsOptions(req))(req, res, next);
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
    forwardedHeader: false,
    trustProxy: false,
  },
});
app.use('/api/', apiLimiter);

// Stateless Health Check (never blocks startup or requires external DB)
app.get('/api/health', (_req, res) => {
  const clientIdConfigured = Boolean(getPublicGoogleClientId());
  const smtp = getResolvedSmtpConfig();

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    status: 'healthy',
    app: 'Employee Database Studio Enterprise Cloud',
    version: '3.0.0',
    mode: process.env.NODE_ENV || 'development',
    serverless: process.env.VERCEL === '1',
    architecture: {
      database: 'google_sheets',
      fileStorage: 'google_drive',
      authentication: 'google_identity_services_client_in_memory',
      emailProviders: ['gmail_api', 'company_smtp'],
    },
    checks: {
      googleOAuth: {
        configured: clientIdConfigured,
        authFlow: 'client_gis_in_memory',
      },
      googleSheets: {
        provider: 'google-sheets',
        statelessProxyReady: true,
      },
      googleDrive: {
        provider: 'google-drive',
        statelessProxyReady: true,
      },
      smtp: {
        configured: smtp.isConfigured,
        verified: smtp.isVerified,
        source: smtp.source,
      },
    },
    timestamp: new Date().toISOString(),
  });
});

// Active Stateless API Routes (Google Workspace + SMTP proxies)
app.use('/api/google', googleAuthRoutes);
app.use('/api/sheets', sheetsRoutes);
app.use('/api/drive', driveRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/backup', backupRoutes);

// Controlled JSON 404 for unknown /api/* endpoints (never falls through to HTML)
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// Controlled JSON error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status =
    err?.statusCode ||
    (err?.type === 'entity.parse.failed' ? 400 : err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  logServerError('express:error-middleware', err, req);
  const clientMessage =
    status >= 500 ? 'Internal server error.' : err?.message || 'Request failed.';
  if (!res.headersSent) {
    res.status(status).json({ success: false, error: clientMessage });
  }
});

export { app };
export default app;
