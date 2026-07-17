// Shared AI photo-ranking logic. Two consumers:
//   - dev/photo-rank.mjs   — bulk CLI (all folders in one long-running process)
//   - api/listings.js (?rank=1) and api/portal.js (?action=rank) — the
//     "Sort photos with AI" button. Serverless functions can't run a whole
//     folder in one invocation, so rankStep() does ONE unit of work per call
//     (score a batch, or dedup one group) and keeps progress in KV; the
//     browser calls it repeatedly until done.
//
// Pipeline per folder:
//   1. Score every photo (category + appeal + flaws), 20 at a time.
//   2. Dedup pass: within each category, find near-identical / overly-similar
//      shots and keep only the best 1–2 of each cluster. The surplus go on an
//      `excluded` list — they are HIDDEN from the gallery, never deleted from
//      Drive, and fully reversible (admin can restore).
//   3. Compute the Airbnb-style order over what's left.
//
// Result key:   photo_order:<driveFolderId>   (applied by api/media.js)
// Progress key: photo_rank_job:<driveFolderId> (deleted when the order lands)

export const DEFAULT_MODEL = 'claude-sonnet-5';
export const BATCH_SIZE = 20;
const DEDUP_GROUP_MAX = 40; // photos per dedup request (attention + image cap)

const CATEGORIES = ['hero-exterior', 'pool', 'living', 'bedroom', 'bathroom', 'kitchen',
  'view', 'outdoor', 'amenity', 'detail', 'utility-junk'];
const FLAWS = ['dark', 'blurry', 'cluttered', 'distorted', 'duplicate-angle',
  'people-visible', 'construction', 'empty-room'];

const SCORE_SCHEMA = {
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

const DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['remove'],
  properties: {
    // Photo numbers (labels) of the surplus near-duplicates to hide.
    remove: { type: 'array', items: { type: 'integer' } },
  },
};

const SCORE_SYSTEM = `You are ranking photos for a Bali villa/apartment rental listing gallery. For each numbered photo, classify it into exactly one category and give an appeal score from 0 to 10 (10 = magazine-quality, makes someone want to book immediately; 0 = should never be shown to a prospective guest). "utility-junk" means: staircases, corridors, fire extinguishers, electrical panels or meters, water heaters, storage/closet interiors, parking areas, signage, construction details, or anything a guest would find confusing or off-putting early in a gallery. Score appeal on lighting, composition, and how inviting the space looks. Flag flaws honestly. Return one entry per photo with n matching the photo's label.`;

const DEDUP_SYSTEM = `You are trimming redundant photos from a Bali villa rental listing gallery. Every photo below shows the same category of space in one property. Find clusters of near-identical or overly-similar shots — photos of the same subject that differ only in angle, framing, exposure, or a small camera shift, plus any exact duplicates. For each such cluster, keep the best 1 or 2 (prefer higher appeal score and cleaner composition) and mark the REST for removal. Photos that show a meaningfully different subject, room, or vantage point must NOT be removed — only trim genuine redundancy. A photo with no near-duplicate is always kept. Return the label numbers of the photos to remove (an empty list if nothing is redundant).`;

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

// ── Claude vision plumbing ──────────────────────────────────────────
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

