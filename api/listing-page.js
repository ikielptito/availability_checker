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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let _htmlCache = null;
let _listingsCache = null;
let _listingsCacheAt = 0;
const LISTINGS_TTL_MS = 60 * 1000;

const PORTAL_BASE = 'https://sambarentals.vercel.app';
const FALLBACK_OG = `${PORTAL_BASE}/og-portal.png`;

export default async function handler(req, res) {
  const slug = (req.query?.slug || '').toLowerCase();

  // Lazy-load listing.html on first request (cold start) — cached for the
  // life of this Lambda instance. The file is ~30KB, the JS runtime keeps
  // the cache warm across requests on the same instance.
  if (!_htmlCache) {
    try {
      // __dirname is the api/ folder (in dev) or /var/task/api (in Vercel).
      // public/ is its sibling in both environments.
      const candidates = [
        path.join(__dirname, '..', 'public', 'listing.html'),
        path.join(process.cwd(), 'public', 'listing.html'),
        '/var/task/public/listing.html',
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) { _htmlCache = fs.readFileSync(p, 'utf8'); break; }
      }
      if (!_htmlCache) throw new Error('listing.html not found');
    } catch (e) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(500).end('Listing template missing: ' + e.message);
    }
  }

  // Fetch listing metadata (60s cache so back-to-back shares of the same
  // property are nearly free)
  let listing = null;
  if (slug) {
    if (Date.now() - _listingsCacheAt > LISTINGS_TTL_MS) {
      try {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const lr = await fetch(`${proto}://${host}/api/listings`);
        const j = await lr.json();
        _listingsCache = j.listings || [];
        _listingsCacheAt = Date.now();
      } catch {}
    }
    listing = (_listingsCache || []).find(l => l.slug === slug && !l.hidden);
  }

  // Compose tags. When the listing isn't found (404 case), the generic
  // portal OG card + brand wording still renders, so the link is never
  // ugly even on stale or invalid URLs.
  const title = listing ? `${listing.name} — Samba Rentals` : 'Samba Rentals — Listing';
  const desc = listing
    ? composeDescription(listing)
    : 'Bali long-term rental — full details, photos, and live availability.';
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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.status(200).send(html);
}

function composeDescription(l) {
  const bits = [l.unitType, l.tag].filter(Boolean).join(' · ');
  const price = l.monthly
    ? `${l.monthly}/mo` + (l.yearly ? ` · ${l.yearly}/yr` : '')
    : null;
  const intro = l.overview ? l.overview.replace(/\s+/g, ' ').slice(0, 90).trim() + (l.overview.length > 90 ? '…' : '') : null;
  return [bits, price, intro].filter(Boolean).join(' · ');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
