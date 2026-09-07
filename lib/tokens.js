// Signed link tokens shared with the CRM (kaya-agent-crm). Both apps derive
// the same signatures from LISTING_SYNC_SECRET, so either side can mint a
// link the other verifies without any storage. This module is the portal's
// single signer — api/portal.js and api/listing-page.js both import it
// (they used to carry their own inline copies).
//
// KEEP IN SYNC with the CRM's lib/tokens.js — same algorithms, same message
// formats. There is no shared package (two repos, no build step), so the two
// copies are the contract.
//
//   /r/<slug>~<sig16>                weekly report  (sig over the bare slug)
//   /st/<groupKey>.<period>~<sig16>  monthly payout statement
//
// The statement message is prefixed 'stmt:' so a weekly token can never be
// replayed as a statement token (and vice versa), and it embeds the period so
// one leaked link exposes exactly one month of one property group.

import crypto from 'crypto';

const hmac16 = (msg) =>
  crypto.createHmac('sha256', process.env.LISTING_SYNC_SECRET || '')
    .update(String(msg)).digest('hex').slice(0, 16);

const safeEq = (a, b) => {
  if (String(a).length !== String(b).length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); }
  catch { return false; }
};

export function reportSig(slug) {
  return hmac16(slug);
}
export function reportToken(slug) {
  return `${slug}~${reportSig(slug)}`;
}
// → slug, or null when the token doesn't verify.
export function verifyReportToken(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('~');
  if (i < 0) return null;
  const slug = t.slice(0, i).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!slug || !safeEq(t.slice(i + 1), reportSig(slug))) return null;
  return slug;
}

//   /r/<slug1+slug2+…>~<sig16>       portfolio report (sig over 'portfolio:' + the joined list)
//
// One weekly message per owner instead of one per villa: a multi-villa owner
// (Ikiel's number took 12 identical pings on 7 Sep 2026) gets a single link
// to a page that lists every villa. Slugs are sorted so the same set always
// signs the same way, and the 'portfolio:' prefix keeps a single-villa token
// from ever verifying as a one-villa portfolio (or the reverse).
const cleanSlugs = (slugs) => [...new Set((slugs || []).map(s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean))].sort();
export function portfolioSig(slugs) {
  return hmac16('portfolio:' + cleanSlugs(slugs).join('+'));
}
export function portfolioToken(slugs) {
  const list = cleanSlugs(slugs);
  return `${list.join('+')}~${portfolioSig(list)}`;
}
// → slugs[] (2 or more), or null when the token doesn't verify.
export function verifyPortfolioToken(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('~');
  if (i < 0 || !t.slice(0, i).includes('+')) return null;
  const list = cleanSlugs(t.slice(0, i).split('+'));
  if (list.length < 2 || !safeEq(t.slice(i + 1), portfolioSig(list))) return null;
  return list;
}

export function statementSig(groupKey, period) {
  return hmac16(`stmt:${groupKey}:${period}`);
}
export function statementToken(groupKey, period) {
  return `${groupKey}.${period}~${statementSig(groupKey, period)}`;
}
// → { groupKey, period }, or null when the token doesn't verify.
export function verifyStatementToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)\.(\d{4}-\d{2})~([0-9a-f]+)$/);
  if (!m) return null;
  const [, groupKey, period, sig] = m;
  if (!safeEq(sig, statementSig(groupKey, period))) return null;
  return { groupKey, period };
}

export function inviteSig(groupKey) {
  return hmac16(`invite:${groupKey}`);
}
// Owner-onboarding invite: /portal?invite=<groupKey>~<sig16>. Whoever opens
// it and signs in with Google claims the group's catalog listings — refused
// if another account already holds them, so the link is single-owner.
export function inviteToken(groupKey) {
  return `${groupKey}~${inviteSig(groupKey)}`;
}
export function verifyInviteToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)~([0-9a-f]+)$/);
  if (!m) return null;
  if (!safeEq(m[2], inviteSig(m[1]))) return null;
  return m[1];
}

