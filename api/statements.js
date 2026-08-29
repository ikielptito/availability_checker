// Owner statements — the portal side. Three auth realms in one function:
//
//   POST { action, payload }            admin proxy (Authorization: Bearer
//     <admin password>) — forwards statement_* actions verbatim to the CRM's
//     /api/statements with LISTING_SYNC_SECRET (server-side only; the secret
//     never reaches the browser). Same stance as api/campaigns.js: no
//     password configured → 503, never open.
//
//   GET ?action=statements              owner session (samba_session cookie)
//     — the signed-in owner's published/paid statements, scoped to the
//     catalog units whose listing override carries their ownerSub.
//
//   GET ?action=public-statement&token= no login — the /st/<token> page's
//     data. The signed period-scoped token IS the auth (lib/tokens.js).
//
//   GET ?action=month-stats&slugs=&period=   service auth (sync secret) —
//     Hostex month aggregates the CRM snapshots into a statement at publish.

import crypto from 'node:crypto';
import { verifyStatementToken, statementToken, inviteToken, verifyInviteToken, previewToken, verifyPreviewToken } from '../lib/tokens.js';
import { buildMonthStats, buildRangeStats, applyStatementNights } from '../lib/month-stats.js';
import { buildStatementWorkbook, buildGroupWorkbook } from '../lib/statement-export.js';
import { UNITS_BY_SLUG } from '../lib/catalog.js';
import { loadHostexOwnerMap } from '../lib/owner-listings.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SESSION_COOKIE = 'samba_session';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const sync = process.env.LISTING_SYNC_SECRET;
  const crm = async (action, payload) => {
    const r = await fetch(`${crmBase}/api/statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    return { status: r.status, body };
  };

  // KV via the Upstash REST pipeline — the same call shape the rest of the
  // codebase uses (and the only one dev/devserver.mjs's mock intercepts).
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  const kvGet = async (key) => {
    if (!kvUrl || !kvToken) return null;
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', key]]),
    });
    const out = await r.json().catch(() => null);
    const raw = Array.isArray(out) ? out[0]?.result : null;
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  const kvSet = async (key, value) => {
    if (!kvUrl || !kvToken) return false;
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value)]]),
    });
    const out = await r.json().catch(() => null);
    return Array.isArray(out) && out[0]?.result === 'OK';
  };

  // Raw pipeline command — for the WhatsApp-login OTP records (SET…EX, INCR,
  // EXPIRE, DEL), which need TTLs kvSet can't express.
  const kvCmd = async (...cmd) => {
    if (!kvUrl || !kvToken) return null;
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([cmd]),
    });
    const out = await r.json().catch(() => null);
    return Array.isArray(out) ? out[0]?.result : null;
  };

  // ── POST ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};

    // Owner-onboarding invite: the signed link Ikiel sends on WhatsApp. The
    // owner opens it, signs in with ANY Google account, and this claims the
    // group's catalog listings to that account — one-shot: refused when a
    // different account already holds any of the units.
    if (action === 'claim_invite') {
      const owner = await sessionOwner(req, kvGet);
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const groupKey = verifyInviteToken(payload?.token || '');
      if (!groupKey) return res.status(403).json({ error: 'Invalid invite link' });
      const out = await claimGroupListings(owner, groupKey, { kvGet, kvSet, crm });
      return res.status(out.status).json(out.body);
    }

    // ── WhatsApp sign-in (owners without a Google account) ──────────
    // Same session/cookie machinery as Google sign-in, but identity is the
    // WhatsApp number Ikiel registered on the owner's property group: the
    // synthetic sub `wa:<digits>` flows through every existing ownership
    // check unchanged. Magic link, not OTP — the owner enters their number,
    // WhatsApp delivers a one-time "Open my portal" button (10-min TTL), and
    // tapping it lands them signed in. The link goes out via the CRM's WABA
    // and only to numbers already registered on an active group — this
    // cannot message strangers.
    if (action === 'wa_login_start') {
      const phone = String(payload?.phone || '').replace(/\D/g, '').replace(/^0+/, '');
      if (phone.length < 8 || phone.length > 15) {
        return res.status(400).json({ error: 'Enter your full WhatsApp number with country code, e.g. +62 812… or +1 786…' });
      }
      const sends = Number(await kvCmd('INCR', `waotp:rl:${phone}`)) || 1;
      if (sends === 1) await kvCmd('EXPIRE', `waotp:rl:${phone}`, 3600);
      if (sends > 5) return res.status(429).json({ error: 'Too many sign-in links requested — try again in an hour.' });
      const tok = crypto.randomBytes(16).toString('hex');
      // A pending invite rides along with the one-time token: the magic link
      // opens in a fresh tab where sessionStorage is empty, so the claim must
      // happen server-side at verify time.
      const inviteGroup = verifyInviteToken(payload?.invite || '') || null;
      const sendRes = await crm('statement_wa_login_code', { wa_num: phone, token: tok });
      if (sendRes.status === 403) {
        // A dead end otherwise: the owner has a perfectly good invite and no
        // way through. Point them at Google, which always works.
        return res.status(403).json({ error: 'We don’t have this number on file for your villa yet. Use “Continue with Google” instead, or message Ikiel and he’ll add it.' });
      }
      if (sendRes.status !== 200) return res.status(502).json({ error: sendRes.body?.error || 'Could not send the link — try again.' });
      await kvCmd('SET', `walogin:${tok}`, JSON.stringify({ phone, invite: inviteGroup, exp: Date.now() + 10 * 60 * 1000 }), 'EX', 600);
      return res.status(200).json({ ok: true });
    }

    if (action === 'wa_login_verify') {
      const tok = String(payload?.token || '').replace(/[^a-f0-9]/gi, '');
      const rec = tok.length >= 16 ? await kvGet(`walogin:${tok}`) : null;
      if (!rec || !rec.phone || (rec.exp && rec.exp < Date.now())) {
        return res.status(400).json({ error: 'This sign-in link has expired — request a fresh one from the sign-in page.' });
      }
      await kvCmd('DEL', `walogin:${tok}`);
      const phone = String(rec.phone).replace(/\D/g, '');

      // Upsert the owner record under the synthetic wa: sub. Name comes from
      // the group registry so the portal greets "Romina & Tim", not a number.
      const sub = `wa:${phone}`;
      const existing = await kvGet(`owner:${sub}`);
      let name = existing?.name || rec.name || null;
      if (!name) {
        const groupsRes = await crm('statement_groups', {});
        const g = (groupsRes.body?.groups || []).find(x => (x.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === phone));
        name = g?.owner_names || 'Villa owner';
      }
      const owner = {
        sub, wa: phone,
        email: existing?.email || null,
        name,
        picture: existing?.picture || '',
        createdAt: existing?.createdAt || new Date().toISOString(),
        creemCustomerId: existing?.creemCustomerId || null,
        favorites: Array.isArray(existing?.favorites) ? existing.favorites : [],
        notes: existing?.notes && typeof existing.notes === 'object' ? existing.notes : {},
        lists: Array.isArray(existing?.lists) ? existing.lists : [],
        profile: existing?.profile && typeof existing.profile === 'object' ? existing.profile : {},
      };
      await kvSet(`owner:${sub}`, owner);

      // Pending invite carried through the WhatsApp round-trip: claim the
      // group's listings now, server-side. A failed claim (e.g. another
      // account already holds a unit) never blocks the sign-in itself.
      let claimed = null;
      // Invited to one specific villa (admin assigned it by WhatsApp number).
      if (rec.listing) {
        try {
          const cur = (await kvGet(`listing:${rec.listing}`)) || {};
          const custom = UNITS_BY_SLUG[rec.listing] ? null : ((await kvGet('custom_properties')) || {});
          const held = UNITS_BY_SLUG[rec.listing] ? cur.ownerSub : custom?.[rec.listing]?.ownerSub;
          if (!held || held === sub) {
            if (UNITS_BY_SLUG[rec.listing]) {
              await kvSet(`listing:${rec.listing}`, { ...cur, slug: rec.listing, ownerSub: sub, updatedAt: Date.now() });
              claimed = UNITS_BY_SLUG[rec.listing].name;
            } else {
              custom[rec.listing].ownerSub = sub;
              custom[rec.listing].updatedAt = Date.now();
              await kvSet('custom_properties', custom);
              claimed = custom[rec.listing].name || rec.listing;
            }
            const owned = (await kvGet(`owner_listings:${sub}`)) || [];
            if (!owned.includes(rec.listing)) await kvSet(`owner_listings:${sub}`, [...owned, rec.listing]);
          }
        } catch { /* sign-in proceeds regardless */ }
      }
      if (rec.invite) {
        try {
          const out = await claimGroupListings(owner, rec.invite, { kvGet, kvSet, crm });
          if (out.status === 200) claimed = out.body.group;
        } catch { /* sign-in proceeds regardless */ }
      }

      const token = crypto.randomBytes(32).toString('hex');
      const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days, same as Google sessions
      await kvCmd('SET', `session:${token}`, JSON.stringify({ sub, exp: Date.now() + SESSION_TTL * 1000 }), 'EX', SESSION_TTL);
      const proto = req.headers['x-forwarded-proto'];
      const secure = proto ? proto.split(',')[0].trim() === 'https' : !/^localhost|^127\.0\.0\.1/.test(req.headers.host || '');
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
      return res.status(200).json({ owner: { sub, name: owner.name, wa: phone }, isNew: !existing, claimed });
    }

    // Owner-session realm: the signed-in owner saves their preferred payout
    // account for one of THEIR property groups. The server forwards only the
    // payout_account field — never the notify/number registry fields.
    if (action === 'payout_account') {
      const owner = await sessionOwner(req, kvGet);
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const groupKey = String(payload?.group_key || '');
      const myGroups = await ownerGroups(owner, kvGet, crm);
      if (!myGroups.some(g => g.key === groupKey)) return res.status(403).json({ error: 'Not your property' });
      try {
        const { status, body } = await crm('statement_group_patch', {
          key: groupKey, actor: 'owner',
          fields: { payout_account: payload?.account || null },
        });
        return res.status(status).json(body);
      } catch (e) {
        return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
      }
    }

    // Admin realm: forward statement_* actions to the CRM verbatim.
    // STATEMENTS_ADMIN_PASSWORD is Era's scoped credential — it opens the
    // payouts cockpit (this proxy + the payouts GET actions below) and
    // nothing else in the admin; her actions are attributed as actor 'era'.
    const auth = req.headers.authorization || '';
    const pwd = process.env.DASHBOARD_PASSWORD || '';
    const adminPwd = process.env.ADMIN_PASSWORD || '';
    const eraPwd = process.env.STATEMENTS_ADMIN_PASSWORD || '';
    if (!pwd && !adminPwd) return res.status(503).json({ error: 'Admin password not configured' });
    const isEra = eraPwd && auth === `Bearer ${eraPwd}`;
    if (!(pwd && auth === `Bearer ${pwd}`) && !(adminPwd && auth === `Bearer ${adminPwd}`) && !isEra) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
    if (!/^statement_[a-z_]+$/.test(String(action || ''))) {
      return res.status(400).json({ error: `unsupported action: ${action}` });
    }
    try {
      const { status, body } = await crm(action, { ...(payload || {}), actor: isEra ? 'era' : 'admin' });
      return res.status(status).json(body);
    } catch (e) {
      return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
    }
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const action = String(req.query.action || '');
  try {
    // ── Hostex month aggregates (service auth) ──────────────────────
    if (action === 'month-stats') {
      if (!sync || (req.headers.authorization || '') !== `Bearer ${sync}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const period = String(req.query.period || '');
      if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
      const units = String(req.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean)
        .map(slug => ({ slug, hostexId: UNITS_BY_SLUG[slug]?.hostexId || null, name: UNITS_BY_SLUG[slug]?.name || null }));
      if (!units.length) return res.status(400).json({ error: 'Missing slugs' });
      const stats = await buildMonthStats(units, period);
      // The CRM sends Era's recorded guest nights so direct rentals the
      // calendar never saw count as occupied.
      try { if (req.query.stmt_nights) applyStatementNights(stats, JSON.parse(String(req.query.stmt_nights))); } catch { /* best-effort */ }
      return res.status(200).json(stats);
    }

    // ── Public tokenized statement (no login) ───────────────────────
    if (action === 'public-statement') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const { status, body } = await crm('statement_public', { group_key: parsed.groupKey, period: parsed.period });
      // Reference FX rates for the page's currency picker — best-effort:
      // the statement renders fine without them (picker just stays hidden).
      if (status === 200) { try { body.fx = await getFx(); } catch { /* best-effort */ } }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }

    // ── Live timeframe stats for a statement's property group ───────
    // Authorized by the statement token (occupancy/nights only — the same
    // audience that can already see the month's full financials). The month
    // view stays the frozen snapshot; quarter/year/next are computed LIVE
    // from Hostex relative to the statement's period.
    if (action === 'stats') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const range = String(req.query.range || 'quarter');
      const [y, m] = parsed.period.split('-').map(Number);
      let from, to, label;
      if (range === 'year') {
        from = `${y}-01`; to = `${y}-12`; label = String(y);
      } else if (range === 'next') {
        const d = new Date(Date.UTC(y, m, 1));
        from = to = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      } else {
        const q = Math.floor((m - 1) / 3);
        from = `${y}-${String(q * 3 + 1).padStart(2, '0')}`;
        to = `${y}-${String(q * 3 + 3).padStart(2, '0')}`;
        label = `Q${q + 1} ${y}`;
      }
      const groupsRes = await crm('statement_groups', {});
      const group = (groupsRes.body?.groups || []).find(g => g.key === parsed.groupKey);
      if (!group) return res.status(404).json({ error: 'Unknown group' });
      const units = (group.listing_slugs || [])
        .map(slug => ({ slug, hostexId: UNITS_BY_SLUG[slug]?.hostexId || null, name: UNITS_BY_SLUG[slug]?.name || null }));
      const stats = await buildRangeStats(units, { from, to });
      // Count Era-recorded direct rentals as occupied nights (live views).
      try {
        const un = await crm('statement_unit_nights', { group_key: parsed.groupKey, from, to });
        if (un.status === 200) applyStatementNights(stats, un.body);
      } catch { /* best-effort */ }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ range, from, to, label, ...stats });
    }

    // ── Which property groups have an onboarded owner? ──────────────
    // Service-authed (sync secret). The portal's KV is the authority on who
    // actually holds an account, and Maya must not message an owner who has
    // never been introduced to the portal — so both sweeps ask here first
    // and hold their queue until the owner claims. The moment they do, the
    // next daily pass delivers whatever was waiting.
    if (action === 'claimed-groups') {
      if (!sync || (req.headers.authorization || '') !== `Bearer ${sync}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const groupsRes = await crm('statement_groups', {});
      const groups = groupsRes.body?.groups || [];
      const hostexMap = await loadHostexOwnerMap(kvGet);
      const custom = (await kvGet('custom_properties')) || {};
      // "Claimed" has to mean the OWNER onboarded, not merely that some
      // account holds the listing. Ikiel's own account holds several managed
      // villas (admin assignment, testing, Hostex sync), and counting those
      // would have Maya message an owner who has never seen the portal.
      const adminEmails = new Set(
        (process.env.ADMIN_OWNER_EMAILS || 'ikielptito@gmail.com')
          .split(',').map(e => e.trim().toLowerCase()).filter(Boolean));
      const isAdminAccount = async (sub) => {
        if (!sub) return false;
        const o = await kvGet(`owner:${sub}`);
        return !!(o?.email && adminEmails.has(String(o.email).toLowerCase()));
      };
      const claimed = [];
      const detail = {};
      for (const g of groups) {
        const slugs = g.listing_slugs || [];
        const subs = [...new Set(slugs
          .map(s => hostexMap[s]?.ownerSub || custom[s]?.ownerSub || null)
          .filter(Boolean))];
        const ownerSubs = [];
        for (const sub of subs) if (!(await isAdminAccount(sub))) ownerSubs.push(sub);
        // An owner who signed in with WhatsApp has a real account keyed by
        // their number, and sees their statements through it, but may never
        // have claimed a listing. That is still onboarded.
        let byWa = false;
        for (const n of (g.owner_wa_nums || [])) {
          const digits = String(n).replace(/\D/g, '');
          if (digits && await kvGet(`owner:wa:${digits}`)) { byWa = true; break; }
        }
        detail[g.key] = { slugs: slugs.length, held: subs.length, by_owner: ownerSubs.length, wa_account: byWa };
        if (ownerSubs.length || byWa) claimed.push(g.key);
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ claimed, detail });
    }

    // ── Signed-in owner's statements (portal tab) ───────────────────
    // Also serves the admin's read-only preview: a signed preview token
    // scopes the response to one group, exactly as its owner will see it.
    if (action === 'statements') {
      let groups;
      const previewGroup = verifyPreviewToken(req.query.preview || '');
      if (previewGroup) {
        const groupsRes = await crm('statement_groups', {});
        groups = (groupsRes.body?.groups || []).filter(g => g.key === previewGroup);
      } else {
        const owner = await sessionOwner(req, kvGet);
        if (!owner) return res.status(401).json({ error: 'Not signed in' });
        groups = await ownerGroups(owner, kvGet, crm);
      }
      if (!groups.length) return res.status(200).json({ statements: [], groups: [] });

      const listRes = await crm('statement_list', {});
      const mine = (listRes.body?.statements || [])
        .filter(s => ['published', 'partial', 'paid'].includes(s.status) && groups.some(g => g.key === s.group_key))
        .map(s => {
          const snap = s.hostex_snapshot || {};
          const sg = snap.group || null;
          const units = snap.units && typeof snap.units === 'object' ? Object.values(snap.units) : [];
          const soldU = units.reduce((a, u) => a + (Number(u.nights_sold) || 0), 0);
          const availU = units.reduce((a, u) => a + (Number(u.available_nights) || 0), 0);
          const nights = sg?.nights_sold ?? (units.length ? soldU : null);
          const occ = sg?.occupancy_pct ?? (availU > 0 ? Math.round((soldU / availU) * 100) : null);
          return {
            group_key: s.group_key,
            group_name: s.statement_groups?.name || s.group_key,
            period: s.period,
            status: s.status,
            gross_total: s.gross_total,
            commission_total: s.commission_total,
            nett_total: s.nett_total,
            expenses_total: s.expenses_total,
            adjustments_total: s.adjustments_total,
            payout_total: s.payout_total,
            paid_total: s.paid_total,
            // Privately-settled properties (LaneHAUS) owe nothing by design.
            balance: s.statement_groups?.tracks_payments === false ? 0
              : Math.max(0, (Number(s.payout_total) || 0) - (Number(s.paid_total) || 0)),
            tracks_payments: s.statement_groups?.tracks_payments !== false,
            occupancy_pct: occ,
            nights_sold: nights,
            currency: s.currency,
            published_at: s.published_at,
            paid_at: s.paid_at,
            // Safe to hand this owner the signed link — they're authorized for
            // the group; the token just lets them open/share the no-login page.
            url: `/st/${statementToken(s.group_key, s.period)}`,
          };
        });
      res.setHeader('Cache-Control', 'no-store');
      // Reference FX for the dashboard's currency picker — same server-cached
      // rates the statement page uses; display-only, payouts stay IDR.
      let fx = null;
      try { fx = await getFx(); } catch { /* best-effort */ }
      return res.status(200).json({
        statements: mine,
        groups: groups.map(g => ({ key: g.key, name: g.name, owner_names: g.owner_names || null, payout_account: g.payout_account || null, tracks_payments: g.tracks_payments !== false })),
        ...(fx ? { fx } : {}),
        ...(previewGroup ? { preview: true } : {}),
      });
    }

    // ── Admin diagnostic: why does a WhatsApp-signed-in owner see (or not
    // see) their statement groups? Auth: the caller's console key must be
    // accepted by the CRM (relayed check — the portal stores no console key).
    if (action === 'wa-owner-debug' || action === 'admin-claim' || action === 'admin-assign' || action === 'admin-release' || action === 'admin-delete-listing' || action === 'admin-invite-wa') {
      // Two ways in: the admin panel's password (it has no console key), or a
      // console key relayed to the CRM for command-line use.
      const bearer = req.headers.authorization || '';
      const byPassword = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD, process.env.STATEMENTS_ADMIN_PASSWORD]
        .filter(Boolean).some(p => bearer === `Bearer ${p}`);
      if (!byPassword) {
        const key = req.headers['x-console-key'] || '';
        const check = await fetch(`${crmBase}/api/statements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-console-key': String(key) },
          body: JSON.stringify({ action: 'statement_groups', payload: {} }),
        });
        if (check.status !== 200) return res.status(401).json({ error: 'Unauthorized' });
      }

      // admin-claim: link a statement group's listings to an existing owner
      // account without the owner doing anything — the server-side equivalent
      // of them opening their invite link while signed in. force=1 reassigns
      // units another account already holds (admin override).
      if (action === 'admin-claim') {
        const sub = String(req.query.sub || '');
        const groupKey = String(req.query.group || '');
        const owner = sub ? await kvGet(`owner:${sub}`) : null;
        if (!owner) return res.status(404).json({ error: 'No owner account with that sub' });
        const out = await claimGroupListings(owner, groupKey, { kvGet, kvSet, crm }, { force: req.query.force === '1' });
        return res.status(out.status).json({ ...out.body, owner: { sub: owner.sub, name: owner.name, email: owner.email } });
      }

      // admin-assign: link ONE listing (catalog unit or custom listing) to an
      // existing owner account — ownership fields + the owner_listings index,
      // immediately, no owner action needed.
      if (action === 'admin-assign') {
        const slug = String(req.query.slug || '');
        const sub = String(req.query.sub || '');
        const owner = sub ? await kvGet(`owner:${sub}`) : null;
        if (!owner) return res.status(404).json({ error: 'No owner account with that sub' });
        const email = (owner.email || '').toLowerCase() || null;
        let store = null;
        if (UNITS_BY_SLUG[slug]) {
          const o = (await kvGet(`listing:${slug}`)) || { slug };
          await kvSet(`listing:${slug}`, { ...o, slug, ownerSub: owner.sub, ownerEmail: email, updatedAt: Date.now() });
          store = 'catalog';
        } else {
          const all = (await kvGet('custom_properties')) || {};
          if (!all[slug]) return res.status(404).json({ error: 'Unknown listing slug' });
          all[slug].ownerSub = owner.sub;
          all[slug].ownerEmail = email;
          all[slug].updatedAt = Date.now();
          await kvSet('custom_properties', all);
          store = 'custom';
        }
        const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
        if (!owned.includes(slug)) { owned.push(slug); await kvSet(`owner_listings:${owner.sub}`, owned); }
        return res.status(200).json({ ok: true, slug, store, owner: { sub: owner.sub, name: owner.name, email } });
      }

      // admin-release: hand a listing back to nobody, so the owner's invite
      // can claim it cleanly. ownerEmail must be cleared too — claimByEmail
      // re-claims any listing whose email matches the signed-in account, so
      // leaving it would silently re-take the villa on the next portal visit.
      if (action === 'admin-release') {
        const slug = String(req.query.slug || '');
        if (!slug) return res.status(400).json({ error: 'slug required' });
        let prevSub = null;
        if (UNITS_BY_SLUG[slug]) {
          const o = (await kvGet(`listing:${slug}`)) || { slug };
          prevSub = o.ownerSub || null;
          await kvSet(`listing:${slug}`, { ...o, slug, ownerSub: null, ownerEmail: null, updatedAt: Date.now() });
        } else {
          const all = (await kvGet('custom_properties')) || {};
          if (!all[slug]) return res.status(404).json({ error: 'Unknown listing slug' });
          prevSub = all[slug].ownerSub || null;
          all[slug].ownerSub = null; all[slug].ownerEmail = null; all[slug].updatedAt = Date.now();
          await kvSet('custom_properties', all);
        }
        if (prevSub) {
          const owned = (await kvGet(`owner_listings:${prevSub}`)) || [];
          const kept = owned.filter(x => x !== slug);
          if (kept.length !== owned.length) await kvSet(`owner_listings:${prevSub}`, kept);
        }
        return res.status(200).json({ ok: true, slug, released_from: prevSub });
      }

      // admin-invite-wa: hand a villa to its owner using nothing but their
      // WhatsApp number. Maya sends the tap-to-open link; the account is
      // created and the listing linked in one step, so the owner never sees
      // an empty portal and never has to be told which button to press.
      if (action === 'admin-invite-wa') {
        const slug = String(req.query.slug || '');
        const phone = String(req.query.phone || '').replace(/\D/g, '').replace(/^0+/, '');
        const name = String(req.query.name || '').slice(0, 60);
        if (!slug || phone.length < 8) return res.status(400).json({ error: 'slug and a full phone number are required' });
        const isCatalog = !!UNITS_BY_SLUG[slug];
        if (!isCatalog) {
          const all = (await kvGet('custom_properties')) || {};
          if (!all[slug]) return res.status(404).json({ error: 'Unknown listing slug' });
        }
        const tok = crypto.randomBytes(16).toString('hex');
        await kvCmd('SET', `walogin:${tok}`,
          JSON.stringify({ phone, listing: slug, name, exp: Date.now() + 7 * 24 * 3600 * 1000 }), 'EX', 7 * 24 * 3600);
        const sendRes = await crm('statement_wa_login_code', { wa_num: phone, token: tok, allow_unregistered: true });
        if (sendRes.status !== 200) return res.status(502).json({ error: sendRes.body?.error || 'Could not send the invite' });
        return res.status(200).json({ ok: true, slug, phone, link: `https://sambarentals.com/portal?wa_login=${tok}` });
      }

      // admin-delete-listing: remove an owner-submitted listing (a duplicate
      // of a villa we already manage, say). Custom listings only — a catalog
      // unit is Samba's own record and must never be deletable this way.
      if (action === 'admin-delete-listing') {
        const slug = String(req.query.slug || '');
        if (!slug) return res.status(400).json({ error: 'slug required' });
        if (UNITS_BY_SLUG[slug]) return res.status(400).json({ error: 'that is a catalog unit, not an owner submission' });
        const all = (await kvGet('custom_properties')) || {};
        const rec = all[slug];
        if (!rec) return res.status(404).json({ error: 'Unknown listing slug' });
        const prevSub = rec.ownerSub || null;
        delete all[slug];
        await kvSet('custom_properties', all);
        if (prevSub) {
          const owned = (await kvGet(`owner_listings:${prevSub}`)) || [];
          const kept = owned.filter(x => x !== slug);
          if (kept.length !== owned.length) await kvSet(`owner_listings:${prevSub}`, kept);
        }
        return res.status(200).json({ ok: true, deleted: slug, was_owned_by: prevSub, name: rec.name || null });
      }

      // ?listing=<slug> — who holds this listing right now? Exact catalog/
      // custom lookup; on a custom-store miss, returns slugs containing the
      // query so a half-remembered name still finds its listing.
      if (req.query.listing) {
        const slug = String(req.query.listing);
        const o = await kvGet(`listing:${slug}`);
        const all = (await kvGet('custom_properties')) || {};
        const c = all[slug] || null;
        const rec = c || o;
        const holder = rec?.ownerSub ? await kvGet(`owner:${rec.ownerSub}`) : null;
        return res.status(200).json({
          slug, store: c ? 'custom' : o ? 'catalog' : null,
          ownerSub: rec?.ownerSub || null, ownerEmail: rec?.ownerEmail || null,
          holder: holder ? { name: holder.name, email: holder.email, wa: holder.wa || null } : null,
          ...(rec ? {} : { matches: Object.keys(all).filter(k => k.includes(slug)).slice(0, 10) }),
        });
      }
      // ?scan=1 — list owner accounts (key, name, created) to identify who a
      // confused sign-in actually created. Admin-gated; small keyspace.
      if (req.query.scan === '1') {
        const keys = [];
        let cursor = '0';
        for (let i = 0; i < 20; i++) {
          const out = await kvCmd('SCAN', cursor, 'MATCH', 'owner:*', 'COUNT', '200');
          if (!Array.isArray(out)) break;
          cursor = String(out[0]);
          keys.push(...(out[1] || []));
          if (cursor === '0') break;
        }
        const owners = await Promise.all(keys.map(async (k) => {
          const o = await kvGet(k);
          return { key: k, name: o?.name || null, email: o?.email || null, wa: o?.wa || null, createdAt: o?.createdAt || null };
        }));
        owners.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return res.status(200).json({ count: owners.length, owners: owners.slice(0, 25) });
      }
      const phone = String(req.query.phone || '').replace(/\D/g, '');
      const owner = await kvGet(`owner:wa:${phone}`);
      let groups = null, err = null;
      try {
        groups = (await ownerGroups(owner || { sub: `wa:${phone}`, wa: phone }, kvGet, crm)).map(g => g.key);
      } catch (e) { err = e.message; }
      return res.status(200).json({
        ownerExists: !!owner, ownerSub: owner?.sub || null, ownerWa: owner?.wa || null,
        ownerName: owner?.name || null, groups, err,
      });
    }

    // ── Admin read-only portal preview link ─────────────────────────
    if (action === 'preview-link') {
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD, process.env.STATEMENTS_ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const groupKey = String(req.query.group || '');
      if (!groupKey) return res.status(400).json({ error: 'Missing group' });
      return res.status(200).json({ url: `https://sambarentals.com/portal?preview=${previewToken(groupKey)}` });
    }

    // ── Owner invite link (admin) ───────────────────────────────────
    if (action === 'invite-link') {
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD, process.env.STATEMENTS_ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const groupKey = String(req.query.group || '');
      if (!groupKey) return res.status(400).json({ error: 'Missing group' });
      return res.status(200).json({ url: `https://sambarentals.com/portal?invite=${inviteToken(groupKey)}` });
    }

    // ── Excel exports ───────────────────────────────────────────────
    // One month, no login — the statement token IS the auth (same rule as
    // the /st/ page itself).
    if (action === 'export') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const { status, body } = await crm('statement_public', { group_key: parsed.groupKey, period: parsed.period });
      if (status !== 200) return res.status(status).json(body);
      return sendXlsx(res, buildStatementWorkbook(body), `Samba-Statement-${parsed.groupKey}-${parsed.period}.xlsx`);
    }
    // Whole group, banking-statement style: pick a month range (or all) and
    // get ONE consolidated workbook. Owner session or admin password.
    if (action === 'export-group') {
      const groupKey = String(req.query.group || '');
      const year = String(req.query.year || '').replace(/\D/g, '').slice(0, 4) || null;
      const from = /^\d{4}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : null;
      const to = /^\d{4}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : null;
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD, process.env.STATEMENTS_ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      const previewOk = verifyPreviewToken(req.query.preview || '') === groupKey;
      if (!isAdmin && !previewOk) {
        const owner = await sessionOwner(req, kvGet);
        const groups = owner ? await ownerGroups(owner, kvGet, crm) : [];
        if (!groups.some(g => g.key === groupKey)) return res.status(owner ? 403 : 401).json({ error: owner ? 'Not your property' : 'Not signed in' });
      }
      const { status, body } = await crm('statement_export_data', { group_key: groupKey, year, from, to });
      if (status !== 200) return res.status(status).json(body);
      const mlab = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
      const rangeLabel = from || to ? `${from ? mlab(from) : 'start'} – ${to ? mlab(to) : 'latest'}` : year;
      const suffix = from || to ? `-${from || 'start'}-to-${to || 'latest'}` : year ? '-' + year : '';
      return sendXlsx(res, buildGroupWorkbook(body, rangeLabel), `Samba-Financials-${groupKey}${suffix}.xlsx`);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Daily-ish IDR reference rates (open.er-api.com — keyless, generous limits),
// cached for the lambda's lifetime. Display convenience ONLY: every payout is
// made in IDR and the page says so whenever a conversion is shown.
let _fx = null;
async function getFx() {
  if (_fx && Date.now() - _fx.fetched < 12 * 3600e3) return _fx.payload;
  const r = await fetch('https://open.er-api.com/v6/latest/IDR');
  const d = await r.json();
  if (d?.result !== 'success' || !d.rates) return _fx?.payload || null;
  const payload = {
    base: 'IDR',
    as_of: String(d.time_last_update_utc || '').replace(/ \d\d:.*$/, ''),
    rates: Object.fromEntries(['USD', 'EUR', 'GBP', 'AUD', 'SGD'].map(c => [c, d.rates[c]]).filter(([, v]) => v)),
  };
  _fx = { payload, fetched: Date.now() };
  return payload;
}

function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}

