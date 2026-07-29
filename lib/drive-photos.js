// ── LISTING-IMPORT → GOOGLE DRIVE PHOTO PIPELINE ────────────────────
// The Airbnb/Booking importer extracts gallery photo URLs; this uploads them
// into a per-villa Google Drive folder so the portal's existing Drive-based
// gallery machinery (api/media?source=drive, cover picker, AI sort) works on
// imported listings with zero special-casing.
//
// Auth: Google service account, no SDK — RS256 JWT signed with node crypto.
// Required env (Vercel, same values as the kaya-agent-crm project):
//   GOOGLE_SA_EMAIL        service account email
//   GOOGLE_SA_KEY          the SA JSON's private_key (\n-escaped ok)
//   DRIVE_PARENT_FOLDER_ID a folder shared with the SA as Editor
//
// Each villa folder gets "anyone with link can view" — exactly what the
// portal's API-key gallery reads require. lib/* is bundled into api/* by
// Vercel's nft, so this does NOT count against the 12-function cap.

import crypto from 'crypto';

const b64url = (s) => Buffer.from(s).toString('base64url');

export const driveConfigured = () =>
  !!(process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_KEY && process.env.DRIVE_PARENT_FOLDER_ID);

let cached = null; // { token, exp } — reused for the lambda's lifetime
async function getAccessToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const email = process.env.GOOGLE_SA_EMAIL;
  const key = String(process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64url(JSON.stringify({
      iss: email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    }));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`SA token exchange failed: ${d.error_description || d.error || 'unknown'}`);
  cached = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 - 60000 };
  return cached.token;
}

// Create the villa's photo folder (public-viewable) under the parent.
export async function createPhotoFolder(folderName) {
  const token = await getAccessToken();
  const create = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.DRIVE_PARENT_FOLDER_ID],
    }),
  });
  const folder = await create.json();
  if (!create.ok) throw new Error(`Drive folder create failed: ${folder?.error?.message || create.status}`);
  const perm = await fetch(`https://www.googleapis.com/drive/v3/files/${folder.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (!perm.ok) {
    const pd = await perm.json().catch(() => ({}));
    throw new Error(`Drive permission failed: ${pd?.error?.message || perm.status}`);
  }
  return folder.id;
}

export const folderLink = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;

// Download one CDN image and upload it into the folder. `index` keeps Drive's
// name-sort order matching the source gallery order (001-, 002-, …) — the
// portal's auto-cover and gallery default to name order.
export async function uploadPhotoFromUrl({ url, folderId, index }) {
  // Airbnb originals can be huge — ask the CDN for a resized variant.
  const fetchUrl = /a0\.muscache\.com/.test(url) ? `${url}?im_w=1920` : url;
  const imgRes = await fetch(fetchUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`image download HTTP ${imgRes.status}`);
  const mime = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\//.test(mime)) throw new Error(`not an image: ${mime}`);
  const bytes = Buffer.from(await imgRes.arrayBuffer());
  if (bytes.length < 1000) throw new Error('image too small — likely an error page');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const name = `${String(index + 1).padStart(3, '0')}-import.${ext}`;

  const token = await getAccessToken();
  const boundary = 'samba' + crypto.randomBytes(8).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name, parents: [folderId] }) +
    `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, bytes, tail]),
  });
  const file = await up.json();
  if (!up.ok) throw new Error(`Drive upload failed: ${file?.error?.message || up.status}`);
  return file.id;
}
