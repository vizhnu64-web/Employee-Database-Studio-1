// Targeted Google API subpath clients (Drive v3, Sheets v4, Gmail v1).
// Avoids importing the 237 MB umbrella `googleapis` index (400+ APIs / 1,100+ modules)
// so serverless cold starts stay fast and well under Vercel's Lambda size limits.

import driveMod from 'googleapis/build/src/apis/drive/v3.js';
import sheetsMod from 'googleapis/build/src/apis/sheets/v4.js';
import gmailMod from 'googleapis/build/src/apis/gmail/v1.js';

function buildBearerHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken.trim()}`,
  };
}

export function createDriveApiClient(accessToken: string) {
  return new driveMod.drive_v3.Drive({
    headers: buildBearerHeaders(accessToken),
  });
}

export function createSheetsApiClient(accessToken: string) {
  return new sheetsMod.sheets_v4.Sheets({
    headers: buildBearerHeaders(accessToken),
  });
}

export function createGmailApiClient(accessToken: string) {
  return new gmailMod.gmail_v1.Gmail({
    headers: buildBearerHeaders(accessToken),
  });
}
