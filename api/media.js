// Consolidated read-only upstream proxy. Replaces three former functions
// (gdrive.js, properties.js, photos.js) to stay under Vercel Hobby's
// 12-function cap. Routed by ?source=:
//   ?source=drive&folder=<id>        → Google Drive folder photos
//   ?source=hostex-properties        → Hostex property list
//   ?source=hostex-photos&id=<id>    → Hostex per-property photos
//
// Old URLs (/api/gdrive, /api/properties, /api/photos) are preserved via
// rewrites in vercel.json, so existing frontend callers need no changes.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const source = req.query.source;
  if (source === 'drive') return driveFolder(req, res);
  if (source === 'hostex-properties') return hostexProperties(req, res);
  if (source === 'hostex-photos') return hostexPhotos(req, res);
  return res.status(400).json({ error: 'Unknown or missing source' });
}

// ── Google Drive folder photos (was gdrive.js) ──────────────────────

// AI-curated presentation order written by dev/photo-rank.mjs. Fail-open:
// any KV problem just means the gallery falls back to raw Drive order.
async function getPhotoOrder(folder) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;
  try {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(`photo_order:${folder}`)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const json = await r.json();
    if (!json.result) return null;
    const parsed = JSON.parse(json.result);
    return Array.isArray(parsed?.order) ? parsed : null;
  } catch { return null; }
}

// Curated files first (by stored position), then files Drive has that the
// order hasn't seen yet (new uploads), then the utility/junk tail. Photos on
// the `excluded` list (AI-flagged duplicates / overly-similar shots) are
// dropped entirely — unless includeHidden is set (the admin grid, which shows
// them dimmed with a restore control). Files deleted from Drive drop out too.
function applyPhotoOrder(files, photoOrder, includeHidden) {
  const pos = new Map(photoOrder.order.map((id, i) => [id, i]));
  const excluded = new Set(photoOrder.excluded || []);
  const junkStart = Number.isInteger(photoOrder.junkStart) ? photoOrder.junkStart : photoOrder.order.length;
  const curated = [], fresh = [], junk = [], hidden = [];
  for (const f of files) {
    if (excluded.has(f.id)) { if (includeHidden) hidden.push({ ...f, hidden: true }); continue; }
    if (!pos.has(f.id)) fresh.push(f);
    else if (pos.get(f.id) < junkStart) curated.push(f);
    else junk.push(f);
  }
  const byPos = (a, b) => pos.get(a.id) - pos.get(b.id);
  // Hidden photos go last so the visible gallery order is unaffected.
  return [...curated.sort(byPos), ...fresh, ...junk.sort(byPos), ...hidden];
}

async function driveFolder(req, res) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  const { folder } = req.query;
  if (!folder) return res.status(400).json({ error: 'Missing folder id' });

  try {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folder}'+in+parents+and+mimeType+contains+'image/'&fields=files(id,name,mimeType)&key=${apiKey}&pageSize=150`;
    const includeHidden = req.query.includeHidden === '1';
    const [r, photoOrder] = await Promise.all([fetch(url), getPhotoOrder(folder)]);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    let files = data.files || [];
    if (photoOrder) files = applyPhotoOrder(files, photoOrder, includeHidden);
    const photos = files.map(f => ({
      id: f.id,
      url: `https://lh3.googleusercontent.com/d/${f.id}`,
      thumb: `https://lh3.googleusercontent.com/d/${f.id}=w400`,
      ...(f.hidden ? { hidden: true } : {})
    }));
    // The admin review view (includeHidden) must reflect restores immediately,
    // so it isn't CDN-cached; the public gallery keeps the long cache.
    res.setHeader('Cache-Control', includeHidden
      ? 'no-store'
      : 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ photos });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

// ── Hostex property list (was properties.js) ────────────────────────
async function hostexProperties(req, res) {
  const token = process.env.HOSTEX_TOKEN;
  if (!token) return res.status(500).json({ error: 'HOSTEX_TOKEN not configured' });

  try {
    const upstream = await fetch('https://api.hostex.io/v3/properties', {
      headers: { 'Hostex-Access-Token': token }
    });
    const data = await upstream.json();
    // Normalise: Hostex returns { data: { properties: [...] } }
    // Remap to { data: { items: [...] } } so the frontend can use one path
    if (data?.data?.properties) {
      data.data.items = data.data.properties;
    }
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}

// ── Hostex per-property photos (was photos.js) ──────────────────────
async function hostexPhotos(req, res) {
  const token = process.env.HOSTEX_TOKEN;
  if (!token) return res.status(500).json({ error: 'HOSTEX_TOKEN not configured' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing property id' });

  try {
    const upstream = await fetch(`https://api.hostex.io/v3/properties/${id}`, {
      headers: { 'Hostex-Access-Token': token }
    });
    const data = await upstream.json();
    const property = data.data?.property || data.data || {};
    const photos = property.photos || property.images || [];
    // Always include cover as first photo
    const cover = property.cover?.original_url || property.cover?.large_url || null;
    const allPhotos = cover
      ? [cover, ...photos.map(p => p.original_url || p.large_url || p.url).filter(Boolean)]
      : photos.map(p => p.original_url || p.large_url || p.url).filter(Boolean);
    return res.status(200).json({ photos: [...new Set(allPhotos)] });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
