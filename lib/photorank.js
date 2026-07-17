// Shared AI photo-ranking logic. Two consumers:
//   - dev/photo-rank.mjs   — bulk CLI (all folders in one long-running process)
//   - api/listings.js (?rank=1) and api/portal.js (?action=rank) — the
//     "Sort photos with AI" button. Serverless functions can't run a whole
//     folder in one invocation, so rankStep() scores ONE batch per call and
//     keeps progress in KV; the browser calls it repeatedly until done.
//
// Result key: photo_order:<driveFolderId> — applied by api/media.js.
// Progress key: photo_rank_job:<driveFolderId> — deleted when the order lands.

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const BATCH_SIZE = 20;

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

// ── Drive ───────────────────────────────────────────────────────────
export async function listDriveFiles(folder, googleApiKey) {
  const files = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folder}'+in+parents+and+mimeType+contains+'image/'` +
      `&fields=nextPageToken,files(id,name)&pageSize=1000&key=${googleApiKey}` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await (await fetch(url)).json();
    if (data.error) throw new Error(`Drive list failed for ${folder}: ${data.error.message}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// ── Claude vision scoring ───────────────────────────────────────────
function thumbUrl(fileId, w) {
  return `https://lh3.googleusercontent.com/d/${fileId}=w${w}`;
}

async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`thumb fetch failed ${r.status}: ${url}`);
  const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  const buf = Buffer.from(await r.arrayBuffer());
  return { media_type: ct, data: buf.toString('base64') };
}

async function anthropicRequest(body, apiKey, maxRetries, attempt = 0) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 429 || r.status === 500 || r.status === 529) {
    if (attempt >= maxRetries) throw new Error(`Anthropic API failed after retries: ${r.status}`);
    const retryAfter = parseFloat(r.headers.get('retry-after') || '0');
    const delay = retryAfter ? retryAfter * 1000 : [1000, 4000, 15000][attempt] || 15000;
    await new Promise(res => setTimeout(res, delay));
    return anthropicRequest(body, apiKey, maxRetries, attempt + 1);
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

// Scores one batch of files [{id, name}] → [{id, name, category, appeal, flaws}].
// opts: { apiKey, model, thumbW, maxRetries } — serverless callers pass
// maxRetries: 1 so a retry storm can't blow the invocation time limit.
export async function scoreBatch(batch, opts, useBase64 = false) {
  const { apiKey, model = DEFAULT_MODEL, thumbW = 400, maxRetries = 3 } = opts;
  const content = [];
  for (let i = 0; i < batch.length; i++) {
    content.push({ type: 'text', text: `Photo ${i + 1} of ${batch.length}` });
    if (useBase64) {
      const { media_type, data } = await fetchAsBase64(thumbUrl(batch[i].id, thumbW));
      content.push({ type: 'image', source: { type: 'base64', media_type, data } });
    } else {
      content.push({ type: 'image', source: { type: 'url', url: thumbUrl(batch[i].id, thumbW) } });
    }
  }
  content.push({ type: 'text', text: 'Classify and score every photo above. Return one entry per photo, n matching the labels.' });

  const body = {
    model,
    max_tokens: 10000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content }],
  };

  let response;
  try {
    response = await anthropicRequest(body, apiKey, maxRetries);
  } catch (e) {
    // URL-source image fetches can fail server-side (permissions, transient
    // lh3 errors/timeouts). Retry the whole batch with inlined base64 thumbs.
    if (!useBase64 && e.status === 400 && /image|url|fetch|download|timed out/i.test(e.apiMessage)) {
      return scoreBatch(batch, opts, true);
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

// ── deterministic ordering ──────────────────────────────────────────
// Airbnb-style: hero → best-of-each-room tout → room-by-room → junk tail.
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

  const byScore = (a, b) => b.score - a.score || a.driveIndex - b.driveIndex;

  const used = new Set();
  const sequence = [];
  const take = (photo) => { if (photo && !used.has(photo.id)) { used.add(photo.id); sequence.push(photo); } };

  const heroCandidates = keepers.filter(p => HERO_CATS.includes(p.category)).sort((a, b) =>
    b.score - a.score ||
    HERO_CATS.indexOf(a.category) - HERO_CATS.indexOf(b.category) ||
    a.driveIndex - b.driveIndex);
  const hero = heroCandidates[0] || keepers.slice().sort(byScore)[0];
  take(hero);

  for (const cats of TOUT_SLOTS) {
    const best = keepers.filter(p => !used.has(p.id) && cats.includes(p.category)).sort(byScore)[0];
    take(best);
  }

  for (const cat of BODY_ORDER) {
    for (const p of keepers.filter(p => !used.has(p.id) && p.category === cat).sort(byScore)) take(p);
  }
  for (const p of keepers.filter(p => !used.has(p.id)).sort(byScore)) take(p);

  const junkStart = sequence.length;
  for (const p of junk.slice().sort(byScore)) take(p);

  return {
    order: sequence.map(p => p.id),
    junkStart,
    cover: hero ? hero.id : (sequence[0]?.id || ''),
    sequence,
  };
}

export function buildOrderRecord({ order, junkStart, cover, sequence }, model) {
  const meta = {};
  for (const p of sequence) meta[p.id] = { c: p.category, s: p.appeal };
  return { v: 1, model, rankedAt: Date.now(), order, junkStart, cover, meta };
}

// ── serverless step runner ──────────────────────────────────────────
// One call = at most one Anthropic batch. Returns:
//   { status: 'up_to_date', total }                — order already covers Drive
//   { status: 'scoring', scored, total }           — call again to continue
//   { status: 'done', total, junk }                — order written
// opts: { kvGet, kvSet, kvDel, googleApiKey, anthropicApiKey, force }
export async function rankStep(folder, opts) {
  const { kvGet, kvSet, kvDel, googleApiKey, anthropicApiKey, force } = opts;
  const files = await listDriveFiles(folder, googleApiKey);
  if (!files.length) return { status: 'empty', total: 0 };
  const currentIds = new Set(files.map(f => f.id));
  const sameSet = (arr) => arr && arr.length === currentIds.size && arr.every(id => currentIds.has(id));

  const jobKey = `photo_rank_job:${folder}`;
  let job = await kvGet(jobKey);

  // Fresh start: no live job → check whether the stored order already covers
  // the exact current photo set.
  if (!job || !sameSet(job.files?.map(f => f.id))) {
    if (!force && !job) {
      const existing = await kvGet(`photo_order:${folder}`);
      if (existing && sameSet(existing.order)) return { status: 'up_to_date', total: files.length };
    }
    job = { files, scored: [], startedAt: Date.now() };
    await kvSet(jobKey, job);
  }

  if (job.scored.length < job.files.length) {
    const batch = job.files.slice(job.scored.length, job.scored.length + BATCH_SIZE);
    const scored = await scoreBatch(batch, {
      apiKey: anthropicApiKey, model: DEFAULT_MODEL, maxRetries: 1,
    });
    job.scored.push(...scored);
    if (job.scored.length < job.files.length) {
      await kvSet(jobKey, job);
      return { status: 'scoring', scored: job.scored.length, total: job.files.length };
    }
  }

  const result = computeOrder(job.scored);
  await kvSet(`photo_order:${folder}`, buildOrderRecord(result, DEFAULT_MODEL));
  await kvDel(`autocover:${folder}`);
  await kvDel(jobKey);
  return { status: 'done', total: result.order.length, junk: result.order.length - result.junkStart };
}
