// Creem billing for the owner portal. Single function, routed by ?action=:
//
//   POST ?action=checkout         → authenticated: create a Creem hosted-checkout
//                                    session for one listing, returns { url }
//   POST ?action=portal-session   → authenticated Creem customer-portal link
//   POST  (webhook, no action)    → Creem notification: verify signature, update sub:{slug}
//
// No npm deps: Creem API via fetch + x-api-key; webhook signature via node crypto.
// The webhook is the source of truth that flips a listing to "Live".
import crypto from 'node:crypto';
import { logError } from '../lib/errlog.js';

// Disable Vercel's automatic body parsing so we can read the exact raw bytes the
// Creem signature was computed over.
export const config = { api: { bodyParser: false } };

const SESSION_COOKIE = 'samba_session';

// Test-mode keys (creem_test_…) must talk to the sandbox API host.
function creemApiBase() {
  const key = process.env.CREEM_API_KEY || '';
  return key.startsWith('creem_test_') ? 'https://test-api.creem.io' : 'https://api.creem.io';
}

async function creem(path, body) {
  const r = await fetch(`${creemApiBase()}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': process.env.CREEM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  async function kvCmd(cmd) {
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([cmd]),
    });
    const out = await r.json();
    return Array.isArray(out) ? out[0]?.result : undefined;
  }
  async function kvGet(key) {
    const raw = await kvCmd(['GET', key]);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  const kvSet = (key, value) => kvCmd(['SET', key, JSON.stringify(value)]);

  const action = req.query.action || '';

  try {
    if (action === 'checkout' && req.method === 'POST') {
      return checkout(req, res, { kvGet });
    }
    if (action === 'portal-session' && req.method === 'POST') {
      return portalSession(req, res, { kvGet });
    }
    // Default POST with no action = Creem webhook.
    if (req.method === 'POST') {
      return webhook(req, res, { kvGet, kvSet });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    await logError(kvUrl, kvToken, `billing:${action || req.method}`, e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

// ── Checkout session (session-gated) ────────────────────────────────
async function checkout(req, res, { kvGet }) {
  const owner = await currentOwner(req, kvGet);
  if (!owner) return res.status(401).json({ error: 'Not signed in' });
  if (!process.env.CREEM_API_KEY || !process.env.CREEM_PRODUCT_ID) {
    return res.status(500).json({ error: 'Billing is not set up yet. Check back soon.' });
  }

  const body = await readJsonBody(req);
  const slug = String(body.slug || '').trim();
  const promo = String(body.promo || '').trim().toUpperCase();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  // Only the listing's owner may start a checkout for it.
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  if (!owned.includes(slug)) return res.status(403).json({ error: 'Not your listing' });

  const payload = {
    product_id: process.env.CREEM_PRODUCT_ID,
    request_id: `${slug}:${Date.now()}`,
    units: 1,
    customer: owner.email ? { email: owner.email } : undefined,
    success_url: `https://sambarentals.com/portal?paid=${encodeURIComponent(slug)}`,
    metadata: { slug, ownerSub: owner.sub },
  };
  if (promo) payload.discount_code = promo;

  const r = await creem('/v1/checkouts', payload);
  const url = r.data?.checkout_url;
  if (!r.ok || !url) {
    // Surface Creem's message for recoverable cases (e.g. invalid discount code).
    const detail = r.data?.message || r.data?.error || 'Could not start checkout';
    return res.status(502).json({ error: Array.isArray(detail) ? detail.join(', ') : detail });
  }
  return res.status(200).json({ url });
}

// ── Customer portal session (session-gated) ─────────────────────────
async function portalSession(req, res, { kvGet }) {
  const owner = await currentOwner(req, kvGet);
  if (!owner) return res.status(401).json({ error: 'Not signed in' });
  if (!owner.creemCustomerId) {
    return res.status(400).json({ error: 'No billing account yet. Subscribe to a property first.' });
  }
  const r = await creem('/v1/customers/billing', { customer_id: owner.creemCustomerId });
  const url = r.data?.billing_portal_url || r.data?.customer_portal_link;
  if (!r.ok || !url) return res.status(502).json({ error: 'Could not create portal session' });
  return res.status(200).json({ url });
}

// ── Webhook ─────────────────────────────────────────────────────────
async function webhook(req, res, { kvGet, kvSet }) {
  const secret = process.env.CREEM_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'CREEM_WEBHOOK_SECRET not configured' });

  const sig = req.headers['creem-signature'] || '';

  // Collect candidate raw-body representations. Vercel's Node runtime can
  // pre-parse the JSON body (consuming the stream), so the live-stream read
  // may come back empty — fall back to re-serializing the parsed body, which
  // round-trips compact JSON byte-for-byte.
  const candidates = [];
  if (typeof req.rawBody === 'string') candidates.push(req.rawBody);
  try { const sb = await getRawBody(req); if (sb) candidates.push(sb); } catch { /* not a stream */ }
  if (req.body != null) candidates.push(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  const raw = candidates.find(c => verifyCreemSignature(c, sig, secret));
  if (!raw) return res.status(401).json({ error: 'Invalid signature' });

  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const type = evt.eventType || evt.event_type || '';
  const obj = evt.object || {};

  // Normalize: subscription.* events carry the subscription as the object;
  // checkout.completed carries a checkout with a nested subscription.
  let sub = null;
  if (type.startsWith('subscription.')) sub = obj;
  else if (type === 'checkout.completed') sub = obj.subscription || null;

  if (sub) {
    const meta = sub.metadata || obj.metadata || {};
    const slug = meta.slug;
    const ownerSub = meta.ownerSub;
    const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id || null);
    if (slug) {
      const status = mapStatus(sub.status, type);
      await kvSet(`sub:${slug}`, {
        status,
        source: 'creem',
        creemSubscriptionId: sub.id || null,
        creemCustomerId: customerId,
        ownerSub: ownerSub || null,
        currentPeriodEnd: sub.current_period_end_date || sub.current_period_end || null,
        updatedAt: new Date().toISOString(),
      });
      // Remember the Creem customer on the owner record so we can open their portal.
      if (ownerSub && customerId) {
        const owner = await kvGet(`owner:${ownerSub}`);
        if (owner && owner.creemCustomerId !== customerId) {
          owner.creemCustomerId = customerId;
          await kvSet(`owner:${ownerSub}`, owner);
        }
      }
    }
  }

  // Always 200 quickly so Creem doesn't retry a handled event.
  return res.status(200).json({ ok: true });
}

// Creem status/event → our sub status. A scheduled cancel stays active until
// the period actually ends (subscription.canceled / .expired arrives then).
function mapStatus(creemStatus, eventType) {
  if (eventType === 'subscription.canceled' || eventType === 'subscription.expired') return 'canceled';
  switch (creemStatus) {
    case 'active':
    case 'trialing': return 'active';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'paused':
    case 'expired': return 'canceled';
    default: return creemStatus || 'canceled';
  }
}

// HMAC-SHA256 hex of the raw body, compared timing-safe.
function verifyCreemSignature(rawBody, header, secret) {
  const received = String(header).trim();
  if (!received) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  if (req.body != null && typeof req.body === 'object') return req.body;
  const raw = typeof req.body === 'string' ? req.body : await getRawBody(req).catch(() => '');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

// ── Session (mirrors api/portal.js) ─────────────────────────────────
function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)) : null;
}
async function currentOwner(req, kvGet) {
  const token = readSessionToken(req);
  if (!token) return null;
  const session = await kvGet(`session:${token}`);
  if (!session || (session.exp && session.exp < Date.now())) return null;
  return kvGet(`owner:${session.sub}`);
}