function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)) : null;
}

// Claim a statement group's catalog listings for an owner account. Shared by
// the signed-in claim_invite action and the WhatsApp magic-link verify (which
// carries a pending invite through the WhatsApp round-trip, because
// sessionStorage does not survive into the new tab the link opens).
async function claimGroupListings(owner, groupKey, { kvGet, kvSet, crm }, { force = false } = {}) {
  const groupsRes = await crm('statement_groups', {});
  const group = (groupsRes.body?.groups || []).find(g => g.key === groupKey);
  if (!group) return { status: 404, body: { error: 'Unknown property' } };
  const slugs = (group.listing_slugs || []).filter(s => UNITS_BY_SLUG[s]);
  if (!slugs.length) return { status: 404, body: { error: 'No claimable listings' } };
  const overrides = await Promise.all(slugs.map(s => kvGet(`listing:${s}`)));
  for (let i = 0; i < slugs.length; i++) {
    const cur = overrides[i] || {};
    if (!force && cur.ownerSub && cur.ownerSub !== owner.sub) {
      return { status: 409, body: { error: `${UNITS_BY_SLUG[slugs[i]].name} is already linked to another account — ask Samba to sort it out.` } };
    }
  }
  // On a forced reassignment, drop the units from the previous holder's
  // owner_listings index so they don't keep a phantom entry.
  if (force) {
    const prevSubs = [...new Set(overrides.map(o => o?.ownerSub).filter(s => s && s !== owner.sub))];
    for (const prev of prevSubs) {
      const prevOwned = (await kvGet(`owner_listings:${prev}`)) || [];
      const kept = prevOwned.filter(s => !slugs.includes(s));
      if (kept.length !== prevOwned.length) await kvSet(`owner_listings:${prev}`, kept);
    }
  }
  for (let i = 0; i < slugs.length; i++) {
    const cur = overrides[i] || { slug: slugs[i] };
    await kvSet(`listing:${slugs[i]}`, {
      ...cur, slug: slugs[i],
      ownerSub: owner.sub,
      ownerEmail: (owner.email || cur.ownerEmail || '').toLowerCase() || null,
      updatedAt: Date.now(),
    });
  }
  // The portal's My-properties list reads the owner_listings:{sub} index, not
  // the per-slug overrides — without this the claimed units stay invisible.
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const merged = [...new Set([...owned, ...slugs])];
  if (merged.length !== owned.length) await kvSet(`owner_listings:${owner.sub}`, merged);
  // Tell Ikiel on Telegram: this is the moment their queued statements and
  // maintenance requests become sendable. Best-effort, never blocks the claim.
  crm('statement_owner_claimed', {
    group_key: groupKey, owner_email: owner.email || null, owner_name: owner.name || null,
  }).catch(() => {});
  return { status: 200, body: { ok: true, group: group.name, listings: slugs.map(s => UNITS_BY_SLUG[s].name) } };
}

async function sessionOwner(req, kvGet) {
  const token = readSessionToken(req);
  const session = token ? await kvGet(`session:${token}`) : null;
  return session && (!session.exp || session.exp >= Date.now()) ? kvGet(`owner:${session.sub}`) : null;
}

// The statement groups whose listing_slugs include a catalog unit this owner
// owns (statement groups only ever reference catalog slugs).
async function ownerGroups(owner, kvGet, crm) {
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const mySlugs = new Set(Object.values(hostexMap).filter(l => l.ownerSub === owner.sub).map(l => l.slug));
  // WhatsApp-sign-in owners also match groups by their registered number —
  // their statements appear even before any listing is claimed to the account.
  const wa = owner.wa ? String(owner.wa).replace(/\D/g, '') : null;
  if (!mySlugs.size && !wa) return [];
  const groupsRes = await crm('statement_groups', {});
  return (groupsRes.body?.groups || []).filter(g =>
    (g.listing_slugs || []).some(s => mySlugs.has(s))
    || (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa)));
}
