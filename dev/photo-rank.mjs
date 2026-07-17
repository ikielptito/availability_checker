// AI photo ranking for listing galleries.
//
// Scores every photo in each listing's Google Drive folder with Claude vision,
// computes an Airbnb-style presentation order (strong hero → best-of-each-room
// tout → room-by-room body → utility/junk at the end), and writes the order to
// KV as `photo_order:<driveFolderId>`. api/media.js applies the stored order
// when serving /api/gdrive, so galleries pick it up with no frontend changes.
//
// Folders are keyed by Drive folder ID (not slug) because the Tropicana units
// share one photo set. A folder is skipped when its stored order already covers
// the exact set of files currently in Drive — so re-running after uploading
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
// New listing / new photos procedure: just run the script again with no args.

import { UNITS } from '../lib/catalog.js';

// ── config ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const ONLY_FOLDER = argValue('--folder');
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const MODEL = argValue('--model') || 'claude-sonnet-5';
const THUMB_W = parseInt(argValue('--thumb') || '400', 10);
const BATCH_SIZE = 20;

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

// ── Drive listing (paginated — no 150 cap) ──────────────────────────
async function listDriveFiles(folder) {
  const files = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folder}'+in+parents+and+mimeType+contains+'image/'` +
      `&fields=nextPageToken,files(id,name)&pageSize=1000&key=${GOOGLE_API_KEY}` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(`Drive list failed for ${folder}: ${data.error.message}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// ── Claude vision scoring ───────────────────────────────────────────
const CATEGORIES = ['hero-exterior', 'pool', 'living', 'bedroom', 'bathroom', 'kitchen',
  'view', 'outdoor', 'amenity', 'detail', 'utility-junk'];
const FLAWS = ['dark', 'blurry', 'cluttered', 'distorted', 'duplicate-angle',
  'people-visible', 'construction', 'empty-room'];

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['photos'],
  properties: {
    photos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'category', 'appeal', 'flaws'],
        properties: {
          n: { type: 'integer' },
          category: { type: 'string', enum: CATEGORIES },
          appeal: { type: 'integer' },
          flaws: { type: 'array', items: { type: 'string', enum: FLAWS } },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are ranking photos for a Bali villa/apartment rental listing gallery. For each numbered photo, classify it into exactly one category and give an appeal score from 0 to 10 (10 = magazine-quality, makes someone want to book immediately; 0 = should never be shown to a prospective guest). "utility-junk" means: staircases, corridors, fire extinguishers, electrical panels or meters, water heaters, storage/closet interiors, parking areas, signage, construction details, or anything a guest would find confusing or off-putting early in a gallery. Score appeal on lighting, composition, and how inviting the space looks. Flag flaws honestly. Return one entry per photo with n matching the photo's label.`;

function thumbUrl(fileId) {
  return `https://lh3.googleusercontent.com/d/${fileId}=w${THUMB_W}`;
}

async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`thumb fetch failed ${r.status}: ${url}`);
  const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const buf = Buffer.from(await r.arrayBuffer());
  return { media_type: ct, data: buf.toString('base64') };
}

async function anthropicRequest(body, attempt = 0) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status === 500 || r.status === 529) {
    if (attempt >= 3) throw new Error(`Anthropic API failed after retries: ${r.status}`);
    const retryAfter = parseFloat(r.headers.get('retry-after') || '0');
    const delay = retryAfter ? retryAfter * 1000 : [1000, 4000, 15000][attempt];
    console.log(`    API ${r.status}, retrying in ${Math.round(delay / 1000)}s...`);
    await new Promise(res => setTimeout(res, delay));
    return anthropicRequest(body, attempt + 1);
  }
  const json = await r.json();
  if (!r.ok) {
    const err = new Error(`Anthropic API ${r.status}: ${json.error?.message || 'unknown'}`);
    err.status = r.status;
    err.apiMessage = json.error?.message || '';
    throw err;
  }
  return json;
}

// Scores one batch of files [{id, name}]. Returns [{id, category, appeal, flaws}].
async function scoreBatch(batch, useBase64 = false) {
  const content = [];
  for (let i = 0; i < batch.length; i++) {
    content.push({ type: 'text', text: `Photo ${i + 1} of ${batch.length}` });
    if (useBase64) {
      const { media_type, data } = await fetchAsBase64(thumbUrl(batch[i].id));
      content.push({ type: 'image', source: { type: 'base64', media_type, data } });
    } else {
      content.push({ type: 'image', source: { type: 'url', url: thumbUrl(batch[i].id) } });
    }
  }
  content.push({ type: 'text', text: 'Classify and score every photo above. Return one entry per photo, n matching the labels.' });

  const body = {
    model: MODEL,
    max_tokens: 10000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    response = await anthropicRequest(body);
  } catch (e) {
    // URL-source image fetches can fail server-side (permissions, transient
    // lh3 errors). Retry the whole batch with inlined base64 thumbnails.
    if (!useBase64 && e.status === 400 && /image|url|fetch|download|timed out/i.test(e.apiMessage)) {
      console.log('    URL image fetch rejected, retrying batch with base64...');
      return scoreBatch(batch, true);
    }
    throw e;
  }

  if (response.stop_reason === 'refusal') throw new Error('Model refused the batch');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = JSON.parse(text);
  const byN = new Map(parsed.photos.map(p => [p.n, p]));
  return batch.map((f, i) => {
    const p = byN.get(i + 1);
    if (!p) throw new Error(`Model output missing photo ${i + 1} of ${batch.length}`);
    return { id: f.id, name: f.name, category: p.category, appeal: p.appeal, flaws: p.flaws };
  });
}

