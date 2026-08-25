export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';

  const results = { properties: null, agents: null, shares: null };

  // Properties: count from listings API
  try {
    const r = await fetch(`https://${req.headers.host}/api/listings`);
    const { listings } = await r.json();
    if (listings) results.properties = listings.length;
  } catch {}

  // Agents: from CRM, exclude test agents and those without a WhatsApp number
  try {
    const r = await fetch(`${crmBase}/api/supabase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(process.env.LISTING_SYNC_SECRET ? { Authorization: `Bearer ${process.env.LISTING_SYNC_SECRET}` } : {}) },
      body: JSON.stringify({ action: 'get_agents' }),
    });
    const agents = await r.json();
    if (Array.isArray(agents)) {
      results.agents = agents.filter(a => !a.is_test && a.wa_num).length;
    }
  } catch {}

  // Founding-25 slots remaining — public scarcity counter for the owner pitch
  // (list-property page, sign-in sheets, and Maya's pitch all read this).
  if (kvUrl && kvToken) {
    try {
      const r = await fetch(`${kvUrl}/GET/promo_codes`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const data = await r.json();
      let promos = {};
      try { promos = JSON.parse(data.result) || {}; } catch {}
      const f = promos.FOUNDING25;
      // Not yet seeded (seeding is lazy, on first redemption) → all 25 open.
      const max = f?.maxRedemptions ?? 25;
      const used = f?.redemptions ?? 0;
      results.founding = { total: max, used, remaining: Math.max(0, max - used), active: f ? f.active !== false : true };
    } catch {}
  }

  // Shares this month: from Redis tracking
  if (kvUrl && kvToken) {
    try {
      const month = new Date().toISOString().slice(0, 7);
      const r = await fetch(`${kvUrl}/GET/month:${month}:share`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const data = await r.json();
      const val = parseInt(data.result) || 0;
      if (val > 0) results.shares = val;
    } catch {}
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json(results);
}
