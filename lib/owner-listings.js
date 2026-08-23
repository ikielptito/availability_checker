// Unified listing resolution for the owner portal + owner feeds.
//
// The site has two listing stores: the 14 Hostex catalog units (identity in
// lib/catalog.js, per-slug KV overrides `listing:{slug}`) and owner/custom
// listings (single KV hash `custom_properties`). Historically the owner
// portal read ONLY custom_properties, so catalog units could never belong to
// an owner. Ownership for Hostex units now lives in the same per-slug
// override the admin console already writes (`ownerEmail`, `ownerSub`,
// `reportContactName`, `reportWaNumber`) — this module is the shared way to
// resolve a slug across both stores and to strip owner-private fields before
// anything is served publicly.
//
// Deliberately NOT here: `listingVisible()` (api/listings.js) — it gates
// custom listings only. Hostex units are unconditionally public and must
// never be routed through it.

import { UNITS, UNITS_BY_SLUG } from './catalog.js';

export function isHostexSlug(slug) {
  return !!UNITS_BY_SLUG[slug];
}

// Analytics/tracking key for a listing. Hostex units have always been
// tracked under their bare numeric hostexId (public/listing.html PROP_ID,
// api/dashboard.js) — reusing it keeps their full metrics history. Custom
// listings use the 'c_' prefix.
export function propIdFor(listing) {
  return listing?.hostexId ? String(listing.hostexId) : 'c_' + listing.slug;
}

// Load all 14 catalog units merged with their KV overrides, keyed by slug.
// `kvGet` is injected because every serverless function builds its own KV
// closure (no shared client). Rows carry `hostex: true` so consumers (portal
// UI restrictions, feed emitters, billing skips) can branch on provenance.
export async function loadHostexOwnerMap(kvGet) {
  const overrides = await Promise.all(UNITS.map(u => kvGet(`listing:${u.slug}`)));
  const map = {};
  UNITS.forEach((u, i) => {
    map[u.slug] = { ...u, ...(overrides[i] || {}), slug: u.slug, hostex: true };
  });
  return map;
}

// Resolve a slug across both stores. Custom wins (slug collisions are blocked
// at creation, so overlap can't happen in practice — this is belt and braces).
export function resolveOwnedListing(slug, customMap, hostexMap) {
  if (customMap && customMap[slug]) return customMap[slug];
  if (hostexMap && hostexMap[slug]) return hostexMap[slug];
  return null;
}

// Fields that must never leave over an unauthenticated endpoint. waNumber /
// waContactName stay public on purpose — they are the listing's public
// booking contact and the enquiry flow reads them.
const OWNER_PRIVATE_FIELDS = [
  'ownerSub', 'ownerEmail', 'ownerWa',
  'reportContactName', 'reportWaNumber',
  'source',
];

// Canonical WhatsApp number (digits, 62… for Indonesian mobiles). Same rules
// as api/digest.js: repairs "620…" (stray 0 after the country code — Villa
// Tiga's contact was stored that way) and local "08…" formats; leaves foreign
// numbers (+86 China, +852 HK) alone.
export function normalizeWaNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('620')) return '62' + d.slice(3);
  if (d.startsWith('0')) return '62' + d.slice(1);
  if (/^8(1|2|3|7|9)\d{8,10}$/.test(d)) return '62' + d;
  return d;
}

export function sanitizePublicListing(l) {
  const out = { ...l };
  for (const f of OWNER_PRIVATE_FIELDS) delete out[f];
  if (out.waNumber) out.waNumber = normalizeWaNumber(out.waNumber);
  return out;
}
