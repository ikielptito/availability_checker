// Serves /l/<slug> with per-listing OG meta tags injected into the <head>,
// so when an agent shares a property link on WhatsApp/iMessage/Slack the
// preview card shows the listing's actual title, price, and cover photo
// rather than the generic portal card.
//
// Vercel rewrite: /l/(.*) → /api/listing-page?slug=$1
//
// On cold start we read listing.html once and cache it in memory. Every
// request fetches the matching listing from /api/listings, injects tags,
// returns the modified HTML. The existing client-side JS in listing.html
// still runs after the OG tags are read by the scraper.

import { verifyReportToken, verifyStatementToken } from '../lib/tokens.js';
let _maintHtmlCache = null, _maintHtmlCacheAt = 0;

let _htmlCache = null;
let _htmlCacheAt = 0;
let _agentHtmlCache = null;
let _agentHtmlCacheAt = 0;
let _reportHtmlCache = null;
let _reportHtmlCacheAt = 0;
let _statementHtmlCache = null;
let _statementHtmlCacheAt = 0;
let _listingsCache = null;
let _listingsCacheAt = 0;
const TEMPLATE_TTL_MS = 5 * 60 * 1000;
const LISTINGS_TTL_MS = 60 * 1000;

const PORTAL_BASE = 'https://sambarentals.com';
const FALLBACK_OG = `${PORTAL_BASE}/og-portal.png`;

export default async function handler(req, res) {
  try {
    return await serve(req, res);
  } catch (e) {
    // Never 500 — link scrapers will refuse to render a preview, so on any
    // unexpected failure fall back to a minimal page carrying just the
    // generic portal OG card so the share still gets *some* preview.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(fallbackPage(req));
  }
}

async function serve(req, res) {
  const host = req.headers.host || 'sambarentals.com';
  const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https');

  // /a/<handle> and /s/<shareId> render the agent profile / shortlist page
  // with OG tags whose image is the first villa's cover photo.
  const agentHandle = (req.query?.agent || '').toString();
  const shareId = (req.query?.list || '').toString();
  if (agentHandle || shareId) return serveAgent(req, res, { proto, host, agentHandle, shareId });

  // /r/<slug>~<sig> — the weekly owner report. Maya sends these links on
  // WhatsApp every Monday; branded OG tags make the unfurl show the villa
  // instead of a generic page. The report itself still renders client-side.
  const reportToken = (req.query?.report || '').toString();
  if (reportToken) return serveReport(req, res, { proto, host, token: reportToken });

  // /st/<groupKey>.<period>~<sig> — the monthly payout statement Maya sends
  // owners of managed villas. Financial page: no-store, minimal OG.
  const statementToken = (req.query?.statement || '').toString();
  if (statementToken) return serveStatement(req, res, { proto, host, token: statementToken });

  // /m/<groupKey>.<id>~<sig> — a maintenance item Maya sent the owner, where
  // they approve or decline the work. No-store, noindex, same stance.
  const maintToken = (req.query?.maintenance || '').toString();
  if (maintToken) return serveMaintenance(req, res, { proto, host, token: maintToken });

  const slug = (req.query?.slug || '').toLowerCase();

  // Fetch the template and the listings metadata concurrently. On a cold
  // Lambda both caches are empty, and these are independent requests, so
  // running them in parallel shaves a full round-trip off first-share preview
  // latency (the scraper is waiting on this response). listing.html is served
  // statically from public/; listings has its own 60s cache.
  await Promise.all([
    ensureTemplate(proto, host),
    slug ? getListings(proto, host) : Promise.resolve(),
  ]);
  const listing = slug ? (_listingsCache || []).find(l => l.slug === slug && !l.hidden) : null;

  // Compose tags. When the listing isn't found (404 case), the generic
  // portal OG card + brand wording still renders, so the link is never
  // ugly even on stale or invalid URLs.
  const title = listing ? `${listing.name} · Samba Rentals` : 'Samba Rentals · Listing';
  const desc = listing
    ? composeDescription(listing)
    : 'Bali long-term rental: full details, photos, and live availability.';
  const url = listing ? `${PORTAL_BASE}/l/${listing.slug}` : `${PORTAL_BASE}${req.url}`;
  const image = listing?.coverPhotoId
    ? `https://lh3.googleusercontent.com/d/${listing.coverPhotoId}=w1200-h630-c`
    : FALLBACK_OG;

  const tags = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Samba Rentals">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:url" content="${esc(url)}">
    <meta property="og:image" content="${esc(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${esc(title)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(desc)}">
    <meta name="twitter:image" content="${esc(image)}">
  `.trim();

  // Replace listing.html's existing <title> with our composed tags block.
  // Anything else in <head> (fonts, viewport, etc.) stays intact.
  const html = _htmlCache.replace(/<title>[\s\S]*?<\/title>/, tags);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // A slug we can't resolve answers 404, not 200. The body is unchanged —
  // scrapers still get an OG card and the visitor still gets a rendered page —
  // but a soft 200 let search engines index "not found" pages and made uptime
  // checks report dead share links as healthy.
  const missing = !!slug && !listing;
  res.setHeader('Cache-Control', missing
    ? 'no-store'
    : 's-maxage=300, stale-while-revalidate=86400');
  return res.status(missing ? 404 : 200).send(html);
}

// Lazy-load + cache listing.html (5-min per-Lambda TTL). Served statically
// from public/, so we fetch it over HTTPS rather than reading from disk (the
// function bundle doesn't include public/).
async function ensureTemplate(proto, host) {
  if (_htmlCache && Date.now() - _htmlCacheAt <= TEMPLATE_TTL_MS) return _htmlCache;
  const tr = await fetch(`${proto}://${host}/listing.html`);
  if (!tr.ok) throw new Error(`listing.html fetch ${tr.status}`);
  _htmlCache = await tr.text();
  _htmlCacheAt = Date.now();
  return _htmlCache;
}

