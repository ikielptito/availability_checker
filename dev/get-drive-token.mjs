#!/usr/bin/env node
// One-time OAuth setup for the Drive photo pipeline (drive.file scope).
//
// Why: service accounts have no Drive storage quota on personal Gmail, so
// photo uploads must run as the Drive owner. This script mints a refresh
// token for that, and creates the app-owned parent folder that the
// drive.file scope requires (the scope only reaches files this app created).
//
// Usage:
//   GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy node dev/get-drive-token.mjs
//
// It prints a consent URL — open it, approve with the Drive-owner Google
// account, and the script finishes by printing the three Vercel env values.

import http from 'http';
import crypto from 'crypto';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (from the GCP OAuth client), e.g.:');
  console.error('  GOOGLE_OAUTH_CLIENT_ID=xxx GOOGLE_OAUTH_CLIENT_SECRET=yyy node dev/get-drive-token.mjs');
  process.exit(1);
}

const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const state = crypto.randomBytes(12).toString('hex');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent', // force a refresh_token even on re-consent
  state,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  if (url.searchParams.get('state') !== state) { res.writeHead(400).end('state mismatch'); return; }
  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400).end('no code'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' })
    .end('<body style="font-family:sans-serif;padding:40px">✅ Done — you can close this tab and return to the terminal.</body>');
  server.close();

  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT, grant_type: 'authorization_code',
      }).toString(),
    });
    const tokens = await tr.json();
    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token in response:', JSON.stringify(tokens));
      console.error('(If you approved before, revoke the app at myaccount.google.com/permissions and rerun.)');
      process.exit(1);
    }

    // Create the app-owned parent folder — with drive.file scope, the app can
    // only work inside folders it created itself, so this replaces any
    // manually created parent folder.
    const fr = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Samba villa photos (auto)', mimeType: 'application/vnd.google-apps.folder' }),
    });
    const folder = await fr.json();
    if (!fr.ok) { console.error('Folder create failed:', JSON.stringify(folder)); process.exit(1); }

    console.log('\n✅ All set. Put these in BOTH Vercel projects (sambarentals + kaya-agent-crm):\n');
    console.log('GOOGLE_OAUTH_CLIENT_ID=' + CLIENT_ID);
    console.log('GOOGLE_OAUTH_CLIENT_SECRET=' + CLIENT_SECRET);
    console.log('GOOGLE_OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('DRIVE_PARENT_FOLDER_ID=' + folder.id + '   (REPLACES the old value — this is the new "Samba villa photos (auto)" folder)');
    console.log('\nThe GOOGLE_SA_EMAIL / GOOGLE_SA_KEY vars are no longer needed and can be deleted.');
    console.log('Folder: https://drive.google.com/drive/folders/' + folder.id);
    process.exit(0);
  } catch (e) {
    console.error('Token exchange failed:', e.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\n1. Open this URL in your browser (sign in as the Drive owner):\n');
  console.log(authUrl + '\n');
  console.log('2. Approve access. This terminal finishes automatically.\n');
});
