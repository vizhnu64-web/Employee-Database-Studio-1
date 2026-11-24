export const GOOGLE_OAUTH_SCOPES = {
  identity: ['openid', 'email', 'profile'],
  drive: 'https://www.googleapis.com/auth/drive.file',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  gmail: 'https://www.googleapis.com/auth/gmail.send',
} as const;

export interface RequestedScopeDetail {
  scope: string;
  key: 'identity' | 'drive' | 'sheets' | 'gmail';
  label: string;
  reason: string;
  verificationNote: string;
  optional: boolean;
  granted: boolean;
}

export function getPublicGoogleClientId(): string {
  return String(
    process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || ''
  ).trim();
}

export function buildGoogleOAuthScopes(options?: {
  includeGmail?: boolean;
  gmailOnly?: boolean;
}): string[] {
  const scopes = new Set<string>(GOOGLE_OAUTH_SCOPES.identity);
  if (options?.gmailOnly) {
    scopes.add(GOOGLE_OAUTH_SCOPES.gmail);
    return Array.from(scopes);
  }
  scopes.add(GOOGLE_OAUTH_SCOPES.drive);
  scopes.add(GOOGLE_OAUTH_SCOPES.sheets);
  if (options?.includeGmail) {
    scopes.add(GOOGLE_OAUTH_SCOPES.gmail);
  }
  return Array.from(scopes);
}

export function buildRequestedScopeMetadata(grantedScopes: string[]): RequestedScopeDetail[] {
  const lower = grantedScopes.map((s) => s.toLowerCase());
  const has = (kw: string) => lower.some((s) => s.includes(kw));

  return [
    {
      scope: 'openid email profile',
      key: 'identity',
      label: 'Google Profile & Email Identity',
      reason: 'Displays your signed-in HR Google account name, email address, and profile photo inside Employee Database Studio.',
      verificationNote: 'Standard OpenID Connect identity scopes via Google Identity Services.',
      optional: false,
      granted: has('email') || has('openid') || has('userinfo.email') || lower.length > 0,
    },
    {
      scope: GOOGLE_OAUTH_SCOPES.drive,
      key: 'drive',
      label: 'Private App & Selected Drive Folders (drive.file)',
      reason: 'Stores employee documents, payslip PDFs, company logos, and backups strictly in the HR-linked or app-created Drive folder.',
      verificationNote: 'Non-sensitive per-file Drive scope; never reads unrelated personal Drive files.',
      optional: false,
      granted: has('drive.file') || has('https://www.googleapis.com/auth/drive'),
    },
    {
      scope: GOOGLE_OAUTH_SCOPES.sheets,
      key: 'sheets',
      label: 'Google Sheets Structured HR Database (spreadsheets)',
      reason: 'Reads and updates the 10 structured HR worksheets inside your connected Employee Database Studio spreadsheet.',
      verificationNote: 'Sensitive Google Sheets scope; consent granted explicitly by the HR user in Google Identity Services.',
      optional: false,
      granted: has('spreadsheets'),
    },
    {
      scope: GOOGLE_OAUTH_SCOPES.gmail,
      key: 'gmail',
      label: 'HR Gmail Dispatch (gmail.send — Incremental Opt-in)',
      reason: 'Allows HR to send individual employee payslip emails from their own Gmail mailbox as an alternative to Company SMTP.',
      verificationNote: 'Requested incrementally only when HR enables Gmail payslip delivery. Company SMTP works independently without this scope.',
      optional: true,
      granted: has('gmail.send') || has('https://mail.google.com'),
    },
  ];
}

export function buildGoogleConfigPayload() {
  const clientId = getPublicGoogleClientId();
  const configured = Boolean(clientId);

  return {
    success: true,
    configured,
    clientId: clientId || null,
    authModel: 'client_gis_in_memory' as const,
    defaultScopes: buildGoogleOAuthScopes(),
    optionalGmailScope: GOOGLE_OAUTH_SCOPES.gmail,
    requestedScopesMetadata: buildRequestedScopeMetadata([]),
    ...(!configured
      ? {
          message:
            'Google OAuth Client ID is not configured on the server. Set VITE_GOOGLE_CLIENT_ID (or GOOGLE_CLIENT_ID) in your deployment environment variables.',
        }
      : {}),
  };
}
