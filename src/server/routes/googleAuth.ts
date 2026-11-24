import { Router, Request, Response } from 'express';
import {
  requireGoogleAccessToken,
  GoogleAuthRequest,
  extractBearerToken,
} from '../middleware/googleAuth.js';
import {
  GOOGLE_OAUTH_SCOPES,
  RequestedScopeDetail,
  getPublicGoogleClientId,
  buildGoogleOAuthScopes,
  buildRequestedScopeMetadata,
  buildGoogleConfigPayload,
} from '../googleConfig.js';
import { createDriveApiClient } from '../services/googleClients.js';
import { logServerError } from '../logger.js';

export {
  GOOGLE_OAUTH_SCOPES,
  getPublicGoogleClientId,
  buildGoogleOAuthScopes,
  buildRequestedScopeMetadata,
  buildGoogleConfigPayload,
};
export type { RequestedScopeDetail };

const router = Router();

// Never cache OAuth configuration or session verification responses on CDN/proxies
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// GET /api/google/config - Public Google Identity Services Client ID & scope metadata (NEVER returns secrets)
router.get('/config', (_req: Request, res: Response) => {
  res.json(buildGoogleConfigPayload());
});

// POST /api/google/verify-session - Validate an in-memory GIS OAuth access token & optional Google ID token
router.post('/verify-session', async (req: Request, res: Response) => {
  try {
    const bearer = extractBearerToken(req);
    const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken.trim() : '';

    if (!bearer && !idToken) {
      return res.status(401).json({
        success: false,
        code: 'GOOGLE_AUTH_REQUIRED',
        error: 'Provide a Bearer Google OAuth access token or Google ID token to verify session.',
      });
    }

    const configuredClientId = getPublicGoogleClientId();
    let verifiedProfile: { email: string; name: string; picture: string | null; sub: string | null } | null = null;
    let grantedScopes: string[] = [];
    let expiresIn: number | null = null;

    if (idToken) {
      const idRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
      );
      const idInfo: any = await idRes.json();
      if (!idRes.ok || !idInfo.email) {
        return res.status(401).json({
          success: false,
          error: idInfo?.error_description || 'Invalid or expired Google ID token.',
        });
      }
      if (configuredClientId && idInfo.aud && idInfo.aud !== configuredClientId) {
        return res.status(401).json({
          success: false,
          error: 'Google ID token audience does not match this application Client ID.',
        });
      }
      verifiedProfile = {
        email: String(idInfo.email),
        name: String(idInfo.name || idInfo.email.split('@')[0]),
        picture: idInfo.picture ? String(idInfo.picture) : null,
        sub: idInfo.sub ? String(idInfo.sub) : null,
      };
    }

    if (bearer) {
      const [tokenInfoRes, userInfoRes] = await Promise.all([
        fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(bearer)}`),
        fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${bearer}` },
        }),
      ]);

      const tokenInfo: any = await tokenInfoRes.json().catch(() => ({}));
      if (!tokenInfoRes.ok || tokenInfo.error) {
        return res.status(401).json({
          success: false,
          code: 'GOOGLE_TOKEN_EXPIRED',
          error: tokenInfo?.error_description || 'Google OAuth access token is invalid or expired.',
        });
      }

      if (configuredClientId && tokenInfo.aud && tokenInfo.aud !== configuredClientId) {
        return res.status(401).json({
          success: false,
          error: 'Google OAuth token audience does not match configured Client ID.',
        });
      }

      grantedScopes = String(tokenInfo.scope || '')
        .split(/[\s,]+/)
        .filter(Boolean);
      expiresIn = tokenInfo.expires_in ? Number(tokenInfo.expires_in) : null;

      if (userInfoRes.ok) {
        const ui: any = await userInfoRes.json();
        if (ui?.email) {
          verifiedProfile = {
            email: String(ui.email),
            name: String(ui.name || verifiedProfile?.name || ui.email.split('@')[0]),
            picture: ui.picture ? String(ui.picture) : verifiedProfile?.picture || null,
            sub: ui.sub ? String(ui.sub) : verifiedProfile?.sub || null,
          };
        }
      }
    }

    const requestedScopesMetadata = buildRequestedScopeMetadata(grantedScopes);
    res.json({
      success: true,
      profile: verifiedProfile,
      scopes: grantedScopes,
      expiresIn,
      requestedScopesMetadata,
      permissionSummary: {
        identity: requestedScopesMetadata.find((s) => s.key === 'identity')?.granted ?? Boolean(verifiedProfile),
        drive: requestedScopesMetadata.find((s) => s.key === 'drive')?.granted ?? false,
        sheets: requestedScopesMetadata.find((s) => s.key === 'sheets')?.granted ?? false,
        gmail: requestedScopesMetadata.find((s) => s.key === 'gmail')?.granted ?? false,
      },
      verifiedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const status = err?.statusCode || 500;
    if (status >= 500) {
      logServerError('googleAuth:verify-session', err, req);
    }
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Internal server error.' : err?.message || 'Failed to verify Google session.',
    });
  }
});

