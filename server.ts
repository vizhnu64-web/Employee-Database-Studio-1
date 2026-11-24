import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { app } from './src/server/app';
import { getResolvedSmtpConfig } from './src/server/routes/email';
import { getPublicGoogleClientId } from './src/server/routes/googleAuth';

dotenv.config();

const PORT = process.env.PORT || 3000;

function checkDeploymentEnvironment() {
  const googleClientId = getPublicGoogleClientId();
  if (!googleClientId) {
    console.warn(
      '[Employee Database Studio Google Auth] VITE_GOOGLE_CLIENT_ID / GOOGLE_CLIENT_ID is not set. Google Sign-In will stay disabled until a valid OAuth Client ID is configured.'
    );
  } else {
    console.log('[Employee Database Studio Google Auth] Public Google OAuth Client ID detected for client-side GIS.');
  }

  const smtp = getResolvedSmtpConfig();
  if (!smtp.isConfigured) {
    console.log('[Employee Database Studio Email] Company SMTP env variables not configured; email delivery will use HR Gmail API or runtime session SMTP.');
  } else {
    console.log(`[Employee Database Studio Email] Company SMTP env configuration detected for host: ${smtp.smtpHost}`);
  }
}

async function startServer() {
  checkDeploymentEnvironment();

  let viteServer: { close: () => Promise<void>; middlewares: express.RequestHandler } | null = null;

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    viteServer = vite;
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  const portNumber = Number(PORT) || 3000;
  const httpServer = app.listen(portNumber, '0.0.0.0', () => {
    console.log(`[Employee Database Studio] Stateless Google Workspace Server listening on http://0.0.0.0:${portNumber}`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Employee Database Studio] Port ${portNumber} is already in use (${err.message}).`);
    } else {
      console.error('[Employee Database Studio] HTTP server error:', err?.message || err);
    }
    if (viteServer) {
      viteServer.close().catch(() => {});
    }
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    console.log(`[Employee Database Studio] Received ${signal}, closing server cleanly...`);
    httpServer.close(() => {
      if (viteServer) {
        viteServer.close().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const isDirectExecution =
  process.env.VERCEL !== '1' &&
  process.env.NODE_ENV !== 'test' &&
  Boolean(process.argv[1] && /(?:^|[\\/])server\.(?:ts|js|mjs|cjs)$/.test(process.argv[1]));

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('[Employee Database Studio] Server failed to start:', err?.message || err);
  });
}

export { app };
export default app;