export function previewSig(groupKey) {
  return hmac16(`preview:${groupKey}`);
}
// Admin read-only preview: /portal?preview=<groupKey>~<sig16> renders the
// owner portal exactly as that group's owner will see it, without touching
// ownership. Mintable only by whoever holds the shared secret.
export function previewToken(groupKey) {
  return `${groupKey}~${previewSig(groupKey)}`;
}
export function verifyPreviewToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)~([0-9a-f]+)$/);
  if (!m) return null;
  if (!safeEq(m[2], previewSig(m[1]))) return null;
  return m[1];
}

export function tukangSig(id) {
  return hmac16(`job:${id}`);
}
// The job sheet a tukang opens from WhatsApp: /j/<id>~<sig16>. Deliberately
// NOT scoped to a property group, because the tukang has no relationship to
// the owner and the link must carry only this one job: what is broken, where,
// the photos, and the agreed time. It grants no approval powers — unlike the
// owner's /m/ link, this one is read-only.
export function tukangToken(id) {
  return `${id}~${tukangSig(id)}`;
}
// → id, or null when the token doesn't verify.
export function verifyTukangToken(token) {
  const t = String(token || '');
  const m = t.match(/^(\d+)~([0-9a-f]+)$/);
  if (!m) return null;
  if (!safeEq(m[2], tukangSig(m[1]))) return null;
  return parseInt(m[1], 10);
}

export function maintenanceSig(groupKey, id) {
  return hmac16(`maint:${groupKey}:${id}`);
}
// Maintenance item, no login: /m/<groupKey>.<id>~<sig16>. Scoped to one item
// of one property group, so a forwarded link exposes nothing else. The page
// it opens can approve or decline — the signature IS the authorisation, same
// stance as the statement links Maya already sends.
export function maintenanceToken(groupKey, id) {
  return `${groupKey}.${id}~${maintenanceSig(groupKey, id)}`;
}
// → { groupKey, id }, or null when the token doesn't verify.
export function verifyMaintenanceToken(token) {
  const t = String(token || '');
  const m = t.match(/^([a-z0-9-]+)\.(\d+)~([0-9a-f]+)$/);
  if (!m) return null;
  const [, groupKey, id, sig] = m;
  if (!safeEq(sig, maintenanceSig(groupKey, id))) return null;
  return { groupKey, id: parseInt(id, 10) };
}

// ── The management calendar feed ────────────────────────────────────
// One unguessable URL Ikiel and Era subscribe to from Google Calendar. It
// carries no personal data beyond villa names and staff first names, but it
// is the whole operation's schedule, so it is signed rather than public.
export function calendarSig() {
  return hmac16('hk-calendar:v1');
}
// Era's day page: /today/<sig>?d=YYYY-MM-DD. Whole-operation view, so
// signed rather than public; one static signature, like the calendar.
export function todaySig() {
  return hmac16('era-today:v1');
}
export function verifyTodaySig(sig) {
  return !!sig && safeEq(sig, todaySig());
}
export function verifyCalendarSig(sig) {
  return !!sig && safeEq(sig, calendarSig());
}

// ── A single housekeeping record, as a shareable PDF ────────────────
// /api/housekeeping?record=<type>.<id>~<sig16>. Signed so a link Era
// forwards to an owner or to Airbnb opens without a login and exposes
// exactly one record.
//
// The "owner" audience is the same record printed for the owner from their
// portal: it carries no housekeeper name. The audience is part of the
// signature, so an owner link cannot be edited into the staff version.
export function recordSig(type, id, aud = '') {
  return hmac16(`rec:${type}:${id}${aud ? ':' + aud : ''}`);
}
export function recordToken(type, id, aud = '') {
  return `${type}.${id}${aud ? '~' + aud : ''}~${recordSig(type, id, aud)}`;
}
export function verifyRecordToken(token) {
  const m = String(token || '').match(/^(handover|inspection)\.(\d{1,10})(?:~(owner))?~([0-9a-f]{16})$/);
  if (!m) return null;
  const [, type, id, aud, sig] = m;
  if (!safeEq(sig, recordSig(type, id, aud || ''))) return null;
  return { type, id: Number(id), aud: aud || '' };
}

