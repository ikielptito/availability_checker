// Staff payroll — the portal side. A thin admin proxy, the same shape as
// api/staff.js: the caller authenticates with a password and this route
// forwards payroll_* actions to the CRM using LISTING_SYNC_SECRET, which
// never reaches the browser.
//
// Two kinds of login:
//   • Samba admin passwords (Ikiel; Era's scoped credential) — every entity.
//   • DOUBLE8_ADMIN_PASSWORD (Oli) — pinned to the Double 8 entity: the CRM
//     receives entity_scope='double8' and refuses anything outside it.
// payroll_whoami answers locally so the page can shape itself before it
// makes any other call.
//
// No owner-facing or public read here: payroll is internal money and
// carries staff names and salaries.

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
  const double8Password = process.env.DOUBLE8_ADMIN_PASSWORD || '';
  if (!adminPasswords.length) return res.status(503).json({ error: 'Admin password not configured' });

  const auth = req.headers.authorization || '';
  const isAdmin = adminPasswords.some(p => auth === `Bearer ${p}`);
  const isDouble8 = !!double8Password && auth === `Bearer ${double8Password}`;
  if (!isAdmin && !isDouble8) return res.status(401).json({ error: 'Unauthorized' });
  const scope = isAdmin ? null : 'double8';

  const { action, payload } = req.body || {};
  if (!/^payroll_[a-z_]+$/.test(String(action || ''))) {
    return res.status(400).json({ error: `unsupported action: ${action}` });
  }
  if (action === 'payroll_whoami') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ scope, name: scope === 'double8' ? 'Oli' : 'admin' });
  }

  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });

  try {
    const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
    const r = await fetch(`${crmBase}/api/payroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload: { ...(payload || {}), ...(scope ? { entity_scope: scope, entity: scope } : {}) } }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(body);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
