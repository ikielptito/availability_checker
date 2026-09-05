// Staff payroll — the portal side. A thin admin proxy, the same shape as
// api/staff.js: the caller authenticates with a password and this route
// forwards payroll_* actions to the CRM using LISTING_SYNC_SECRET, which
// never reaches the browser.
//
// Two kinds of login (resolved by lib/cockpit-auth.js):
//   • Samba admin passwords (Ikiel; Era's scoped credential) or a manager's
//     WhatsApp magic-link session — every entity.
//   • DOUBLE8_ADMIN_PASSWORD (Oli) or a Double 8 partner's magic-link session
//     — pinned to the Double 8 entity: the CRM receives entity_scope='double8'
//     and refuses anything outside it.
// payroll_whoami answers locally so the page can shape itself before it
// makes any other call.
//
// No owner-facing or public read here: payroll is internal money and
// carries staff names and salaries.

import crypto from 'node:crypto';
import { cockpitCaller, kvGetJson, managerNumbers, digits, adminPasswordsConfigured } from '../lib/cockpit-auth.js';

// KV (Upstash REST pipeline), the same call shape the rest of the portal uses.
async function kvCmd(...cmd) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify([cmd]) });
  const out = await r.json().catch(() => null);
  return Array.isArray(out) ? out[0]?.result : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!adminPasswordsConfigured()) return res.status(503).json({ error: 'Admin password not configured' });

  const { action, payload } = req.body || {};
  if (!/^payroll_[a-z_]+$/.test(String(action || ''))) {
    return res.status(400).json({ error: `unsupported action: ${action}` });
  }
  const sync = process.env.LISTING_SYNC_SECRET;
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const crm = async (path, action, payload) => {
    const r = await fetch(`${crmBase}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` }, body: JSON.stringify({ action, payload: payload || {} }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ── WhatsApp magic link (no password to pass around) ─────────────
  // The same "Open my portal" template the owners use. Two kinds of number
  // may ask for one: a manager (Era; MANAGER_WA_NUMS), who lands in the full
  // cockpit as role 'era', and a number registered on an expenses-only
  // (co-owned) group, who lands in the Double 8 payroll. The tap opens
  // /portal?wa_login=d8-<token>, which the portal forwards to
  // /payouts?d8=<token>; verify exchanges it for a 30-day session token
  // (`d8s:…`) that every cockpit proxy accepts, carrying the role.
  if (action === 'payroll_link_start') {
    if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
    const phone = digits(payload?.phone);
    if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Enter your full WhatsApp number with country code, e.g. +62 878…' });
    const sends = Number(await kvCmd('INCR', `d8login:rl:${phone}`)) || 1;
    if (sends === 1) await kvCmd('EXPIRE', `d8login:rl:${phone}`, 3600);
    if (sends > 5) return res.status(429).json({ error: 'Too many links requested — try again in an hour.' });
    let role = managerNumbers().has(phone) ? 'era' : null;
    if (!role) {
      const groupsRes = await crm('statements', 'statement_groups', {});
      const partner = (groupsRes.body?.groups || []).some(g => g.active !== false && g.expenses_only === true && (g.owner_wa_nums || []).some(n => digits(n) === phone));
      if (partner) role = 'double8';
    }
    if (!role) return res.status(403).json({ error: 'This number is not set up for a management login. Ask Ikiel to add it.' });
    const tok = crypto.randomBytes(16).toString('hex');
    await kvCmd('SET', `d8login:${tok}`, JSON.stringify({ phone, role, exp: Date.now() + 10 * 60 * 1000 }), 'EX', 600);
    // A manager's number is not registered on any property, so the CRM's
    // "registered numbers only" guard is lifted for that one known number.
    const sendRes = await crm('statements', 'statement_wa_login_code', { wa_num: phone, token: `d8-${tok}`, ...(role === 'era' ? { allow_unregistered: true } : {}) });
    if (sendRes.status !== 200) return res.status(502).json({ error: sendRes.body?.error || 'Could not send the link — try again.' });
    return res.status(200).json({ ok: true });
  }
  if (action === 'payroll_link_verify') {
    const tok = String(payload?.token || '').replace(/[^a-f0-9]/gi, '');
    const rec = tok.length >= 16 ? await kvGetJson(`d8login:${tok}`) : null;
    if (!rec || !rec.phone || (rec.exp && rec.exp < Date.now())) return res.status(403).json({ error: 'This link has expired or was already used. Request a new one.' });
    await kvCmd('DEL', `d8login:${tok}`);
    const role = rec.role === 'era' ? 'era' : 'double8';
    const session = crypto.randomBytes(24).toString('hex');
    await kvCmd('SET', `d8s:${session}`, JSON.stringify({ phone: rec.phone, role, at: Date.now() }), 'EX', 30 * 86400);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, session: `d8s:${session}`, role, name: role === 'era' ? 'Era' : 'Oli' });
  }

  const caller = await cockpitCaller(req.headers.authorization);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });
  const scope = caller.role === 'double8' ? 'double8' : null;
  if (action === 'payroll_whoami') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ scope, role: caller.role, name: caller.name });
  }

  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });

  try {
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
