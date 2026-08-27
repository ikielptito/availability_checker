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
process.env.LISTING_SYNC_SECRET = process.env.LISTING_SYNC_SECRET || 'dev-sync-secret';
const __crmCalls = [];
const { statementToken: devStatementToken } = await import(path.join(ROOT, 'lib', 'tokens.js'));

// ── mock Campaign Command Center (kaya-agent-crm /api/campaigns) ──────
// Stateful enough that pause/resume/arm/launch visibly work in the UI.
const dayISO = (back) => new Date(Date.now() - back * 86400e3).toISOString();
const sparkOf = (seed) => { const o = {}; for (let i = 0; i < 14; i++) { const v = Math.max(0, Math.round(Math.sin(i / 2 + seed) * 6 + (seed % 5) + 4 - (i % 3))); if (v) o[dayISO(13 - i).slice(0, 10)] = v; } return o; };
const mockCampaigns = [
  { id: 'c-alert', key: 'availability_alert', kind: 'always_on', name: 'Availability alerts', status: 'live', goal: 'reply', pipeline: 'samba', context: 'High-signal availability changes to matched agents', schedule: { cron: 'daily 09:00-09:40 WITA, 3 waves', gate: 'HIGH_SIGNAL_MIN=3, 72h frequency' }, sent_count: 1240, delivered_count: 1180, read_count: 861, reply_count: 118, conversion_count: 0, fail_count: 34, skip_count: 402, last_run_at: dayISO(0), last_run_summary: { sent: 41, skipped: 12, errors: 0 }, spark: sparkOf(1), created_at: dayISO(80) },
  { id: 'c-digest', key: 'availability_digest', kind: 'always_on', name: 'Weekly digest', status: 'live', goal: 'reply', pipeline: 'samba', context: 'Monday availability digest — reaches every non-paused agent', schedule: { cron: 'Mondays 09:00 WITA, 3 waves' }, sent_count: 880, delivered_count: 852, read_count: 512, reply_count: 64, conversion_count: 0, fail_count: 12, skip_count: 130, last_run_at: dayISO(2), last_run_summary: { sent: 214, skipped: 30, errors: 2 }, spark: sparkOf(2), created_at: dayISO(80) },
  { id: 'c-intro', key: 'availability_intro', kind: 'always_on', name: 'First-touch intro', status: 'paused', goal: 'reply', pipeline: 'samba', context: 'Carousel intro to agents the broadcast has never reached', schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.intro_sweep_daily_cap' }, sent_count: 62, delivered_count: 58, read_count: 31, reply_count: 9, conversion_count: 0, fail_count: 3, skip_count: 0, last_run_at: dayISO(9), last_run_summary: { sent: 8, queue: 66, errors: 0 }, spark: {}, created_at: dayISO(60) },
  { id: 'c-arrivals', key: 'new_arrivals', kind: 'always_on', name: 'New arrivals', status: 'live', goal: 'reply', pipeline: 'samba', context: 'Just-went-live listings announced as a NEW-badge carousel', schedule: { cron: 'daily 09:00 WITA (wave 0), when listings went live' }, sent_count: 310, delivered_count: 300, read_count: 214, reply_count: 41, conversion_count: 0, fail_count: 4, skip_count: 55, last_run_at: dayISO(3), last_run_summary: { sent: 96, failed: 1 }, spark: sparkOf(3), created_at: dayISO(70) },
  { id: 'c-invite', key: 'account_invite', kind: 'always_on', name: 'Account invites', status: 'paused', goal: 'signup', pipeline: 'samba', context: 'Portal-account invite for dormant agents + closing-window nudge', schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.account_invite_daily_cap' }, sent_count: 48, delivered_count: 44, read_count: 26, reply_count: 7, conversion_count: 5, fail_count: 2, skip_count: 0, last_run_at: dayISO(4), last_run_summary: { sent: 10, queue: 84, errors: 0 }, spark: sparkOf(4), created_at: dayISO(30) },
  { id: 'c-viewings', key: 'viewings_announce', kind: 'always_on', name: 'Viewings announce', status: 'paused', goal: 'reply', pipeline: 'samba', context: 'One-time "Maya books viewings now" note to engaged agents', schedule: { cron: 'daily (not Mondays)', cap_setting: 'samba_availability.viewings_announce_daily_cap' }, sent_count: 0, delivered_count: 0, read_count: 0, reply_count: 0, conversion_count: 0, fail_count: 0, skip_count: 0, spark: {}, created_at: dayISO(2) },
  { id: 'c-onboard', key: 'onboarding', kind: 'always_on', name: 'Welcome / onboarding', status: 'live', goal: 'reply', pipeline: 'samba', context: 'Welcome template for newly added agents (deferred to 9am WITA)', schedule: { cron: 'daily 09:00 WITA (wave 0)' }, sent_count: 92, delivered_count: 90, read_count: 71, reply_count: 33, conversion_count: 0, fail_count: 1, skip_count: 0, last_run_at: dayISO(1), last_run_summary: { sent: 2 }, spark: sparkOf(5), created_at: dayISO(80) },
  { id: 'c-owner', key: 'owner_cold', kind: 'always_on', name: 'Owner cold outreach', status: 'paused', goal: 'reply', pipeline: 'samba', context: 'Cold intro drip to prospect villa owners (screenshot pipeline)', schedule: { cron: 'daily 09:00 WITA', cap_setting: 'owner_cold.intro_daily_cap' }, sent_count: 14, delivered_count: 13, read_count: 8, reply_count: 2, conversion_count: 0, fail_count: 1, skip_count: 0, last_run_at: dayISO(6), spark: {}, created_at: dayISO(20) },
  { id: 'c-sept', kind: 'one_off', name: 'September promo blast', status: 'complete', goal: 'reply', pipeline: 'samba', context: null, template_name: 'samba_availability_alert_v3', total_count: 74, sent_count: 71, delivered_count: 69, read_count: 47, reply_count: 12, conversion_count: 0, fail_count: 3, skip_count: 3, last_run_at: dayISO(5), spark: sparkOf(6), created_at: dayISO(5) },
  { id: 'c-sched', kind: 'one_off', name: 'Villa Saturno spotlight', status: 'scheduled', goal: 'click', pipeline: 'samba', template_name: 'samba_availability_alert_v3', total_count: 40, sent_count: 0, delivered_count: 0, read_count: 0, reply_count: 0, conversion_count: 0, fail_count: 0, skip_count: 0, scheduled_at: dayISO(-2), spark: {}, created_at: dayISO(1) },
];
const mockSettings = { enabled: true, test_agents_only: false, intro_sweep_daily_cap: 0, account_invite_daily_cap: 0, viewings_announce_daily_cap: 0, carousel_enabled: true };

// ── mock Owner Statements engine (kaya-agent-crm /api/statements) ─────
// Stateful enough that edit → publish → mark-paid visibly works in
// payouts.html, and /st/<token> + the portal Statements tab render.
const mockGroups = [
  { key: 'haus-2-4', name: 'HAUS Canggu – Units 2 & 4', sheet_file_id: 'SHEET_HAUS24', listing_slugs: ['haus-2', 'haus-4'], owner_wa_nums: ['628111111111', '628122222222'], owner_names: 'Romina & Tim', notify: true, active: true, charges_commission: true },
  { key: 'lanehaus', name: 'LaneHAUS – Units 1 & 3', sheet_file_id: 'SHEET_LANE', listing_slugs: ['lanehaus-1', 'lanehaus-3'], owner_wa_nums: [], owner_names: 'Ikiel & Guy', notify: false, active: true, charges_commission: false },
  { key: 'villa-saturno', name: 'Villa Saturno', sheet_file_id: 'SHEET_SAT', listing_slugs: ['villa-saturno'], owner_wa_nums: ['628133333333'], owner_names: 'Pedro', notify: true, active: true },
];
let mockLineId = 100;
const mockStatements = [
  { id: 1, group_key: 'haus-2-4', period: '2026-07', status: 'draft', currency: 'IDR',
    gross_total: 16800000, commission_total: 2520000, nett_total: 14280000, expenses_total: 5244750, adjustments_total: 0, payout_total: 9035250,
    era_payout_total: 9035250, needs_review: true, has_manual_edits: false, source_changed: false, discrepancy: null, hostex_snapshot: null,
    reconciliation: { checks: [
      { name: 'bookings_nett_vs_era_total (Unit 4 Haus Canggu)', ok: true, expected: 14280000, actual: 14280000 },
      { name: 'expenses_vs_era_total', ok: true, expected: 5244750, actual: 5244750 },
      { name: 'payout_vs_nett_minus_expenses', ok: false, expected: 9035250, actual: 9035251 },
    ], unparsed_rows: [{ row: 44, cells: ['Mystery transfer', '1,234,567'] }] },
    source_tab: 'July', parsed_at: dayISO(0), published_at: null, published_by: null, notified_at: null, paid_at: null, proof_path: null,
    paid_total: 0, payments: [],
    lines: [
      { id: 1, kind: 'booking', unit_name: 'Unit 2 Haus Canggu', position: 0, guest_name: 'Becki', stay_dates: '25 July - 11 Aug', platform: 'Airbnb', nights: 6, amount: 0, commission: 0, nett: 0, flags: ['zero_amount'], edited: false },
      { id: 2, kind: 'booking', unit_name: 'Unit 4 Haus Canggu', position: 1, guest_name: 'Genevieve', stay_dates: '1-18 July', platform: 'Direct Booking', nights: 18, amount: 16800000, commission: 2520000, nett: 14280000, flags: [], edited: false },
      { id: 3, kind: 'expense', position: 2, expense_date: '01 Jul 2026', description: 'Internet', amount: 168750, flags: [], edited: false },
      { id: 4, kind: 'expense', position: 3, expense_date: '02 Jul 2026', description: 'Advance payment Sebastian', amount: 2460000, flags: [], edited: false },
      { id: 5, kind: 'expense', position: 4, expense_date: '25 Jul 2026', description: 'Electricity Expense unit 2', amount: 503500, flags: [], edited: false },
      { id: 6, kind: 'expense', position: 5, expense_date: '31 Jul 2026', description: 'Laundry unit 2 + 4', amount: 2112500, flags: ['missing_date'], edited: false },
    ] },
  { id: 2, group_key: 'lanehaus', period: '2026-07', status: 'published', currency: 'IDR',
    gross_total: 21000000, commission_total: 3150000, nett_total: 17850000, expenses_total: 2400000, adjustments_total: 0, payout_total: 15450000,
    era_payout_total: 15450000, needs_review: false, has_manual_edits: false, source_changed: false, discrepancy: null,
    hostex_snapshot: { period: '2026-07', days_in_month: 31, units: {}, group: { nights_sold: 41, occupancy_pct: 66, reservations: 5, channels: { Airbnb: 28, Direct: 13 }, adr: 435000 } },
    reconciliation: { checks: [], unparsed_rows: [] },
    source_tab: 'July', parsed_at: dayISO(2), published_at: dayISO(1), published_by: 'admin', notified_at: null, paid_at: null, proof_path: null,
    paid_total: 0, payments: [],
    lines: [
      { id: 10, kind: 'booking', unit_name: 'LaneHAUS – Unit 1', position: 0, guest_name: 'Hunter', stay_dates: '3-14 July', platform: 'Airbnb', nights: 11, amount: 12000000, commission: 1800000, nett: 10200000, flags: [], edited: false },
      { id: 11, kind: 'booking', unit_name: 'LaneHAUS – Unit 3', position: 1, guest_name: 'Sasha', stay_dates: '10-25 July', platform: 'Direct Booking', nights: 15, amount: 9000000, commission: 1350000, nett: 7650000, flags: [], edited: false },
      { id: 12, kind: 'expense', position: 2, expense_date: '05 Jul 2026', description: 'Pool maintenance', amount: 900000, flags: [], edited: false },
      { id: 13, kind: 'expense', position: 3, expense_date: '28 Jul 2026', description: 'Electricity', amount: 1500000, flags: [], edited: false },
    ] },
  { id: 3, group_key: 'villa-saturno', period: '2026-06', status: 'paid', currency: 'IDR',
    gross_total: 36460000, commission_total: 5469000, nett_total: 30991000, expenses_total: 4700000, adjustments_total: 0, payout_total: 26291000,
    era_payout_total: 26291000, needs_review: false, has_manual_edits: false, source_changed: false, discrepancy: null,
    hostex_snapshot: { period: '2026-06', days_in_month: 30, units: {}, group: { nights_sold: 26, occupancy_pct: 87, reservations: 4, channels: { Airbnb: 20, 'Booking.com': 6 }, adr: 1050000 } },
    reconciliation: { checks: [], unparsed_rows: [] },
    source_tab: 'June', parsed_at: dayISO(30), published_at: dayISO(28), published_by: 'admin', notified_at: dayISO(28), paid_at: dayISO(26), proof_path: 'villa-saturno/2026-06.jpg',
    paid_total: 26291000,
    payments: [{ id: 900, amount: 26291000, paid_at: dayISO(26), note: 'BCA transfer', proof_path: 'villa-saturno/2026-06.jpg' }],
    lines: [
      { id: 20, kind: 'booking', unit_name: null, position: 0, guest_name: 'Long stay (27 nights)', stay_dates: '1-28 June', platform: 'Airbnb', nights: 27, amount: 27850000, commission: 4177500, nett: 23672500, flags: [], edited: false },
      { id: 21, kind: 'booking', unit_name: null, position: 1, guest_name: 'Mia', stay_dates: '28-30 June', platform: 'Booking.com', nights: 2, amount: 8610000, commission: 1291500, nett: 7318500, flags: [], edited: false },
      { id: 22, kind: 'expense', position: 2, expense_date: '30 Jun 2026', description: 'Housekeeping + pool + utilities', amount: 4700000, flags: [], edited: false },
    ] },
];
function stTotals(st) {
  const t = { gross_total: 0, commission_total: 0, nett_total: 0, expenses_total: 0, adjustments_total: 0 };
  for (const l of st.lines) {
    if (l.kind === 'booking') { t.gross_total += +l.amount || 0; t.commission_total += +l.commission || 0; t.nett_total += +l.nett || 0; }
    else if (l.kind === 'expense') t.expenses_total += +l.amount || 0;
    else t.adjustments_total += +l.amount || 0;
  }
  Object.assign(st, t, { payout_total: t.nett_total - t.expenses_total + t.adjustments_total });
}
function stripLines(st) { const { lines, payments, ...rest } = st; return { ...rest, statement_groups: mockGroups.find(g => g.key === st.group_key) || null }; }
function stRecomputePayments(st) {
  const cleared = (st.payments || []).filter(p => p.status !== 'returned');
  st.paid_total = cleared.reduce((a, p) => a + (+p.amount || 0), 0);
  if (['published', 'partial', 'paid'].includes(st.status)) {
    const settled = cleared.length && st.paid_total >= st.payout_total - 1;
    st.status = settled ? 'paid' : cleared.length ? 'partial' : 'published';
    st.paid_at = settled ? cleared[cleared.length - 1].paid_at : null;
  }
}
function mockStatementsApi({ action, payload = {} }) {
  const find = (id) => mockStatements.find(s => s.id === +id);
  const monthLabel = (p) => { const [y, m] = String(p).split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
  if (action === 'statement_groups') return { status: 200, body: { groups: mockGroups } };
  if (action === 'statement_group_patch') {
    const g = mockGroups.find(x => x.key === payload.key);
    if (g) Object.assign(g, payload.fields || {});
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_list') {
    const rows = mockStatements.map(stripLines);
    const out = rows.filter(s => s.status === 'published' || s.status === 'partial');
    return { status: 200, body: { statements: rows, outstanding: { count: out.length, total: out.reduce((a, s) => a + Math.max(0, s.payout_total - (s.paid_total || 0)), 0) } } };
  }
  if (action === 'statement_detail') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    return { status: 200, body: { statement: stripLines(st), lines: st.lines, payments: (st.payments || []).map(p => ({ ...p, proof_url: p.proof_path ? 'https://picsum.photos/seed/proof/700/900' : null })), period_label: monthLabel(st.period), token: devStatementToken(st.group_key, st.period) } };
  }
  if (action === 'statement_record_payment') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    if (!['published', 'partial'].includes(st.status)) return { status: 400, body: { error: `cannot record a payment on a ${st.status} statement` } };
    st.payments.push({ id: ++mockLineId, amount: +payload.amount || 0, paid_at: new Date().toISOString(), note: payload.note || null, proof_path: payload.fileBase64 ? 'mock/proof.jpg' : null });
    stRecomputePayments(st);
    return { status: 200, body: { paid_total: st.paid_total, balance: st.payout_total - st.paid_total, status: st.status } };
  }
  if (action === 'statement_delete_payment') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    st.payments = st.payments.filter(p => p.id !== +payload.payment_id);
    stRecomputePayments(st);
    return { status: 200, body: { paid_total: st.paid_total, balance: st.payout_total - st.paid_total, status: st.status } };
  }
  if (action === 'statement_payments') {
    const st = find(payload.id);
    return { status: 200, body: { payments: (st?.payments || []).map(p => ({ ...p, proof_url: p.proof_path ? 'https://picsum.photos/seed/proof/700/900' : null })) } };
  }
  if (action === 'statement_export_data') {
    const group = mockGroups.find(g => g.key === payload.group_key);
    if (!group) return { status: 404, body: { error: 'Unknown group' } };
    const statements = mockStatements
      .filter(s => s.group_key === group.key && ['published', 'partial', 'paid'].includes(s.status)
        && (!payload.year || s.period.startsWith(payload.year))
        && (!payload.from || s.period >= payload.from)
        && (!payload.to || s.period <= payload.to))
      .map(s => ({ ...s, period_label: monthLabel(s.period) }));
    return { status: 200, body: { group, statements } };
  }
  if (action === 'statement_payment_returned') {
    const st = find(payload.id);
    const p = st?.payments.find(x => x.id === +payload.payment_id);
    if (!p) return { status: 404, body: { error: 'Payment not found' } };
    if (payload.undo) { p.status = 'cleared'; p.return_note = null; }
    else { p.status = 'returned'; p.return_note = payload.note || null; }
    stRecomputePayments(st);
    return { status: 200, body: { paid_total: st.paid_total, balance: st.payout_total - st.paid_total, status: st.status } };
  }
  if (action === 'statement_patch_line' || action === 'statement_add_line' || action === 'statement_delete_line') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    if (st.status !== 'draft') return { status: 409, body: { error: `Statement is ${st.status} — lines are frozen` } };
    if (action === 'statement_patch_line') {
      const l = st.lines.find(x => x.id === +payload.line_id);
      if (l) { Object.assign(l, payload.fields || {}); l.edited = true; }
    } else if (action === 'statement_add_line') {
      st.lines.push({ id: ++mockLineId, position: st.lines.length, flags: ['manual'], edited: true, ...payload.fields });
    } else {
      st.lines = st.lines.filter(x => x.id !== +payload.line_id);
    }
    st.has_manual_edits = true;
    stTotals(st);
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_sync') return { status: 200, body: { groups: mockGroups.map(g => ({ group: g.key, tabs: 1, created: 0, updated: 0, unchanged: 1, kept_edits: 0, discrepancies: 0 })) } };
  if (action === 'statement_reparse') { const st = find(payload.id); if (st) { st.has_manual_edits = false; st.source_changed = false; } return { status: 200, body: { ok: true } }; }
  if (action === 'statement_publish') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    if (st.status !== 'draft') return { status: 400, body: { error: `cannot publish a ${st.status} statement` } };
    stTotals(st);
    st.status = 'published'; st.published_at = new Date().toISOString(); st.published_by = 'admin';
    st.hostex_snapshot = { period: st.period, days_in_month: 31, units: {}, group: { nights_sold: 24, occupancy_pct: 39, reservations: 3, channels: { Airbnb: 13, Direct: 11 }, adr: 595000 } };
    if (payload.notify_owner === false) st.notified_at = new Date().toISOString();
    return { status: 200, body: { ok: true, payout_total: st.payout_total } };
  }
  if (action === 'statement_unpublish') {
    const st = find(payload.id);
    if (!st || st.status !== 'published' || st.notified_at) return { status: 400, body: { error: 'cannot unpublish' } };
    st.status = 'draft'; st.published_at = null; st.hostex_snapshot = null;
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_mark_paid') {
    const st = find(payload.id);
    if (!st || !['published', 'partial'].includes(st.status)) return { status: 400, body: { error: 'cannot mark paid' } };
    st.payments.push({ id: ++mockLineId, amount: st.payout_total - st.paid_total, paid_at: new Date().toISOString(), note: 'Paid in full', proof_path: null });
    stRecomputePayments(st);
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_upload_proof') { const st = find(payload.id); if (st) st.proof_path = `${st.group_key}/${st.period}-dev.jpg`; return { status: 200, body: { ok: true, proof_path: st?.proof_path } }; }
  if (action === 'statement_proof_url') return { status: 200, body: { url: 'https://picsum.photos/seed/proof/700/900' } };
  if (action === 'statement_notify_preview') {
    const q = mockStatements.filter(s => s.status === 'published' && !s.notified_at);
    return { status: 200, body: { queued: q.length, sent: 0, failed: 0, plan: q.map(s => ({ statement: `${s.group_key} ${s.period}`, to: mockGroups.find(g => g.key === s.group_key)?.owner_wa_nums || [], payout: 'IDR ' + s.payout_total.toLocaleString(), url: `/st/${devStatementToken(s.group_key, s.period)}` })) } };
  }
  if (action === 'statement_public') {
    const st = mockStatements.find(s => s.group_key === payload.group_key && s.period === payload.period && ['published', 'partial', 'paid'].includes(s.status));
    if (!st) return { status: 404, body: { error: 'No published statement for that period' } };
    const g = mockGroups.find(x => x.key === st.group_key);
    return { status: 200, body: {
      group: { key: g.key, name: g.name, owner_names: g.owner_names, payout_account: g.payout_account || null },
      period: st.period, period_label: monthLabel(st.period), status: st.status, currency: 'IDR',
      totals: { gross: st.gross_total, commission: st.commission_total, nett: st.nett_total, expenses: st.expenses_total, adjustments: st.adjustments_total, payout: st.payout_total, paid: st.paid_total || 0, balance: st.payout_total - (st.paid_total || 0) },
      paid_at: st.paid_at, published_at: st.published_at, hostex: st.hostex_snapshot,
      lines: st.lines,
      payments: (st.payments || []).map(p => ({ amount: p.amount, paid_at: p.paid_at, note: p.note, proof_url: p.proof_path ? 'https://picsum.photos/seed/proof/700/900' : null })),
    } };
  }
  return { status: 400, body: { error: 'unsupported action: ' + action } };
}
function mockCampaignsApi({ action, payload = {} }) {
  const find = (id) => mockCampaigns.find(c => c.id === id);
  if (action === 'campaign_center') {
    return { status: 200, body: {
      campaigns: mockCampaigns.filter(c => !c.archived_at),
      kpis: { reach_30d: 208, sent_30d: 934, read_rate_30d: 68, replied_30d: 74, conversions_30d: 5 },
      spend: { spentToday: 2.41, cap: 13.2, base: 10, rollover: 3.2, remaining: 10.79 },
      suppression: { total: 296, opted_out: 14, dead_numbers: 9, meta_capped: 3, monthly_only: 11, auto_responders: 2 },
      tiers: { champion: 12, active: 58, new: 34, warm: 71, dormant: 95, unset: 26 },
      templates: [
        { name: 'samba_availability_alert_v3', status: 'APPROVED', language: 'en', quality: 'GREEN' },
        { name: 'samba_availability_digest_v3', status: 'APPROVED', language: 'en', quality: 'GREEN' },
        { name: 'samba_weekly_carousel_v2', status: 'APPROVED', language: 'en', quality: 'YELLOW' },
        { name: 'samba_account_invite_v1', status: 'PENDING', language: 'en', quality: null },
        { name: 'samba_viewings_v1', status: 'APPROVED', language: 'en', quality: 'GREEN' },
        { name: 'samba_agent_welcome_v3', status: 'APPROVED', language: 'en', quality: 'GREEN' },
        { name: 'samba_owner_cold_v3', status: 'REJECTED', language: 'en', quality: null },
      ],
      settings: mockSettings,
      cron_log: [
        { at: dayISO(0), kind: 'daily', agents: 296, alerts: 41, digests: 0, intros: 0, invites: 0, sequences: 3, welcomes: 2, spend: 2.41, campaigns_repaired: 0, campaigns_launched: 0 },
        { at: dayISO(1), kind: 'wave2', alerts: 12, digests: 0, errors: 0 },
        { at: dayISO(2), kind: 'daily', agents: 294, alerts: 0, digests: 214, sequences: 1, spend: 4.02 },
      ],
      cron_utc: { waves: ['01:00', '01:20', '01:40'], hourly_sweep: ':05' },
      portal: { src_of_key: { availability_alert: 'wa_alert', availability_digest: 'wa_digest', account_invite: 'acct_invite' }, src: { wa_alert: { total: 412, last30: 168 }, wa_digest: { total: 388, last30: 122 }, acct_invite: { total: 61, last30: 24 } }, signup: { shown_total: 402, done_total: 57 } },
    } };
  }
  if (action === 'campaign_detail') {
    const c = find(payload.id);
    if (!c) return { status: 404, body: { error: 'campaign not found' } };
    const series = []; for (let i = 29; i >= 0; i--) { const sent = Math.max(0, Math.round(Math.sin(i / 3) * 8 + 9)); series.push({ date: dayISO(i).slice(0, 10), sent, read: Math.round(sent * 0.66), failed: i % 9 === 0 ? 1 : 0 }); }
    const names = ['Wayan Sujana', 'Made Artini', 'Ketut Wira', 'Putu Eka', 'Nyoman Sari', 'Agus Pratama', 'Dewi Lestari', 'Rizky Ramadhan', 'Komang Ayu', 'Gede Bagus', 'Sari Indah', 'Yoga Mahendra'];
    return { status: 200, body: {
      campaign: c,
      registry: c.key ? { control: c.schedule?.cap_setting ? { cap: { key: 'samba_availability', path: c.schedule.cap_setting.split('.').pop() } } : { master: true } } : null,
      series,
      templates: [{ name: c.template_name || 'samba_availability_alert_v3', sent: c.sent_count, tracked: c.sent_count, read: c.read_count, failed: c.fail_count, read_rate: c.sent_count ? Math.round(c.read_count / c.sent_count * 100) : null }],
      recipients: names.map((n, i) => ({ id: 100 + i, name: n, tier: ['active', 'warm', 'dormant', 'new'][i % 4], status: ['replied', 'read', 'delivered', 'sent', 'failed'][i % 5], portal_account: i % 3 === 0, error: i % 5 === 4 ? '131026 — Recipient is not a valid WhatsApp user' : null, at: dayISO(i % 10), portal_views: i * 3, portal_wa_clicks: i % 4 })),
      recipients_total: names.length, replied_in_window: 3,
      failures: c.fail_count ? [{ reason: 'Number not on WhatsApp (131026)', count: Math.max(1, Math.round(c.fail_count * 0.7)) }, { reason: 'Meta per-user marketing cap (131049)', count: Math.max(1, Math.round(c.fail_count * 0.3)) }] : [],
      events: [
        { type: 'created', actor: 'system', detail: { self_healed: false }, created_at: c.created_at },
        ...(c.status === 'paused' ? [{ type: 'paused', actor: 'admin', detail: null, created_at: dayISO(3) }] : []),
        ...(c.last_run_at ? [{ type: 'completed', actor: 'cron', detail: c.last_run_summary, created_at: c.last_run_at }] : []),
      ],
      portal: c.key === 'availability_alert' ? { src: 'wa_alert', visits_total: 412, visits_30d: 168 } : null,
      note: 'message-level data covers the last 90 days; campaign counters are lifetime',
    } };
  }
  if (action === 'campaign_control') {
    const { op, id, value } = payload;
    if (op === 'kill_all') { mockSettings.enabled = false; return { status: 200, body: { ok: true, settings: mockSettings } }; }
    if (op === 'enable_sending') { mockSettings.enabled = true; return { status: 200, body: { ok: true, settings: mockSettings } }; }
    if (op === 'test_mode') { mockSettings.test_agents_only = !!value; return { status: 200, body: { ok: true, settings: mockSettings } }; }
    const c = find(id);
    if (!c) return { status: 404, body: { error: 'campaign not found' } };
    if (op === 'pause') c.status = 'paused';
    else if (op === 'resume') c.status = c.kind === 'always_on' ? 'live' : 'scheduled';
    else if (op === 'arm') { c.status = 'live'; if (c.schedule?.cap_setting) mockSettings[c.schedule.cap_setting.split('.').pop()] = value; }
    else if (op === 'disarm') { c.status = 'paused'; if (c.schedule?.cap_setting) mockSettings[c.schedule.cap_setting.split('.').pop()] = 0; }
    else if (op === 'set_cap') { if (c.schedule?.cap_setting) mockSettings[c.schedule.cap_setting.split('.').pop()] = value; }
    else if (op === 'cancel') c.status = 'cancelled';
    else if (op === 'archive') c.archived_at = new Date().toISOString();
    else return { status: 400, body: { error: 'unknown op: ' + op } };
    return { status: 200, body: { ok: true, campaign: c } };
  }
  if (action === 'audience_preview') {
    const f = payload.filter || {};
    const narrowed = (f.tiers?.length ? 0.4 : 1) * (f.portal_account === 'no' ? 0.8 : f.portal_account === 'yes' ? 0.2 : 1) * (f.last_reply_days ? 0.5 : 1) * (f.not_received_category ? 0.7 : 1);
    const eligible = Math.max(3, Math.round(219 * narrowed));
    return { status: 200, body: {
      breakdown: { total: 296, opted_out: 14, dead_number: 9, capped_24h: 3, frequency_limited: 17, auto_responder: 2, test_excluded: 0, filtered_out: 296 - 45 - eligible < 0 ? 0 : 296 - 45 - eligible, eligible, in_window: Math.round(eligible * 0.18) },
      sample: ['Wayan Sujana', 'Made Artini', 'Ketut Wira', 'Putu Eka', 'Nyoman Sari', 'Agus Pratama', 'Dewi Lestari', 'Rizky R.', 'Komang Ayu', 'Gede Bagus'].slice(0, 10).map((n, i) => ({ id: 100 + i, name: n, tier: 'active', in_window: i % 5 === 0 })),
      over_cap: eligible > 200 ? eligible - 200 : 0, max_recipients: 200,
    } };
  }
  if (action === 'launch_broadcast') {
    if (payload.phase === 'draft') {
      const id = 'c-new-' + Date.now().toString(36);
      mockCampaigns.unshift({ id, kind: 'one_off', name: payload.name, status: 'draft', goal: payload.goal, template_name: payload.template_name || null, broadcast_msg: payload.message || null, scheduled_at: payload.scheduled_at || null, total_count: 57, sent_count: 0, delivered_count: 0, read_count: 0, reply_count: 0, conversion_count: 0, fail_count: 0, skip_count: 0, spark: {}, created_at: new Date().toISOString() });
      return { status: 200, body: { campaign_id: id, confirm_token: 'tok-' + id, recipients: 57, in_window: 11, breakdown: { eligible: 57, in_window: 11 }, sample: ['Wayan Sujana', 'Made Artini', 'Ketut Wira'], estimate_usd: payload.template_name ? 2.28 : 0, test_agents_only: mockSettings.test_agents_only } };
    }
    if (payload.phase === 'execute') {
      const c = find(payload.campaign_id);
      if (!c) return { status: 404, body: { error: 'campaign not found' } };
      if (payload.confirm_token !== 'tok-' + c.id) return { status: 409, body: { error: 'confirm token mismatch — the audience changed since the preview; draft again' } };
      if (c.scheduled_at && Date.parse(c.scheduled_at) > Date.now()) { c.status = 'scheduled'; return { status: 200, body: { ok: true, scheduled_for: c.scheduled_at } }; }
      c.status = 'complete'; c.sent_count = 55; c.skip_count = 2; c.delivered_count = 52; c.read_count = 30;
      return { status: 200, body: { ok: true, sent: 55, skipped: 2, failed: 0, errors: [] } };
    }
    return { status: 400, body: { error: 'phase must be "draft" or "execute"' } };
  }
  return { status: 400, body: { error: 'unknown action: ' + action } };
}

