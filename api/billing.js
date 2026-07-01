// Paddle billing for the owner portal. Single function, routed by ?action=:
//
//   POST ?action=portal-session   → authenticated Paddle customer-portal link (session-gated)
//   POST  (webhook, no action)     → Paddle notification: verify signature, update sub:{slug}
//
// No npm deps: Paddle API via fetch + Bearer key; webhook signature via node crypto.
// Checkout itself is opened client-side with Paddle.js (see portal.html) — the webhook
// is the source of truth that flips a listing to "Live".
import crypto from 'node:crypto';
import { logError } from '../lib/errlog.js';

// Disable Vercel's automatic body parsing so we can read the exact raw bytes the
// Paddle signature was computed over.
export const config = { api: { bodyParser: false } };

const SESSION_COOKIE = 'samba_session';

function paddleApiBase() {
  return process.env.PADDLE_ENV === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';
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
    if (action === 'portal-session' && req.method === 'POST') {
      return portalSession(req, res, { kvGet });
    }
    // Default POST with no action = Paddle webhook.
    if (req.method === 'POST') {
      return webhook(req, res, { kvGet, kvSet });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    await logError(kvUrl, kvToken, `billing:${action || req.method}`, e);
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

// ── Customer portal session (session-gated) ─────────────────────────
async function portalSession(req, res, { kvGet }) {
  const owner = await currentOwner(req, kvGet);
  if (!owner) return res.status(401).json({ error: 'Not signed in' });
  if (!owner.paddleCustomerId) {
    return res.status(400).json({ error: 'No billing account yet. Subscribe to a property first.' });
  }
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'PADDLE_API_KEY not configured' });

  const r = await fetch(`${paddleApiBase()}/customers/${owner.paddleCustomerId}/portal-sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await r.json().catch(() => ({}));
  const url = data?.data?.urls?.general?.overview;
  if (!r.ok || !url) return res.status(502).json({ error: 'Could not create portal session' });
  return res.status(200).json({ url });
}

// ── Webhook ─────────────────────────────────────────────────────────
async function webhook(req, res, { kvGet, kvSet }) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'PADDLE_WEBHOOK_SECRET not configured' });

  const sig = req.headers['paddle-signature'] || '';

  // Collect candidate raw-body representations. Vercel's Node runtime often
  // pre-parses the JSON body (consuming the stream), so the live-stream read
  // can come back empty — in that case fall back to re-serializing the parsed
  // body. Paddle sends compact JSON, which round-trips byte-for-byte through
  // JSON.parse → JSON.stringify, so the HMAC still matches.
  const candidates = [];
  if (typeof req.rawBody === 'string') candidates.push(req.rawBody);
  try { const sb = await getRawBody(req); if (sb) candidates.push(sb); } catch { /* not a stream */ }
  if (req.body != null) candidates.push(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

  const raw = candidates.find(c => verifyPaddleSignature(c, sig, secret));
  if (!raw) return res.status(401).json({ error: 'Invalid signature' });

  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const type = evt.event_type || '';
  if (type.startsWith('subscription.')) {
    const d = evt.data || {};
    const slug = d.custom_data?.slug;
    const ownerSub = d.custom_data?.ownerSub;
    if (slug) {
      const status = mapStatus(d.status, type);
      await kvSet(`sub:${slug}`, {
        status,
        paddleSubscriptionId: d.id || null,
        paddleCustomerId: d.customer_id || null,
        ownerSub: ownerSub || null,
        currentPeriodEnd: d.current_billing_period?.ends_at || null,
        updatedAt: new Date().toISOString(),
      });
      // Remember the Paddle customer on the owner record so we can open their portal.
      if (ownerSub && d.customer_id) {
        const owner = await kvGet(`owner:${ownerSub}`);
        if (owner && owner.paddleCustomerId !== d.customer_id) {
          owner.paddleCustomerId = d.customer_id;
          await kvSet(`owner:${ownerSub}`, owner);
        }
      }
    }
  }

  // Always 200 quickly so Paddle doesn't retry a handled event.
  return res.status(200).json({ ok: true });
}

// Paddle status → our sub status. Trialing counts as active for visibility.
function mapStatus(paddleStatus, eventType) {
  if (eventType === 'subscription.canceled') return 'canceled';
  switch (paddleStatus) {
    case 'active':
    case 'trialing': return 'active';
    case 'past_due': return 'past_due';
    case 'canceled':
    case 'paused': return 'canceled';
    default: return paddleStatus || 'canceled';
  }
}

// HMAC-SHA256 of `${ts}:${rawBody}`, compared to h1, timing-safe.
function verifyPaddleSignature(rawBody, header, secret) {
  const parts = Object.fromEntries(String(header).split(';').map(kv => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
  }));
  const ts = parts.ts, h1 = parts.h1;
  if (!ts || !h1) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(h1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
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