// Builds the interleaved [label, image, label, image, ...] content array.
// `labels[i]` is the text shown before photo i's thumbnail.
async function buildImageContent(items, labels, thumbW, useBase64) {
  const content = [];
  for (let i = 0; i < items.length; i++) {
    content.push({ type: 'text', text: labels[i] });
    if (useBase64) {
      const { media_type, data } = await fetchAsBase64(thumbUrl(items[i].id, thumbW));
      content.push({ type: 'image', source: { type: 'base64', media_type, data } });
    } else {
      content.push({ type: 'image', source: { type: 'url', url: thumbUrl(items[i].id, thumbW) } });
    }
  }
  return content;
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

function parseTextJson(response) {
  if (response.stop_reason === 'refusal') throw new Error('Model refused the request');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

// Runs a vision request, retrying the whole thing with inlined base64 thumbs if
// the server-side URL image fetch fails (permissions, transient lh3 timeouts).
async function visionCall({ items, labels, system, schema, opts }, useBase64 = false) {
  const { apiKey, model = DEFAULT_MODEL, thumbW = 400, maxRetries = 3 } = opts;
  const content = await buildImageContent(items, labels, thumbW, useBase64);
  content.push({ type: 'text', text: 'Follow the instructions above. Reference photos by their label numbers.' });
  const body = {
    model, max_tokens: 10000, system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
  try {
    return parseTextJson(await anthropicRequest(body, apiKey, maxRetries));
  } catch (e) {
    if (!useBase64 && e.status === 400 && /image|url|fetch|download|timed out/i.test(e.apiMessage)) {
      return visionCall({ items, labels, system, schema, opts }, true);
    }
    throw e;
  }
}

// ── scoring ─────────────────────────────────────────────────────────
// Scores one batch of files [{id, name}] → [{id, name, category, appeal, flaws}].
export async function scoreBatch(batch, opts) {
  const labels = batch.map((_, i) => `Photo ${i + 1} of ${batch.length}`);
  const parsed = await visionCall({ items: batch, labels, system: SCORE_SYSTEM, schema: SCORE_SCHEMA, opts });
  const byN = new Map(parsed.photos.map(p => [p.n, p]));
  return batch.map((f, i) => {
    const p = byN.get(i + 1);
    if (!p) throw new Error(`Model output missing photo ${i + 1} of ${batch.length}`);
    return { id: f.id, name: f.name, category: p.category, appeal: p.appeal, flaws: p.flaws };
  });
}

// ── dedup ───────────────────────────────────────────────────────────
// A dedup group is one chunk of same-category photos to compare together.
// Near-duplicates almost always share a category and sit near each other in
// Drive (burst shots), so grouping by category + Drive order keeps clusters
// intact even when a large category is chunked. utility-junk is skipped — it
// is deprioritised to the tail already and not worth the extra API calls.
export function buildDedupQueue(scored) {
  const byCat = new Map();
  scored.forEach((p, driveIndex) => {
    if (p.category === 'utility-junk') return;
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category).push({ ...p, driveIndex });
  });
  const groups = [];
  for (const [category, photos] of byCat) {
    if (photos.length < 2) continue; // nothing to compare
    photos.sort((a, b) => a.driveIndex - b.driveIndex);
    for (let i = 0; i < photos.length; i += DEDUP_GROUP_MAX) {
      const chunk = photos.slice(i, i + DEDUP_GROUP_MAX);
      if (chunk.length >= 2) groups.push({ category, photos: chunk });
    }
  }
  return groups;
}

// Compares one group of same-category photos, returns the ids to hide.
export async function dedupGroup(photos, opts) {
  const labels = photos.map((p, i) => `Photo ${i + 1} (appeal ${p.appeal})`);
  const parsed = await visionCall({ items: photos, labels, system: DEDUP_SYSTEM, schema: DEDUP_SCHEMA, opts });
  const remove = new Set((parsed.remove || []).filter(n => n >= 1 && n <= photos.length));
  // Never let the model empty out a cluster entirely — keep at least one photo
  // per group as a safety floor against an over-eager response.
  if (remove.size >= photos.length) return [];
  return photos.filter((_, i) => remove.has(i + 1)).map(p => p.id);
}

// ── deterministic ordering ──────────────────────────────────────────
// Airbnb-style: hero → best-of-each-room tout → room-by-room → junk tail.
// Excluded (hidden) photos are dropped entirely — they never enter the order.
const HERO_CATS = ['hero-exterior', 'pool', 'view'];
const TOUT_SLOTS = [['pool'], ['living'], ['bedroom'], ['hero-exterior', 'view'], ['kitchen']];
const BODY_ORDER = ['living', 'kitchen', 'bedroom', 'bathroom', 'pool', 'outdoor',
  'hero-exterior', 'view', 'amenity', 'detail'];

export function computeOrder(scored, excludedSet = new Set()) {
  const items = scored
    .map((p, i) => ({ ...p, driveIndex: i, score: p.appeal - (p.flaws.length >= 2 ? 1 : 0) }))
    .filter(p => !excludedSet.has(p.id));

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

// `allScored` (every scored photo) is used for meta so hidden photos carry
// their category/appeal too — the admin review UI and auditing need it. Falls
// back to the visible sequence when the full set isn't passed.
export function buildOrderRecord({ order, junkStart, cover, sequence }, model, excluded = [], allScored = null) {
  const meta = {};
  for (const p of (allScored || sequence)) meta[p.id] = { c: p.category, s: p.appeal };
  return { v: 2, model, rankedAt: Date.now(), order, junkStart, cover, excluded, meta };
}

// ── serverless step runner ──────────────────────────────────────────
// One call = at most one Anthropic request (one score batch OR one dedup
// group). Returns one of:
//   { status: 'up_to_date', total }
//   { status: 'scoring',  scored, total }               — keep calling
//   { status: 'deduping', deduped, groups, removed }    — keep calling
//   { status: 'done', total, junk, removed }            — order written
//   { status: 'empty', total: 0 }
// opts: { kvGet, kvSet, kvDel, googleApiKey, anthropicApiKey, force }
export async function rankStep(folder, opts) {
  const { kvGet, kvSet, kvDel, googleApiKey, anthropicApiKey, force } = opts;
  const callOpts = { apiKey: anthropicApiKey, model: DEFAULT_MODEL, maxRetries: 1 };
  const files = await listDriveFiles(folder, googleApiKey);
  if (!files.length) return { status: 'empty', total: 0 };
  const currentIds = new Set(files.map(f => f.id));
  const sameSet = (arr) => arr && arr.length === currentIds.size && arr.every(id => currentIds.has(id));

  const jobKey = `photo_rank_job:${folder}`;
  let job = await kvGet(jobKey);

  // Fresh start: no live job → is the stored order already for this exact set?
  // (v2 records only — a v1 order predates dedup, so re-rank to add it.)
  if (!job || !sameSet(job.files?.map(f => f.id))) {
    if (!force && !job) {
      const existing = await kvGet(`photo_order:${folder}`);
      const covered = existing && sameSet([...(existing.order || []), ...(existing.excluded || [])]);
      if (covered && existing.v >= 2) return { status: 'up_to_date', total: files.length };
    }
    job = { files, scored: [], dedupQueue: null, dedupDone: 0, excluded: [], startedAt: Date.now() };
    await kvSet(jobKey, job);
  }

  // Phase 1 — score in batches of 20.
  if (job.scored.length < job.files.length) {
    const batch = job.files.slice(job.scored.length, job.scored.length + BATCH_SIZE);
    job.scored.push(...await scoreBatch(batch, callOpts));
    if (job.scored.length < job.files.length) {
      await kvSet(jobKey, job);
      return { status: 'scoring', scored: job.scored.length, total: job.files.length };
    }
  }

  // Build the dedup queue once, right after scoring completes.
  if (job.dedupQueue === null) {
    job.dedupQueue = buildDedupQueue(job.scored);
    job.dedupDone = 0;
    job.excluded = [];
    await kvSet(jobKey, job);
  }

  // Phase 2 — one dedup group per call.
  if (job.dedupDone < job.dedupQueue.length) {
    const group = job.dedupQueue[job.dedupDone];
    job.excluded.push(...await dedupGroup(group.photos, callOpts));
    job.dedupDone++;
    if (job.dedupDone < job.dedupQueue.length) {
      await kvSet(jobKey, job);
      return { status: 'deduping', deduped: job.dedupDone, groups: job.dedupQueue.length, removed: job.excluded.length };
    }
  }

  // Finalize.
  const excluded = job.excluded || [];
  const result = computeOrder(job.scored, new Set(excluded));
  await kvSet(`photo_order:${folder}`, buildOrderRecord(result, DEFAULT_MODEL, excluded, job.scored));
  await kvDel(`autocover:${folder}`);
  await kvDel(jobKey);
  return {
    status: 'done',
    total: result.order.length,
    junk: result.order.length - result.junkStart,
    removed: excluded.length,
  };
}
