// End-to-end logic test: emulates Upstash REST + runs real handlers
process.env.KV_REST_API_URL = 'http://kv';
process.env.KV_REST_API_TOKEN = 't';
process.env.DASHBOARD_PASSWORD = 'pw';

const store = new Map(); // strings
const sets = new Map();  // Set
const hashes = new Map(); // Map
const lists = new Map(); // Array

function exec(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    case 'SET': store.set(a[0], a[1]); return 'OK';
    case 'INCR': { const v = (parseInt(store.get(a[0])) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'HINCRBY': {
      if (!hashes.has(a[0])) hashes.set(a[0], new Map());
      const h = hashes.get(a[0]);
      const v = (parseInt(h.get(a[1])) || 0) + parseInt(a[2]);
      h.set(a[1], String(v)); return v;
    }
    case 'HGETALL': {
      const h = hashes.get(a[0]);
      if (!h) return [];
      const out = [];
      for (const [k, v] of h) out.push(k, v);
      return out;
    }
    case 'SADD': { if (!sets.has(a[0])) sets.set(a[0], new Set()); sets.get(a[0]).add(a[1]); return 1; }
    case 'SCARD': return sets.has(a[0]) ? sets.get(a[0]).size : 0;
    case 'SUNION': { const u = new Set(); a.forEach(k => (sets.get(k) || new Set()).forEach(m => u.add(m))); return [...u]; }
    case 'LPUSH': { if (!lists.has(a[0])) lists.set(a[0], []); lists.get(a[0]).unshift(a[1]); return lists.get(a[0]).length; }
    case 'LTRIM': { const l = lists.get(a[0]) || []; lists.set(a[0], l.slice(parseInt(a[1]), parseInt(a[2]) + 1)); return 'OK'; }
    case 'LRANGE': { const l = lists.get(a[0]) || []; return l.slice(parseInt(a[1]), parseInt(a[2]) + 1); }
    default: throw new Error('unhandled op ' + op);
  }
}

const listingsMod = await import('/Users/ikiel/availability_checker/api/listings.js');
const trackMod = await import('/Users/ikiel/availability_checker/api/track.js');
const dashMod = await import('/Users/ikiel/availability_checker/api/dashboard.js');

function fakeRes() {
  return {
    code: 200, data: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }, end() { return this; },
  };
}

async function call(mod, req) {
  const res = fakeRes();
  req.headers = req.headers || {};
  req.query = req.query || {};
  await mod.default(req, res);
  return res;
}

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
  if (u.includes('/api/listings')) {
    const res = await call(listingsMod, { method: 'GET' });
    return { ok: true, json: async () => res.data };
  }
  throw new Error('unexpected fetch: ' + u);
};

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS', label);
  else { failures++; console.log('FAIL', label, extra ?? ''); }
}

// 1. Create a custom property
let r = await call(listingsMod, {
  method: 'POST',
  headers: { authorization: 'Bearer pw' },
  body: { slug: 'villa-test', custom: true, data: {
    name: 'Villa Test', tag: 'Umalas', location: 'https://maps.app.goo.gl/x',
    monthly: '35jt', yearly: '350jt', waNumber: '+62 812-0000-1111', waContactName: 'Ketut',
    features: ['2 Bedrooms', ''], inclusions: ['Wifi'], locationHighlights: [],
    folder: 'FOLDER123',
    bookedRanges: [{ from: '2026-07-01', to: '2026-07-10' }, { from: 'bad', to: 'x' }],
    hidden: false,
  } },
});
check('create custom returns ok', r.code === 200 && r.data.ok, JSON.stringify(r.data));

// 1b. Reject slug collision with Hostex listing
r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer pw' }, body: { slug: 'haus-1', custom: true, data: { name: 'X' } } });
check('rejects conflicting slug', r.code === 400);

// 1c. Reject bad auth
r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { slug: 'v2', custom: true, data: { name: 'X' } } });
check('rejects bad auth', r.code === 401);