async function scoreFolder(files) {
  const scored = [];
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    console.log(`    scoring photos ${i + 1}-${i + batch.length} of ${files.length}...`);
    scored.push(...await scoreBatch(batch));
  }
  return scored;
}

// ── deterministic ordering ──────────────────────────────────────────
// Input: scored photos in original Drive order. Output: {order, junkStart, cover}.
const HERO_CATS = ['hero-exterior', 'pool', 'view'];
const TOUT_SLOTS = [['pool'], ['living'], ['bedroom'], ['hero-exterior', 'view'], ['kitchen']];
const BODY_ORDER = ['living', 'kitchen', 'bedroom', 'bathroom', 'pool', 'outdoor',
  'hero-exterior', 'view', 'amenity', 'detail'];

export function computeOrder(scored) {
  const items = scored.map((p, i) => ({
    ...p,
    driveIndex: i,
    score: p.appeal - (p.flaws.length >= 2 ? 1 : 0),
  }));

  const junk = items.filter(p => p.category === 'utility-junk' || p.appeal <= 1);
  const keepers = items.filter(p => !junk.includes(p));

  // Stable comparator: score desc, then category priority for hero picks,
  // then original Drive order — identical scores order identically across runs.
  const byScore = (a, b) => b.score - a.score || a.driveIndex - b.driveIndex;

  const used = new Set();
  const sequence = [];
  const take = (photo) => { if (photo && !used.has(photo.id)) { used.add(photo.id); sequence.push(photo); } };

  // Hero: best exterior/pool/view shot; fall back to best keeper overall.
  const heroCandidates = keepers.filter(p => HERO_CATS.includes(p.category)).sort((a, b) =>
    b.score - a.score ||
    HERO_CATS.indexOf(a.category) - HERO_CATS.indexOf(b.category) ||
    a.driveIndex - b.driveIndex);
  const hero = heroCandidates[0] || keepers.slice().sort(byScore)[0];
  take(hero);

  // First-impressions tout: the single best photo of each key category.
  for (const cats of TOUT_SLOTS) {
    const best = keepers.filter(p => !used.has(p.id) && cats.includes(p.category)).sort(byScore)[0];
    take(best);
  }

  // Room-by-room body.
  for (const cat of BODY_ORDER) {
    for (const p of keepers.filter(p => !used.has(p.id) && p.category === cat).sort(byScore)) take(p);
  }
  // Any keeper category not in BODY_ORDER (defensive).
  for (const p of keepers.filter(p => !used.has(p.id)).sort(byScore)) take(p);

  const junkStart = sequence.length;
  for (const p of junk.slice().sort(byScore)) take(p);

  return {
    order: sequence.map(p => p.id),
    junkStart,
    cover: hero ? hero.id : (sequence[0]?.id || ''),
    sequence, // full objects, for dry-run display
  };
}

// ── main ────────────────────────────────────────────────────────────
async function processFolder(folder, label) {
  console.log(`\n▶ ${label} (${folder})`);
  const files = await listDriveFiles(folder);
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

  const scored = await scoreFolder(files);
  const { order, junkStart, cover, sequence } = computeOrder(scored);

  console.log(`  computed order: ${junkStart} gallery photos, ${order.length - junkStart} in junk tail`);
  if (DRY_RUN) {
    sequence.forEach((p, i) => {
      const tag = i === 0 ? 'HERO' : (i >= junkStart ? 'JUNK' : String(i + 1).padStart(4));
      console.log(`  ${tag}  [${p.category}] appeal=${p.appeal}${p.flaws.length ? ' flaws=' + p.flaws.join(',') : ''}  ${p.name}`);
    });
    console.log('  (dry run — nothing written)');
    return 'dry-run';
  }

  const meta = {};
  for (const p of sequence) meta[p.id] = { c: p.category, s: p.appeal };
  await kvSet(`photo_order:${folder}`, {
    v: 1, model: MODEL, rankedAt: Date.now(),
    order, junkStart, cover, meta,
  });
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