async function ensureAgentTemplate(proto, host) {
  if (_agentHtmlCache && Date.now() - _agentHtmlCacheAt <= TEMPLATE_TTL_MS) return _agentHtmlCache;
  const tr = await fetch(`${proto}://${host}/agent.html`);
  if (!tr.ok) throw new Error(`agent.html fetch ${tr.status}`);
  _agentHtmlCache = await tr.text();
  _agentHtmlCacheAt = Date.now();
  return _agentHtmlCache;
}

async function getListings(proto, host) {
  if (Date.now() - _listingsCacheAt > LISTINGS_TTL_MS) {
    try {
      const lr = await fetch(`${proto}://${host}/api/listings`);
      const j = await lr.json();
      _listingsCache = j.listings || [];
      _listingsCacheAt = Date.now();
    } catch {}
  }
  return _listingsCache || [];
}

async function serveAgent(req, res, { proto, host, agentHandle, shareId }) {
  // Load the agent.html template and the public profile/shortlist concurrently
  // (independent requests) so a cold Lambda doesn't serialize two round-trips.
  const q = shareId ? `share=${encodeURIComponent(shareId)}` : `handle=${encodeURIComponent(agentHandle)}`;
  let prof = null, slugs = [], listName = null;
  const [, profRes] = await Promise.all([
    ensureAgentTemplate(proto, host),
    fetch(`${proto}://${host}/api/portal?action=agent-public&${q}`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (profRes) { prof = profRes.profile || null; slugs = profRes.slugs || []; listName = profRes.listName || null; }

  // OG image = the first villa's cover photo (falls back to the portal card).
  let image = FALLBACK_OG;
  if (slugs.length) {
    const listings = await getListings(proto, host);
    const first = listings.find(l => l.slug === slugs[0] && l.coverPhotoId);
    if (first) image = `https://lh3.googleusercontent.com/d/${first.coverPhotoId}=w1200-h630-c`;
  }

  const who = (prof && prof.displayName) || 'An agent';
  const n = slugs.length;
  const title = listName ? `${listName} · Samba Rentals` : `${who}'s villa picks · Samba Rentals`;
  const desc = prof
    ? `${n} hand-picked Bali villa${n === 1 ? '' : 's'}${prof.agency ? ' · ' + prof.agency : ''}: view details, photos, and live availability.`
    : 'Hand-picked Bali villas on Samba Rentals.';
  const url = `${PORTAL_BASE}${shareId ? '/s/' + shareId : '/a/' + agentHandle}`;

  const tags = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Samba Rentals">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:url" content="${esc(url)}">
    <meta property="og:image" content="${esc(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${esc(title)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(desc)}">
    <meta name="twitter:image" content="${esc(image)}">
  `.trim();

  const html = _agentHtmlCache.replace(/<title>[\s\S]*?<\/title>/, tags);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.status(200).send(html);
}

// Weekly report page with villa-specific OG tags. Token = slug~hmac16 (same
// scheme api/portal.js verifies); an invalid signature still serves the page
// with generic branding — report-view.html shows its own error client-side.
async function serveReport(req, res, { proto, host, token }) {
  let listing = null;
  const slug = verifyReportToken(token);
  if (slug) {
    await Promise.all([ensureReportTemplate(proto, host), getListings(proto, host)]);
    listing = (_listingsCache || []).find(l => l.slug === slug) || null;
  }
  if (!_reportHtmlCache) await ensureReportTemplate(proto, host);

  const title = listing ? `Weekly report · ${listing.name} · Samba` : 'Your villa report · Samba';
  const desc = listing
    ? `Views, enquiries, agent reach and occupancy for ${listing.name} this week, from Samba Realty.`
    : 'Your villa’s weekly performance: views, enquiries, agent reach and occupancy.';
  const image = listing?.coverPhotoId
    ? `https://lh3.googleusercontent.com/d/${listing.coverPhotoId}=w1200-h630-c`
    : FALLBACK_OG;
  const url = `${PORTAL_BASE}/r/${token}`;

  const tags = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Samba">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:url" content="${esc(url)}">
    <meta property="og:image" content="${esc(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${esc(title)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(desc)}">
    <meta name="twitter:image" content="${esc(image)}">
  `.trim();

  const html = _reportHtmlCache.replace(/<title>[\s\S]*?<\/title>/, tags);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.status(200).send(html);
}

// Monthly payout statement page. Token = groupKey.period~hmac16 (verified by
// lib/tokens.js — same scheme the CRM mints). Financial content: the page is
// never CDN-cached, and OG tags stay generic (no amounts, no owner names —
// WhatsApp link previews are rendered by Meta's scraper).
async function serveStatement(req, res, { proto, host, token }) {
  const parsed = verifyStatementToken(token);
  if (!_statementHtmlCache || Date.now() - _statementHtmlCacheAt > TEMPLATE_TTL_MS) {
    const tr = await fetch(`${proto}://${host}/statement.html`);
    if (!tr.ok) throw new Error(`statement.html fetch ${tr.status}`);
    _statementHtmlCache = await tr.text();
    _statementHtmlCacheAt = Date.now();
  }
  const title = parsed ? `Monthly statement · ${monthLabel(parsed.period)} · Samba` : 'Monthly statement · Samba';
  const desc = 'Your villa’s monthly statement from Samba Realty: bookings, expenses, occupancy and payout.';
  const tags = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta name="robots" content="noindex">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Samba">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:image" content="${FALLBACK_OG}">
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(desc)}">
  `.trim();
  const html = _statementHtmlCache.replace(/<title>[\s\S]*?<\/title>/, tags);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}

async function serveMaintenance(req, res, { proto, host }) {
  if (!_maintHtmlCache || Date.now() - _maintHtmlCacheAt > TEMPLATE_TTL_MS) {
    const tr = await fetch(`${proto}://${host}/maintenance.html`);
    if (!tr.ok) throw new Error(`maintenance.html fetch ${tr.status}`);
    _maintHtmlCache = await tr.text();
    _maintHtmlCacheAt = Date.now();
  }
  const title = 'Maintenance request · Samba Realty';
  const desc = 'A maintenance item at your villa, with photos and an estimate.';
  const tags = `
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(desc)}">
    <meta name="robots" content="noindex">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Samba">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(desc)}">
    <meta property="og:image" content="${FALLBACK_OG}">
    <meta name="twitter:card" content="summary">
  `.trim();
  const html = _maintHtmlCache.replace(/<title>[\s\S]*?<\/title>/, tags);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(html);
}

