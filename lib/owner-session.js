// The signed-in owner, and which villas are theirs. Shared by the owner-
// facing GET routes (maintenance items, housekeeping records) so every
// tab answers the same question — "whose villa is this?" — the same way:
//
//   • catalog units the portal account holds (owner or co-owner), and
//   • for WhatsApp sign-ins, the statement groups registered to that number,
//
// with a group's listing slugs counting as held once the group matches.

import { loadHostexOwnerMap } from './owner-listings.js';

const SESSION_COOKIE = 'samba_session';

export function makeKvGet() {
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  return async (key) => {
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
}

export function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)) : null;
}

export async function sessionOwner(req, kvGet) {
  const token = readSessionToken(req);
  const session = token ? await kvGet(`session:${token}`) : null;
  return session && (!session.exp || session.exp >= Date.now()) ? kvGet(`owner:${session.sub}`) : null;
}

// fetchGroups(): the CRM's statement groups (key, listing_slugs, owner_wa_nums).
export async function ownerGroups(owner, kvGet, fetchGroups) {
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const mySlugs = new Set(Object.values(hostexMap).filter(l => l.ownerSub === owner.sub || (l.coOwnerSubs || []).includes(owner.sub)).map(l => l.slug));
  const wa = owner.wa ? String(owner.wa).replace(/\D/g, '') : null;
  if (!mySlugs.size && !wa) return { groups: [], mySlugs };
  const groups = ((await fetchGroups()) || []).filter(g =>
    (g.listing_slugs || []).some(s => mySlugs.has(s))
    || (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa)));
  return { groups, mySlugs };
}

export async function ownerSlugs(owner, kvGet, fetchGroups) {
  const { groups, mySlugs } = await ownerGroups(owner, kvGet, fetchGroups);
  const all = new Set(mySlugs);
  for (const g of groups) for (const s of (g.listing_slugs || [])) all.add(s);
  return [...all];
}
