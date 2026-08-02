// Local dev server: serves public/ with vercel.json rewrites and runs real api/ handlers
// against mocked Upstash/Hostex/Drive upstreams. For verification only.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.KV_REST_API_URL = 'http://kv';
process.env.KV_REST_API_TOKEN = 't';
// Dev-only login password (never the production one — that lives in Vercel env).
process.env.DASHBOARD_PASSWORD = process.env.DEV_DASHBOARD_PASSWORD || 'dev-password';
process.env.HOSTEX_TOKEN = 'fake';
process.env.GOOGLE_API_KEY = 'fake';
process.env.GOOGLE_CLIENT_ID = 'dev-client-id';
process.env.PADDLE_ENV = 'sandbox';
process.env.PADDLE_API_KEY = 'dev-paddle-key';
process.env.PADDLE_CLIENT_TOKEN = 'test_dev_client_token';
process.env.PADDLE_PRICE_ID = 'pri_dev_10mo';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_devsecret';
process.env.DIGEST_SHARED_SECRET = 'dev_secret';
process.env.CRM_BASE_URL = 'http://localhost:3456/__crm_mock';
const __crmCalls = [];

// ── mock redis ──
const store = new Map(), sets = new Map(), hashes = new Map(), lists = new Map();
function exec(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    case 'SET': store.set(a[0], a[1]); return 'OK'; // ignores EX/extra args (no TTL in mock)
    case 'DEL': { let n = 0; for (const k of a) { if (store.delete(k)) n++; sets.delete(k); hashes.delete(k); lists.delete(k); } return n; }
    case 'INCR': { const v = (parseInt(store.get(a[0])) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'HINCRBY': { if (!hashes.has(a[0])) hashes.set(a[0], new Map()); const h = hashes.get(a[0]); const v = (parseInt(h.get(a[1])) || 0) + parseInt(a[2]); h.set(a[1], String(v)); return v; }
    case 'HGETALL': { const h = hashes.get(a[0]); if (!h) return []; const o = []; for (const [k, v] of h) o.push(k, v); return o; }
    case 'SADD': { if (!sets.has(a[0])) sets.set(a[0], new Set()); sets.get(a[0]).add(a[1]); return 1; }
    case 'SCARD': return sets.has(a[0]) ? sets.get(a[0]).size : 0;
    case 'SUNION': { const u = new Set(); a.forEach(k => (sets.get(k) || new Set()).forEach(m => u.add(m))); return [...u]; }
    case 'LPUSH': { if (!lists.has(a[0])) lists.set(a[0], []); lists.get(a[0]).unshift(a[1]); return lists.get(a[0]).length; }
    case 'LTRIM': { const l = lists.get(a[0]) || []; lists.set(a[0], l.slice(parseInt(a[1]), parseInt(a[2]) + 1)); return 'OK'; }
    case 'LRANGE': { const l = lists.get(a[0]) || []; return l.slice(parseInt(a[1]), parseInt(a[2]) + 1); }
    case 'EXPIRE': return 1; // no TTL in the mock; accept so rate-limit writes don't throw
    default: throw new Error('unhandled op ' + op);
  }
}

const HOSTEX_PROPS = [
  { id: 11621510, name: 'HAUS Canggu – Unit 1', property_type: 'Apartment', cover: { large_url: 'https://picsum.photos/seed/h1/400/300' } },
  { id: 11621511, name: 'HAUS Canggu – Unit 2', property_type: 'Apartment', cover: { large_url: 'https://picsum.photos/seed/h2/400/300' } },
  { id: 12552236, name: 'Villa Saturno', property_type: 'Villa', cover: { large_url: 'https://picsum.photos/seed/vs/400/300' } },
];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://kv/pipeline')) {
    const results = JSON.parse(opts.body).map(c => ({ result: exec(c) }));
    return { json: async () => results };
  }
  if (u.startsWith('http://kv/get/')) {
    const key = decodeURIComponent(u.slice('http://kv/get/'.length));
    return { json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
  }
  if (u.startsWith('http://kv/set/')) {
    const key = decodeURIComponent(u.slice('http://kv/set/'.length));
    store.set(key, opts.body);
    return { json: async () => ({ result: 'OK' }) };
  }
  if (u.includes('oauth2.googleapis.com/tokeninfo')) {
    // Mock Google ID-token verification for the owner portal. Any non-empty
    // id_token resolves to a fixed dev owner whose aud matches GOOGLE_CLIENT_ID.
    const idToken = new URL(u).searchParams.get('id_token');
    if (!idToken) return { ok: false, status: 400, json: async () => ({ error: 'missing' }) };
    return { ok: true, status: 200, json: async () => ({
      sub: 'dev-owner-1', email: 'owner@example.com', email_verified: true,
      name: 'Dev Owner', picture: '', aud: process.env.GOOGLE_CLIENT_ID,
    }) };
  }
  if (u.includes('sandbox-api.paddle.com/customers/') && u.includes('/portal-sessions')) {
    // Mock Paddle customer-portal session creation for the owner portal.
    return { ok: true, status: 200, json: async () => ({
      data: { urls: { general: { overview: 'https://sandbox-customer-portal.paddle.com/cpl_mock_session' } } },
    }) };
  }
  if (u.includes('api.hostex.io/v3/properties')) {
    return { status: 200, json: async () => ({ data: { properties: HOSTEX_PROPS } }) };
  }
  if (u.includes('api.hostex.io/v3/reservations')) {
    // Shapes mirror the real v3 payload (financial fields included) so the
    // report's Bookings & revenue section renders in the dev preview.
    const resv = (checkIn, checkOut, bookedDaysAgo, gross, commission, extra = {}) => ({
      status: 'accepted', channel_type: 'airbnb',
      check_in_date: checkIn, check_out_date: checkOut,
      booked_at: `${addDays(-bookedDaysAgo)}T09:00:00+00:00`,
      rates: { total_rate: { currency: 'IDR', amount: gross }, total_commission: { currency: 'IDR', amount: commission } },
      payment: { currency: 'IDR', total_amount: gross - commission, received_amount: gross - commission, status: 'received' },
      ...extra,
    });
    return { ok: true, status: 200, json: async () => ({ data: { reservations: [
      resv(addDays(3), addDays(9), 2, 12000000, 1860000),
      resv(addDays(21), addDays(24), 5, 5100000, 790000, { channel_type: 'direct' }),
      resv(addDays(-10), addDays(-4), 12, 7300000, 1130000),
      resv(addDays(30), addDays(33), 1, 4000000, 620000, { status: 'cancelled', cancelled_at: `${addDays(-1)}T10:00:00+00:00` }),
    ] } }) };
  }
  if (u.includes('api.hostex.io/v3/availabilities')) {
    return { json: async () => ({ data: { properties: [{ availabilities: [{ date: addDays(14), available: false }, { date: addDays(15), available: false }] }] } }) };
  }
  if (u.includes('googleapis.com/drive')) {
    // Note: api/gdrive.js builds lh3.googleusercontent.com URLs from these ids.
    // In the dev preview those 404 (fake ids) — the admin picker's onerror
    // hides broken thumbs, so dev-server testing of the picker uses the DOM
    // before image load completes, or stub at the /api/gdrive level below.
    return { json: async () => ({ files: [{ id: 'ph1' }, { id: 'ph2' }, { id: 'ph3' }] }) };
  }
  // CRM mock — used by api/notify-agents.js when CRM_BASE_URL points back at us
  if (u.includes('/__crm_mock/api/supabase')) {
    const body = JSON.parse(opts.body);
    __crmCalls.push({ kind: 'set_settings', body });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.includes('/__crm_mock/api/cron-followups')) {
    const isPreview = u.includes('preview=1');
    __crmCalls.push({ kind: 'cron-followups', preview: isPreview });
    if (isPreview) {
      return { ok: true, status: 200, json: async () => ({
        availability: {
          ran: true, enabled: true, recipients: 222, template_version: 'v3',
          preview: {
            mode: 'weekly_digest',
            template_name: 'samba_availability_digest_v3',
            sample_first_name: 'Era',
            sample_agent_id: 12,
            available_now_count: 8,
            improvements_count: 0,
            rendered_body: `Good morning Era. Your weekly Samba Rentals availability update.\n\nAvailable now:\n• *HAUS Canggu – Unit 1* (1BR Apartment · Batu Bolong, Canggu) — 27jt/mo · 270jt/yr\n• *HAUS Canggu – Unit 4* (1BR Apartment · Batu Bolong, Canggu) — 30jt/mo\n• *LaneHAUS – Unit 1* (1BR Townhouse · Pererenan) — 24jt/mo\n• *Villa Saturno* (3BR Villa · Padang Linjong, Canggu) — 40jt/mo\n\nOpening soon:\n• *Tropicana Valley – Unit B2* (1BR Villa · Tumbak Bayuh, Pererenan) — opens Jul 1 (30jt/mo)\n• *Tropicana Valley – Unit B5* (1BR Villa · Tumbak Bayuh, Pererenan) — opens Jul 15 (30jt/mo)\n• —\n\nBrowse all + share with clients: https://sambarentals.vercel.app?ref=wa_digest&aid=12\n\n10% commission · Reply STOP to mute.`,
          },
        },
      }) };
    }
    return { ok: true, status: 200, json: async () => ({
      availability: { ran: true, enabled: true, recipients: 222, event_alerts_sent: 200, intro_sent: 195,
        skipped_freq_cap: 5, skipped_opt_out: 2, errors: [], template_version: 'v3' },
    }) };
  }
  if (u.includes('mock-ics')) {
    const compact = s => s.replace(/-/g, '');
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${compact(addDays(20))}`,
      `DTEND;VALUE=DATE:${compact(addDays(28))}`,
      'SUMMARY:Reserved via iCal',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    return { ok: true, status: 200, text: async () => ics };
  }
  if (u.includes('/api/listings')) {
    const res = shimRes();
    await handlers.listings.default({ method: 'GET', headers: {}, query: {} }, res);
    return { ok: true, json: async () => res._data };
  }
  return realFetch(url, opts);
};

function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }

const handlers = {};
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
  handlers[f.replace('.js', '')] = await import(path.join(ROOT, 'api', f));
}

function shimRes(nodeRes) {
  return {
    _code: 200, _headers: {}, _data: null,
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._code = c; return this; },
    json(d) {
      this._data = d;
      if (nodeRes) { nodeRes.writeHead(this._code, { 'Content-Type': 'application/json', ...this._headers }); nodeRes.end(JSON.stringify(d)); }
      return this;
    },
    end() { if (nodeRes) { nodeRes.writeHead(this._code, this._headers); nodeRes.end(); } return this; },
    send(body) {
      // Mirrors Vercel's res.send — auto-routes string vs object
      this._data = body;
      if (nodeRes) {
        const isString = typeof body === 'string';
        const headers = { ...this._headers };
        if (!headers['Content-Type']) headers['Content-Type'] = isString ? 'text/html; charset=utf-8' : 'application/json';
        nodeRes.writeHead(this._code, headers);
        nodeRes.end(isString ? body : JSON.stringify(body));
      }
      return this;
    },
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5).replace(/\/$/, '');
      if (name === 'gdrive') {
        // Dev override: loadable placeholder thumbs so the admin cover picker
        // can be exercised visually (real media.js?source=drive builds lh3 URLs
        // from ids that don't exist in the mock).
        const photos = ['a', 'b', 'c'].map((s, i) => ({
          id: 'ph' + (i + 1),
          url: `https://picsum.photos/seed/${s}/800/600`,
          thumb: `https://picsum.photos/seed/${s}/400/300`,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ photos }));
      }
      // Old proxy endpoints folded into media.js — mirrors the vercel.json rewrites.
      const MEDIA_ALIAS = { properties: 'hostex-properties', photos: 'hostex-photos' };
      let target = name;
      if (MEDIA_ALIAS[name]) { u.searchParams.set('source', MEDIA_ALIAS[name]); target = 'media'; }
      const mod = handlers[target];
      if (!mod) { res.writeHead(404); return res.end('{"error":"no such api"}'); }
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch {}
      // rawBody is needed by api/billing.js to verify the Paddle webhook signature.
      const fakeReq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body: parsed, rawBody: body };
      return void await mod.default(fakeReq, shimRes(res));
    }
    // /l/<slug> → /api/listing-page?slug=<slug> (matches vercel.json rewrite)
    if (u.pathname.startsWith('/l/')) {
      const slug = u.pathname.slice(3);
      const fakeReq = { method: 'GET', headers: req.headers, query: { slug }, body: null };
      return void await handlers['listing-page'].default(fakeReq, shimRes(res));
    }
    // /a/<handle> and /s/<shareId> → listing-page in agent/shortlist mode.
    if (u.pathname.startsWith('/a/') || u.pathname.startsWith('/s/')) {
      const q = u.pathname.startsWith('/a/') ? { agent: u.pathname.slice(3) } : { list: u.pathname.slice(3) };
      const fakeReq = { method: 'GET', headers: req.headers, query: q, body: null };
      return void await handlers['listing-page'].default(fakeReq, shimRes(res));
    }
    // /r/<token> → listing-page in report mode (matches vercel.json rewrite).
    if (u.pathname.startsWith('/r/')) {
      const fakeReq = { method: 'GET', headers: req.headers, query: { report: u.pathname.slice(3) }, body: null };
      return void await handlers['listing-page'].default(fakeReq, shimRes(res));
    }
    let file;
    const CLEAN = { '/admin':'admin.html', '/portal':'portal.html', '/home':'home.html', '/list-property':'list-property.html', '/terms':'terms.html', '/privacy':'privacy.html', '/refund':'refund.html' };
    if (CLEAN[u.pathname]) file = CLEAN[u.pathname];
    else {
      const candidate = u.pathname.replace(/^\//, '');
      file = candidate && fs.existsSync(path.join(ROOT, 'public', candidate)) ? candidate : 'index.html';
    }
    const fp = path.join(ROOT, 'public', file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(fs.readFileSync(fp));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Seed: one custom property + a few events
await handlers.listings.default({
  method: 'POST', headers: { authorization: 'Bearer ' + process.env.DASHBOARD_PASSWORD }, query: {},
  body: { slug: 'villa-sunrise', custom: true, data: {
    name: 'Villa Sunrise', tag: 'Umalas · Canggu', location: 'https://maps.app.goo.gl/x',
    overview: 'A test custom property managed outside Hostex.',
    monthly: '35jt', yearly: '350jt', waNumber: '6281200001111', waContactName: 'Ketut',
    features: ['2 Bedrooms · 2 Bathrooms', 'Private pool'], inclusions: ['Wifi', 'Housekeeping'],
    locationHighlights: ['5-min to Umalas cafés'], folder: 'FOLDER123',
    bookedRanges: [{ from: addDays(5), to: addDays(12) }], hidden: false,
    unitType: '2BR Villa', icalUrl: 'http://mock-ics/villa.ics',
  } },
}, shimRes());
const seedEvents = [
  { event: 'page_view', agentId: 'a_seed1', newSession: true, src: 'portal' },
  { event: 'details_open', propId: '11621510', propName: 'HAUS Canggu – Unit 1', agentId: 'a_seed1' },
  { event: 'whatsapp_click', propId: 'c_villa-sunrise', propName: 'Villa Sunrise', agentId: 'a_seed1' },
  { event: 'listing_view', propId: 'c_villa-sunrise', propName: 'Villa Sunrise', agentId: 'a_seed2', newSession: true, src: 'listing' },
  { event: 'share', propId: '12552236', propName: 'Villa Saturno', agentId: 'a_seed2' },
  { event: 'photo_view', propId: '12552236', propName: 'Villa Saturno', agentId: 'a_seed2' },
];
for (const e of seedEvents) await handlers.track.default({ method: 'POST', headers: {}, query: {}, body: e }, shimRes());

// Pre-warm digest cache so /api/notify-agents has data to flip
await handlers.digest.default({ method: 'GET', headers: { authorization: 'Bearer dev_secret' }, query: { force: '1' } }, shimRes());

const PORT = Number(process.env.PORT) || 3456;
server.listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