// POST /api/google/test - Verify live Google API connectivity using client-supplied Bearer access token
router.post('/test', requireGoogleAccessToken, async (req: GoogleAuthRequest, res: Response) => {
  try {
    const scopeCheck = String(req.body?.scopeCheck || 'all').toLowerCase();
    const token = req.googleAccessToken!;

    const [tokenInfoRes, driveAbout] = await Promise.all([
      fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`),
      (async () => {
        const drive = createDriveApiClient(token);
        return drive.about.get({ fields: 'user(emailAddress,displayName,photoLink)' });
      })(),
    ]);

    const tokenInfo: any = await tokenInfoRes.json().catch(() => ({}));
    const granted = String(tokenInfo.scope || '').toLowerCase();
    const driveReady = granted.includes('drive');
    const sheetsReady = granted.includes('spreadsheets');
    const gmailReady = granted.includes('gmail.send') || granted.includes('mail.google');

    if (scopeCheck === 'gmail' && !gmailReady) {
      return res.status(403).json({
        success: false,
        error: 'Google account is connected, but Gmail Send permission (gmail.send) has not been granted yet. Enable Gmail Permission incrementally first.',
      });
    }
    if (scopeCheck === 'sheets' && !sheetsReady) {
      return res.status(403).json({
        success: false,
        error: 'Google Sheets permission (spreadsheets) has not been granted. Please Reconnect Google Workspace permissions.',
      });
    }

    const email = driveAbout.data.user?.emailAddress || tokenInfo.email || '';
    res.json({
      success: true,
      message: `Verified live Google API connectivity for ${email || 'signed-in user'}.`,
      email,
      displayName: driveAbout.data.user?.displayName || null,
      picture: driveAbout.data.user?.photoLink || null,
      identityReady: true,
      driveReady,
      sheetsReady,
      gmailReady,
      scopes: String(tokenInfo.scope || '').split(/[\s,]+/).filter(Boolean),
      verifiedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    const status = err?.code || err?.response?.status || err?.statusCode || 500;
    const numericStatus = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
    if (numericStatus >= 500) {
      logServerError('googleAuth:test', err, req);
    }
    res.status(numericStatus).json({
      success: false,
      error:
        numericStatus === 401
          ? 'Google OAuth access token expired or revoked. Please sign in with Google again.'
          : numericStatus >= 500
            ? 'Internal server error.'
            : err?.message || 'Google API verification failed.',
    });
  }
});

// POST /api/google/revoke - Revoke a Bearer OAuth access token cleanly on Disconnect
router.post('/revoke', async (req: Request, res: Response) => {
  const token = extractBearerToken(req) || (typeof req.body?.token === 'string' ? req.body.token.trim() : '');
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => {});
  }
  res.json({
    success: true,
    message: 'Google OAuth session cleared from application memory and token revocation requested.',
  });
});

export default router;
