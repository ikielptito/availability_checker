// Who is calling the management cockpit? One answer for every proxy the
// cockpit talks to (statements, payroll, staff, housekeeping, maintenance),
// so a login that works on one tab works on all of them.
//
// Three kinds of credential, resolved to a role:
//   • 'admin'   — DASHBOARD_PASSWORD / ADMIN_PASSWORD (Ikiel). Everything.
//   • 'era'     — STATEMENTS_ADMIN_PASSWORD (Era's scoped password) or a
//                 WhatsApp magic-link session for a manager number. The
//                 cockpit, attributed as actor 'era'; nothing else in /admin.
//   • 'double8' — DOUBLE8_ADMIN_PASSWORD (Oli) or a magic-link session for a
//                 Double 8 partner number. The Double 8 payroll, plus a
//                 read-only view of maintenance, the schedule and the records
//                 for that entity's units (partnerScope below). Nothing else.
//
// Magic-link sessions are `d8s:<48 hex>` bearer tokens stored in KV by
// api/payroll.js; the record carries the phone and, for managers, the role.
// Records written before roles existed are Double 8 sessions.

const kvUrl = () => process.env.KV_REST_API_URL, kvToken = () => process.env.KV_REST_API_TOKEN;

export async function kvGetJson(key) {
  if (!kvUrl() || !kvToken()) return null;
  const r = await fetch(`${kvUrl()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['GET', key]]),
  });
  const out = await r.json().catch(() => null);
  const raw = Array.isArray(out) ? out[0]?.result : null;
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '');

// Numbers that may sign in to the full cockpit with a WhatsApp link, without
// a password. Era by default; MANAGER_WA_NUMS overrides (comma-separated).
export function managerNumbers() {
  const raw = process.env.MANAGER_WA_NUMS || process.env.ERA_WA_NUM || '6281246357778';
  return new Set(raw.split(',').map(digits).filter(Boolean));
}

export function adminPasswordsConfigured() {
  return !!(process.env.DASHBOARD_PASSWORD || process.env.ADMIN_PASSWORD);
}

// Resolve an Authorization header to { role, name, phone } or null.
export async function cockpitCaller(authHeader) {
  const auth = String(authHeader || '');
  if (!auth.startsWith('Bearer ')) return null;
  const cred = auth.slice('Bearer '.length);
  if (!cred) return null;
  for (const p of [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD]) {
    if (p && cred === p) return { role: 'admin', name: 'admin' };
  }
  if (process.env.STATEMENTS_ADMIN_PASSWORD && cred === process.env.STATEMENTS_ADMIN_PASSWORD) return { role: 'era', name: 'Era' };
  if (process.env.DOUBLE8_ADMIN_PASSWORD && cred === process.env.DOUBLE8_ADMIN_PASSWORD) return { role: 'double8', name: 'Oli' };
  if (/^d8s:[a-f0-9]{48}$/.test(cred)) {
    const sess = await kvGetJson(cred);
    if (!sess || !sess.phone) return null;
    const role = sess.role === 'era' ? 'era' : 'double8';
    return { role, name: role === 'era' ? 'Era' : 'Oli', phone: sess.phone };
  }
  return null;
}

// True for the logins that open the whole cockpit (Ikiel and Era). Double 8
// partners are not cockpit admins: the proxies that let them in cut every
// read down to partnerScope() and refuse every write.
export async function isCockpitAdmin(authHeader) {
  const c = await cockpitCaller(authHeader);
  return !!c && (c.role === 'admin' || c.role === 'era');
}

// The statement groups, straight from the CRM — the scope lookup needs
// them, and each proxy would otherwise carry its own copy of this call.
export async function statementGroups() {
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return [];
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const r = await fetch(`${crmBase}/api/statements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
    body: JSON.stringify({ action: 'statement_groups', payload: {} }),
  });
  const body = await r.json().catch(() => ({}));
  return Array.isArray(body?.groups) ? body.groups : [];
}

// How far a Double 8 partner can see: the units of every active
// expenses-only group their number is registered on. The password login
// carries no number and gets every expenses-only group. Ikiel and Era are
// not scoped: null. Pass the groups if the caller already fetched them.
export async function partnerScope(caller, groups) {
  if (!caller || caller.role !== 'double8') return null;
  const phone = caller.phone ? digits(caller.phone) : null;
  const mine = (Array.isArray(groups) ? groups : await statementGroups()).filter(g => g.active !== false && g.expenses_only === true
    && (!phone || (g.owner_wa_nums || []).some(n => digits(n) === phone)));
  return {
    groupKeys: new Set(mine.map(g => g.key)),
    slugs: new Set(mine.flatMap(g => g.listing_slugs || [])),
  };
}