function monthLabel(period) {
  const [y, m] = String(period).split('-').map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

async function ensureReportTemplate(proto, host) {
  if (_reportHtmlCache && Date.now() - _reportHtmlCacheAt <= TEMPLATE_TTL_MS) return _reportHtmlCache;
  const tr = await fetch(`${proto}://${host}/report-view.html`);
  if (!tr.ok) throw new Error(`report-view.html fetch ${tr.status}`);
  _reportHtmlCache = await tr.text();
  _reportHtmlCacheAt = Date.now();
  return _reportHtmlCache;
}

function fmtP(p) { return p ? p.replace(/(\d+)jt/i, 'IDR $1M') : ''; }

function composeDescription(l) {
  const bits = [l.unitType, l.tag].filter(Boolean).join(' · ');
  const price = l.monthly
    ? fmtP(l.monthly) + '/mo' + (l.yearly ? ` · ${fmtP(l.yearly)}/yr` : '')
    : null;
  const intro = l.overview ? l.overview.replace(/\s+/g, ' ').slice(0, 90).trim() + (l.overview.length > 90 ? '…' : '') : null;
  return [bits, price, intro].filter(Boolean).join(' · ');
}

function fallbackPage(req) {
  const url = `${PORTAL_BASE}${req.url || '/'}`;
  return `<!doctype html><html><head>
<meta charset="utf-8">
<title>Samba Rentals</title>
<meta name="description" content="Bali long-term rental: full details, photos, and live availability.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Samba Rentals">
<meta property="og:title" content="Samba Rentals">
<meta property="og:description" content="Bali long-term rental: full details, photos, and live availability.">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${FALLBACK_OG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${esc(url)}">
</head><body><a href="${esc(url)}">Open listing</a></body></html>`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
