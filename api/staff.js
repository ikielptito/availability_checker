// Staff registry — the portal side. A thin admin proxy, the same shape as
// the POST half of api/maintenance.js: Ikiel or Era authenticate with the
// admin password, and this route forwards staff_* actions to the CRM using
// LISTING_SYNC_SECRET, which never reaches the browser.
//
// There is deliberately no owner-facing or public read here. Staff phone
// numbers are the whole point of the table and they must not appear in any
// unauthenticated payload. A Double 8 partner (Oli) gets staff_list alone,
// without the numbers, so the dispatch picker on his own tickets works.
//
// staff_list also returns the catalog units, because the CRM has no catalog
// of its own and the villa picker in /payouts needs the full unit list —
// including Tropicana B2/B3/B5/B6, which are cleaned but are not payout
// properties and so never appear in the statement groups.

import { UNITS } from '../lib/catalog.js';
import { cockpitCaller, adminPasswordsConfigured } from '../lib/cockpit-auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!adminPasswordsConfigured()) return res.status(503).json({ error: 'Admin password not configured' });
  // Ikiel's passwords, Era's password or link session — or a Double 8 partner.
  const caller = await cockpitCaller(req.headers.authorization);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });

  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });

  const { action, payload } = req.body || {};
  if (!/^staff_[a-z_]+$/.test(String(action || ''))) {
    return res.status(400).json({ error: `unsupported action: ${action}` });
  }
  const partner = caller.role === 'double8';
  if (partner && action !== 'staff_list') return res.status(403).json({ error: 'The team register is kept by Era and Ikiel.' });

  try {
    const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
    const r = await fetch(`${crmBase}/api/staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload: payload || {} }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    res.setHeader('Cache-Control', 'no-store');
    if (action === 'staff_list' && r.ok) {
      body.units = UNITS.map(u => ({ slug: u.slug, name: u.name }));
      // The partner picks a name to send a job to; the numbers stay here.
      if (partner) body.staff = (body.staff || []).map(({ wa_num, ...p }) => p);
    }
    return res.status(r.status).json(body);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
