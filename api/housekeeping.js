// Housekeeping — the portal side. A thin admin proxy, the same shape as
// api/staff.js: Ikiel or Era authenticate with the admin password, and this
// route forwards hk_* actions to the CRM using LISTING_SYNC_SECRET.
//
// Nothing owner-facing lives here. Owners see inspection findings through
// their weekly report, which is built by api/portal.js from the same records
// but carries no staff names or numbers.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminPasswords = [
    process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD,
    process.env.STATEMENTS_ADMIN_PASSWORD,      // Era's scoped credential
  ].filter(Boolean);
  if (!adminPasswords.length) return res.status(503).json({ error: 'Admin password not configured' });

  const auth = req.headers.authorization || '';
  if (!adminPasswords.some(p => auth === `Bearer ${p}`)) return res.status(401).json({ error: 'Unauthorized' });

  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });

  const { action, payload } = req.body || {};
  if (!/^hk_[a-z_]+$/.test(String(action || ''))) {
    return res.status(400).json({ error: `unsupported action: ${action}` });
  }

  try {
    const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
    const r = await fetch(`${crmBase}/api/housekeeping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload: payload || {} }),
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