// ── mock redis ──
const store = new Map(), sets = new Map(), hashes = new Map(), lists = new Map();
function exec(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    // Honours NX (needed by kvWithLock); still ignores EX — no TTL in the mock.
    case 'SET': {
      if (a.includes('NX') && store.has(a[0])) return null;
      store.set(a[0], a[1]);
      return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of a) { if (store.delete(k)) n++; sets.delete(k); hashes.delete(k); lists.delete(k); } return n; }
    case 'INCR': { const v = (parseInt(store.get(a[0])) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'HINCRBY': { if (!hashes.has(a[0])) hashes.set(a[0], new Map()); const h = hashes.get(a[0]); const v = (parseInt(h.get(a[1])) || 0) + parseInt(a[2]); h.set(a[1], String(v)); return v; }
    case 'HGETALL': { const h = hashes.get(a[0]); if (!h) return []; const o = []; for (const [k, v] of h) o.push(k, v); return o; }
    case 'SADD': { if (!sets.has(a[0])) sets.set(a[0], new Set()); sets.get(a[0]).add(a[1]); return 1; }
    case 'SCARD': return sets.has(a[0]) ? sets.get(a[0]).size : 0;
    case 'SMEMBERS': return sets.has(a[0]) ? [...sets.get(a[0])] : [];
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
  if (u.includes('/__crm_mock/api/campaigns')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'campaigns', body });
    const out = mockCampaignsApi(body);
    return { ok: out.status === 200, status: out.status, json: async () => out.body };
  }
  if (u.includes('/__crm_mock/api/statements')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'statements', body });
    const out = mockStatementsApi(body);
    return { ok: out.status === 200, status: out.status, json: async () => out.body };
  }
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
      // Mirrors Vercel's res.send — auto-routes Buffer vs string vs object
      this._data = body;
      if (nodeRes) {
        const isBuf = Buffer.isBuffer(body);
        const isString = typeof body === 'string';
        const headers = { ...this._headers };
        if (!headers['Content-Type']) headers['Content-Type'] = isBuf ? 'application/octet-stream' : isString ? 'text/html; charset=utf-8' : 'application/json';
        nodeRes.writeHead(this._code, headers);
        nodeRes.end(isBuf || isString ? body : JSON.stringify(body));
      }
      return this;
    },
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

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
    // /st/<token> → listing-page in statement mode (matches vercel.json rewrite).
    if (u.pathname.startsWith('/st/')) {
      const fakeReq = { method: 'GET', headers: req.headers, query: { statement: u.pathname.slice(4) }, body: null };
      return void await handlers['listing-page'].default(fakeReq, shimRes(res));
    }
    let file;
    const CLEAN = { '/admin':'admin.html', '/campaigns':'campaigns.html', '/payouts':'payouts.html', '/portal':'portal.html', '/home':'list-property.html', '/for-agents':'for-agents.html', '/list-property':'list-property.html', '/terms':'terms.html', '/privacy':'privacy.html', '/refund':'refund.html' };
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