// 2. GET returns defaults + custom
r = await call(listingsMod, { method: 'GET' });
const ls = r.data.listings;
check('GET has 15 listings', ls.length === 15, ls.length);
const cv = ls.find(l => l.slug === 'villa-test');
check('custom listing present + sanitized', cv && cv.custom === true && cv.waNumber === '628120000​1111'.replace(/​/g, '') && cv.features.length === 1 && cv.bookedRanges.length === 1, JSON.stringify(cv));

// 3. Track events
const day = new Date().toISOString().split('T')[0];
await call(trackMod, { method: 'POST', body: { event: 'page_view', agentId: 'a_one', newSession: true, src: 'portal' } });
await call(trackMod, { method: 'POST', body: { event: 'page_view', agentId: 'a_one', newSession: false, src: 'portal' } });
await call(trackMod, { method: 'POST', body: { event: 'details_open', propId: '11621510', propName: 'HAUS Canggu – Unit 1', agentId: 'a_one' } });
await call(trackMod, { method: 'POST', body: { event: 'whatsapp_click', propId: 'c_villa-test', propName: 'Villa Test', agentId: 'a_one' } });
await call(trackMod, { method: 'POST', body: { event: 'listing_view', propId: 'c_villa-test', propName: 'Villa Test', agentId: 'a_two', newSession: true, src: 'listing' } });
await call(trackMod, { method: 'POST', body: { event: 'bad event!', agentId: 'x' } }).then(res => check('rejects bad event name', res.code === 400));

check('sessions counted once per session', store.get('total:sessions') === '2', store.get('total:sessions'));
check('page_view total = 2', store.get('total:page_view') === '2');
check('pstats hash written', hashes.get(`pstats:${day}`)?.get('c_villa-test:whatsapp_click') === '1');

// 4. Dashboard, period=7d
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer pw', host: 'x.test' }, query: { period: '7d' } });
const d = r.data;
check('dashboard 200', r.code === 200);
check('totals.sessions=2', d.totals.sessions === 2, d.totals.sessions);
check('totals.whatsapp_click=1', d.totals.whatsapp_click === 1);
check('totals.listing_view=1', d.totals.listing_view === 1);
check('unique agents period=2', d.totals.unique_agents === 2, d.totals.unique_agents);
check('series length 7', d.series.length === 7);
const today = d.series[d.series.length - 1];
check('today sessions=2 agents=2', today.sessions === 2 && today.agents === 2, JSON.stringify(today));
check('properties includes 15 entries', d.properties.length === 15, d.properties.length);
const pv = d.properties.find(p => p.id === 'c_villa-test');
check('custom prop period stats', pv && pv.whatsapp_click === 1 && pv.listing_view === 1 && pv.engagement === 1, JSON.stringify(pv));
const ph = d.properties.find(p => p.id === '11621510');
check('hostex prop period stats', ph && ph.details_open === 1, JSON.stringify(ph));
check('recent events recorded', d.recent.length === 5 && d.recent[0].event === 'listing_view', d.recent.length);

// 5. Dashboard, period=all
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer pw', host: 'x.test' }, query: { period: 'all' } });
check('all-time totals match', r.data.totals.sessions === 2 && r.data.totals.details_open === 1);
const pva = r.data.properties.find(p => p.id === 'c_villa-test');
check('all-time custom prop lifetime counters', pva && pva.whatsapp_click === 1, JSON.stringify(pva));

// 6. Dashboard auth
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer nope', host: 'x.test' }, query: {} });
check('dashboard rejects bad password', r.code === 401);

// 7. Delete custom
r = await call(listingsMod, { method: 'DELETE', headers: { authorization: 'Bearer pw' }, query: { slug: 'villa-test' } });
check('delete ok', r.code === 200);
r = await call(listingsMod, { method: 'GET' });
check('custom gone after delete', r.data.listings.length === 14);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
