// AI photo ranking for listing galleries — bulk CLI.
//
// Scores every photo in each listing's Google Drive folder with Claude vision,
// computes an Airbnb-style presentation order (strong hero → best-of-each-room
// tout → room-by-room body → utility/junk at the end), and writes the order to
// KV as `photo_order:<driveFolderId>`. api/media.js applies the stored order
// when serving /api/gdrive, so galleries pick it up with no frontend changes.
//
// The scoring/ordering logic lives in lib/photorank.js, shared with the
// "Sort photos with AI" button (api/listings.js ?rank=1, api/portal.js
// ?action=rank). This CLI is for bulk runs across every folder at once.
//
// Folders are keyed by Drive folder ID (not slug) because some units share a
// photo set. A folder is skipped when its stored order already covers the
// exact set of files currently in Drive — so re-running after uploading
// photos or adding a listing re-ranks only what changed.
//
// Usage:
//   node --env-file=.env.photorank dev/photo-rank.mjs [options]
//
//   --folder <id>   only process this Drive folder
//   --dry-run       print the computed order, write nothing
//   --force         re-rank even if the stored order is up to date
//   --model <id>    override model (default claude-sonnet-5)
//   --thumb <w>     thumbnail width sent to the model (default 400)
//
// Required env (put in .env.photorank; pull the first three with
// `npx vercel env pull .env.photorank`, then append ANTHROPIC_API_KEY):
//   KV_REST_API_URL, KV_REST_API_TOKEN, GOOGLE_API_KEY, ANTHROPIC_API_KEY
//
// New listing / new photos procedure: run with no args (or use the in-app
// "Sort photos with AI" button in admin / the owner portal).

import { UNITS } from '../lib/catalog.js';
import { listDriveFiles, scoreBatch, computeOrder, buildOrderRecord, BATCH_SIZE, DEFAULT_MODEL } from '../lib/photorank.js';

// ── config ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const ONLY_FOLDER = argValue('--folder');
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const MODEL = argValue('--model') || DEFAULT_MODEL;
const THUMB_W = parseInt(argValue('--thumb') || '400', 10);

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
for (const [name, val] of [
  ['KV_REST_API_URL', KV_URL], ['KV_REST_API_TOKEN', KV_TOKEN],
  ['GOOGLE_API_KEY', GOOGLE_API_KEY], ['ANTHROPIC_API_KEY', ANTHROPIC_API_KEY],
]) {
  if (!val) { console.error(`Missing env var ${name}`); process.exit(1); }
}

// ── KV helpers (Upstash REST, same shape as api/listings.js) ────────
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const json = await r.json();
  if (!json.result) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}
async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`kvSet ${key} failed: ${r.status}`);
}
async function kvDel(key) {
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

// ── folder enumeration ──────────────────────────────────────────────
// Accepts a raw folder ID or a Drive folder URL (owner-submitted listings
// sometimes store the full link).
function extractFolderId(v) {
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/folders\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(v)) return v;
  return null;
}

async function enumerateFolders() {
  const folders = new Map(); // folderId -> label (for logging)
  for (const u of UNITS) {
    const override = await kvGet(`listing:${u.slug}`);
    const id = extractFolderId(override?.folder) || extractFolderId(u.folder);
    if (id && !folders.has(id)) folders.set(id, u.name);
  }
  const custom = (await kvGet('custom_properties')) || {};
  for (const [slug, listing] of Object.entries(custom)) {
    const id = extractFolderId(listing?.folder);
    if (id && !folders.has(id)) folders.set(id, listing.name || slug);
  }
  return folders;
}

// ── main ────────────────────────────────────────────────────────────
async function processFolder(folder, label) {
  console.log(`\n▶ ${label} (${folder})`);
  const files = await listDriveFiles(folder, GOOGLE_API_KEY);
  if (!files.length) { console.log('  no images found, skipping'); return 'empty'; }
  console.log(`  ${files.length} photos in Drive`);

  const existing = await kvGet(`photo_order:${folder}`);
  if (existing && !FORCE) {
    const stored = new Set(existing.order || []);
    const current = new Set(files.map(f => f.id));
    const same = stored.size === current.size && [...current].every(id => stored.has(id));
    if (same) { console.log('  skipped (up-to-date)'); return 'skipped'; }
    console.log('  photo set changed since last rank, re-ranking');
  }

  const scored = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    console.log(`    scoring photos ${i + 1}-${i + batch.length} of ${files.length}...`);
    scored.push(...await scoreBatch(batch, { apiKey: ANTHROPIC_API_KEY, model: MODEL, thumbW: THUMB_W }));
  }
  const result = computeOrder(scored);
  const { order, junkStart, sequence } = result;

  console.log(`  computed order: ${junkStart} gallery photos, ${order.length - junkStart} in junk tail`);
  if (DRY_RUN) {
    sequence.forEach((p, i) => {
      const tag = i === 0 ? 'HERO' : (i >= junkStart ? 'JUNK' : String(i + 1).padStart(4));
      console.log(`  ${tag}  [${p.category}] appeal=${p.appeal}${p.flaws.length ? ' flaws=' + p.flaws.join(',') : ''}  ${p.name}`);
    });
    console.log('  (dry run — nothing written)');
    return 'dry-run';
  }

  await kvSet(`photo_order:${folder}`, buildOrderRecord(result, MODEL));
  await kvDel(`autocover:${folder}`);
  console.log('  ✓ wrote photo_order and cleared autocover');
  return 'ranked';
}

async function main() {
  const folders = await enumerateFolders();
  console.log(`${folders.size} distinct Drive folders across all listings`);

  const targets = ONLY_FOLDER
    ? new Map([[ONLY_FOLDER, folders.get(ONLY_FOLDER) || '(folder not in catalog)']])
    : folders;

  const results = {};
  let failures = 0;
  for (const [folder, label] of targets) {
    try {
      results[folder] = await processFolder(folder, label);
    } catch (e) {
      // No partial writes: a folder either gets a complete order or keeps its
      // previous state. Re-running resumes exactly the failed folders.
      failures++;
      results[folder] = 'FAILED';
      console.error(`  ✗ ${label}: ${e.message}`);
    }
  }

  console.log('\nSummary:');
  for (const [folder, status] of Object.entries(results)) {
    console.log(`  ${status.padEnd(8)} ${targets.get(folder)} (${folder})`);
  }
  if (failures) { console.error(`\n${failures} folder(s) failed — re-run to retry them.`); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
