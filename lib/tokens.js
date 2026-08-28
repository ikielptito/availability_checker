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
