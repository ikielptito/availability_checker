// POST /api/notify-agents — manual broadcast trigger from the analytics dashboard.
//
// Pulls today's availability digest, force-flips the snapshot so every
// currently-available property registers as "newly available" to the CRM
// diff, sets Maya's autoresponder mode, ensures the broadcast kill switch
// is on, and triggers the CRM cron immediately.
//
// Auth: same DASHBOARD_PASSWORD as the analytics dashboard.
// Body: { mode: 'autopilot' | 'silent' }
//   autopilot → automation.mode='autopilot', Maya engages with replies
//   silent    → automation.mode='off', Maya goes quiet for the broadcast aftermath

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  const pwd = process.env.DASHBOARD_PASSWORD || 'samba2024';
  if (auth !== `Bearer ${pwd}`) return res.status(401).json({ error: 'Unauthorized' });

  const { mode = 'autopilot' } = req.body || {};
  if (!['autopilot', 'silent'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "autopilot" or "silent"' });
  }

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';

  // ── Step 1: digest from KV cache (no self-call → no deadlock) ───
  // The daily Vercel cron pre-warms digest:cache at 08:50 WITA, plus
  // every /api/digest call refreshes it. So this is fresh within ~30
  // min of any normal portal/dashboard activity.
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  const kvRes = await fetch(`${kvUrl}/get/${encodeURIComponent('digest:cache')}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });
  const kvJson = await kvRes.json();
  let digest = null;
  try { digest = JSON.parse(kvJson.result); } catch {}
  if (!digest || !digest.properties) {
    return res.status(503).json({
      error: 'No digest available — visit /api/digest first to warm the cache',
    });
  }
  const propCount = digest.properties.length;

  // ── Step 2: build "all unavailable yesterday" snapshot ──────────
  // The CRM cron's diff logic only fires alerts when a property transitions
  // from unavailable → available. By writing a snapshot where every property
  // looks unavailable, we guarantee every currently-available property
  // counts as "newly available" and gets included in the broadcast.
  const flippedSnapshot = {};
  for (const p of digest.properties || []) {
    flippedSnapshot[p.id] = {
      availableToday: false,
      nextLongWindowFrom: null,
      monthly: p.monthly || null,
    };
  }

  // ── Step 3: stage CRM settings before the trigger ───────────────
  async function crmSet(key, value) {
    const r = await fetch(`${crmBase}/api/supabase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_settings', payload: { key, value } }),
    });
    return r.ok;
  }
  const settingsOk = await Promise.all([
    crmSet('samba_availability', { enabled: true, test_agents_only: false }),
    crmSet('samba_availability_snapshot', flippedSnapshot),
    crmSet('automation', { mode: mode === 'autopilot' ? 'autopilot' : 'off' }),
  ]);
  if (!settingsOk.every(Boolean)) {
    return res.status(502).json({ error: 'CRM settings update failed', settingsOk });
  }

  // ── Step 4: fire the CRM cron ───────────────────────────────────
  const cronRes = await fetch(`${crmBase}/api/cron-followups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const cronBody = await cronRes.json().catch(() => ({}));

  return res.status(200).json({
    ok: true,
    triggered_at: new Date().toISOString(),
    mode,
    properties_in_digest: propCount,
    snapshot_entries_written: Object.keys(flippedSnapshot).length,
    cron_response: cronBody.availability || cronBody,
  });
}
