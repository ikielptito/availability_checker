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
process.env.DOUBLE8_ADMIN_PASSWORD = process.env.DOUBLE8_ADMIN_PASSWORD || 'double8-dev';
process.env.LISTING_SYNC_SECRET = process.env.LISTING_SYNC_SECRET || 'dev-sync-secret';
const __crmCalls = [];
const { statementToken: devStatementToken } = await import(path.join(ROOT, 'lib', 'tokens.js'));

// ── mock Campaign Command Center (kaya-agent-crm /api/campaigns) ──────
// Stateful enough that pause/resume/arm/launch visibly work in the UI.
const dayISO = (back) => new Date(Date.now() - back * 86400e3).toISOString();
// Dev-only: DEV_FIXTURES=<dir> lets a capture session replace any mock CRM
// answer with a JSON file, so guide screenshots can show real photos and
// hand-picked states without editing the mocks. Looked up in order as
// <action>@<type>.<id>.json, <action>@<id>.json, <action>@<slug>.json, <action>.json.
const FIXTURES = process.env.DEV_FIXTURES || '';
function fixture(action, payload = {}) {
  if (!FIXTURES) return null;
  const id = payload.id ?? payload.item_id;
  const names = [
    payload.type != null && id != null ? `${action}@${payload.type}.${id}` : null,
    id != null ? `${action}@${id}` : null,
    payload.slug ? `${action}@${payload.slug}` : null,
    action,
  ].filter(Boolean);
  for (const n of names) {
    const fp = path.join(FIXTURES, n + '.json');
    if (fs.existsSync(fp)) return { status: 200, body: JSON.parse(fs.readFileSync(fp, 'utf8')) };
  }
  return null;
}
const sparkOf = (seed) => { const o = {}; for (let i = 0; i < 14; i++) { const v = Math.max(0, Math.round(Math.sin(i / 2 + seed) * 6 + (seed % 5) + 4 - (i % 3))); if (v) o[dayISO(13 - i).slice(0, 10)] = v; } return o; };
const mockCampaigns = [
  { id: 'c-alert', key: 'availability_alert', kind: 'always_on', name: 'Availability alerts', status: 'live', goal: 'reply', pipeline: 'samba', context: 'High-signal availability changes to matched agents', schedule: { cron: 'daily 09:00-09:40 WITA, 3 waves', gate: 'HIGH_SIGNAL_MIN=3, 72h frequency' }, sent_count: 1240, delivered_count: 1180, read_count: 861, reply_count: 118, conversion_count: 0, fail_count: 34, skip_count: 402, last_run_at: dayISO(0), last_run_summary: { sent: 41, skipped: 12, errors: 0 }, spark: sparkOf(1), created_at: dayISO(80) },
  { id: 'c-digest', key: 'availability_digest', kind: 'always_on', name: 'Weekly digest', status: 'live', goal: 'reply', pipeline: 'samba', context: 'Monday availability digest, reaches every non-paused agent', schedule: { cron: 'Mondays 09:00 WITA, 3 waves' }, sent_count: 880, delivered_count: 852, read_count: 512, reply_count: 64, conversion_count: 0, fail_count: 12, skip_count: 130, last_run_at: dayISO(2), last_run_summary: { sent: 214, skipped: 30, errors: 2 }, spark: sparkOf(2), created_at: dayISO(80) },
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

import { maintenanceToken, tukangToken } from '../lib/tokens.js';

// ── mock Maintenance engine (kaya-agent-crm /api/maintenance) ────────
let mockMaintId = 40;
const mockMaint = [
  { id: 41, group_key: 'haus-2-4', slug: 'haus-2', unit_label: 'haus-2', title: 'Bathroom wall paint touch-up',
    description: 'Paint flaking above the shower in the guest bathroom.', photos: ['41/a.jpg'], status: 'new',
    requires_approval: true, estimated_cost: null, actual_cost: null, currency: 'IDR', urgency: 'normal',
    reported_by_wa: '6281246357778', reported_by_name: 'Era', reported_at: dayISO(1), created_at: dayISO(1),
    thread: [{ at: dayISO(1), who: 'Era', text: 'Haus unit 2 bathroom wall needs paint touch up' }],
    followup_count: 0, next_followup_at: null, promised_date: null },
  { id: 42, group_key: 'lanehaus', slug: 'lanehaus-1', unit_label: 'lanehaus-1', title: 'Broken kitchen chair',
    description: 'One of the four dining chairs has a cracked leg.', photos: [], status: 'pending_approval',
    requires_approval: true, estimated_cost: 450000, actual_cost: null, currency: 'IDR', urgency: 'normal',
    reported_by_name: 'Era', reported_at: dayISO(4), created_at: dayISO(4), published_at: dayISO(3),
    notified_at: dayISO(3), thread: [], followup_count: 0, next_followup_at: null },
  { id: 43, group_key: 'villa-saturno', slug: 'villa-saturno', unit_label: null, title: 'Pool pump service',
    description: null, photos: [], status: 'approved', requires_approval: true, estimated_cost: 1200000,
    currency: 'IDR', urgency: 'normal', reported_by_name: 'Era', reported_at: dayISO(9), created_at: dayISO(9),
    published_at: dayISO(8), notified_at: dayISO(8), approved_at: dayISO(6), approved_by: 'owner (link)',
    staff_notified_at: dayISO(6), followup_count: 2, next_followup_at: dayISO(-1), promised_date: null,
    thread: [{ at: dayISO(2), who: 'Era', text: 'waiting for the part' }] },
  { id: 44, group_key: 'haus-2-4', slug: 'haus-4', unit_label: 'haus-4', title: 'Aircon filter clean',
    description: null, photos: [], status: 'done', requires_approval: false, estimated_cost: 250000,
    actual_cost: 250000, currency: 'IDR', urgency: 'low', reported_by_name: 'Era', reported_at: dayISO(20),
    created_at: dayISO(20), published_at: dayISO(19), notified_at: dayISO(19), completed_at: dayISO(12),
    completion_note: 'Filters cleaned on both units.', done_notified_at: dayISO(12), thread: [], followup_count: 1 },
  { id: 45, group_key: 'tropicana-b2356', slug: 'tropicana-b3', unit_label: 'tropicana-b3', title: 'Bedroom AC not cooling',
    description: 'The bedroom unit runs but only blows warm air. The quote covers a gas refill and a filter service.', photos: [], status: 'pending_approval',
    requires_approval: true, estimated_cost: 850000, actual_cost: null, currency: 'IDR', urgency: 'normal',
    reported_by_wa: '6287832988120', reported_by_name: 'Oli', reported_at: dayISO(1), created_at: dayISO(1), published_at: dayISO(0), notified_at: dayISO(0),
    thread: [{ at: dayISO(1), who: 'Oli', text: 'Tropicana B3 — bedroom AC not cooling' }], followup_count: 0, next_followup_at: null },
  { id: 46, group_key: 'tropicana-b2356', slug: 'tropicana-b5', unit_label: 'tropicana-b5', title: 'Pool pump making a grinding noise',
    description: null, photos: [], status: 'approved', requires_approval: true, estimated_cost: 1200000, currency: 'IDR', urgency: 'normal',
    reported_by_name: 'Ikiel', reported_at: dayISO(6), created_at: dayISO(6), published_at: dayISO(5), notified_at: dayISO(5), approved_at: dayISO(4), approved_by: 'owner (link)',
    staff_notified_at: dayISO(4), followup_count: 0, next_followup_at: null, promised_date: null, thread: [] },
  { id: 47, group_key: 'tropicana-b2356', slug: 'tropicana-b2', unit_label: 'tropicana-b2', title: 'Front gate lock replaced',
    description: null, photos: [], status: 'done', requires_approval: false, estimated_cost: 350000, actual_cost: 350000, currency: 'IDR', urgency: 'low',
    reported_by_name: 'Oli', reported_at: dayISO(14), created_at: dayISO(14), published_at: dayISO(13), notified_at: dayISO(13), completed_at: dayISO(9),
    completion_note: 'New lock fitted, two keys left in the unit.', done_notified_at: dayISO(9), thread: [], followup_count: 0 },
];
// ── mock Staff registry (kaya-agent-crm /api/staff) ──────────────────
// Deliberately seeded a person short of full coverage: haus-1 and the
// Tropicana A units have no housekeeper here, so the coverage warning in
// the Team tab is visible offline instead of only in production.
let mockStaffId = 8;
const mockStaff = [
  { id: 1, name: 'Gede Baglug', wa_num: '6285847163053', roles: ['housekeeper'], trades: [], slugs: ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 2, name: 'Naomi', wa_num: '6282341079324', roles: ['housekeeper'], trades: [], slugs: ['villa-saturno'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 3, name: 'Ita', wa_num: '6285704892074', roles: ['housekeeper'], trades: [], slugs: ['tropicana-b4'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 4, name: 'Ana', wa_num: '6281237692282', roles: ['housekeeper'], trades: [], slugs: ['lanehaus-1', 'lanehaus-3'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 5, name: 'Putu', wa_num: '6287862135047', roles: ['housekeeper'], trades: [], slugs: ['haus-2', 'haus-4', 'haus-5'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 6, name: 'Dian', wa_num: '6281236744565', roles: ['pool', 'tukang'], trades: ['pool', 'plumbing', 'electrical', 'paint'], slugs: [], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: 'Pool across the portfolio; also plumbing, small electrical and paint touch-ups.' },
  { id: 7, name: 'Wayan', wa_num: '6282236164194', roles: ['pool'], trades: ['pool'], slugs: ['villa-saturno', 'astanine'], pay_type: 'salaried', monthly_rate: null, can_report: true, active: true, notes: null },
  { id: 8, name: 'BTC Electric', wa_num: '6282339711019', roles: ['tukang'], trades: ['aircon', 'electrical'], slugs: [], pay_type: 'per_job', monthly_rate: null, can_report: true, active: true, notes: 'Buana Teknik Chiamando. Vendor, invoiced per job, never on payroll.' },
];
function mockStaffApi({ action, payload = {} }) {
  // Mirrors normalizeWa in the CRM's lib/staff.js, so the "0813…" duplicate
  // case is reproducible offline.
  const digits = (s) => {
    const d = String(s || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('620')) return '62' + d.slice(3);
    if (d.startsWith('0')) return '62' + d.slice(1);
    if (/^8(1|2|3|7|9)\d{8,10}$/.test(d)) return '62' + d;
    return d;
  };
  if (action === 'staff_list') {
    let out = mockStaff.filter(s => !payload.active_only || s.active);
    if (payload.role) out = out.filter(s => (s.roles || []).includes(payload.role));
    return { status: 200, body: { staff: out } };
  }
  if (action === 'staff_upsert') {
    const id = payload.id ? +payload.id : null;
    const wa = digits(payload.wa_num);
    let row = id ? mockStaff.find(s => s.id === id) : mockStaff.find(s => s.wa_num === wa);
    const merged = !id && !!row;
    const previousName = merged ? row.name : null;
    if (!row) {
      if (!payload.name) return { status: 500, body: { error: 'Name is required' } };
      if (wa.length < 9) return { status: 500, body: { error: 'That WhatsApp number looks too short' } };
      row = { id: ++mockStaffId, can_report: true, active: true, monthly_rate: null, notes: null };
      mockStaff.push(row);
    }
    for (const k of ['name', 'roles', 'trades', 'slugs', 'pay_type', 'notes']) {
      if (payload[k] == null) continue;
      // On a merge, lists are unioned: a blank quick-add form must not wipe
      // the villas someone is already assigned to.
      row[k] = merged && Array.isArray(payload[k])
        ? [...new Set([...(row[k] || []), ...payload[k]])]
        : payload[k];
    }
    if (wa) row.wa_num = wa;
    if (payload.active != null) row.active = !!payload.active;
    return { status: 200, body: { ok: true, created: !id && !merged, merged, previous_name: previousName, staff: row } };
  }
  if (action === 'staff_deactivate') {
    const row = mockStaff.find(s => s.id === +payload.id);
    if (row) row.active = false;
    return { status: 200, body: { ok: true, staff: row || null } };
  }
  if (action === 'staff_for_slug') {
    const staff = mockStaff.filter(s => s.active
      && (!payload.role || (s.roles || []).includes(payload.role))
      && (!(s.slugs || []).length || (s.slugs || []).includes(payload.slug)));
    return { status: 200, body: { staff } };
  }
  return { status: 400, body: { error: `Unknown action: ${action}` } };
}

// ── mock Payroll (kaya-agent-crm /api/payroll) ───────────────────────
// One run shaped like Era's real September sheet, with the Putu/Ita roster
// mismatch and the "Era from Romi" unclassified line so the review chrome
// is visible offline.
let mockPayrollLineId = 100, mockPayrollPayId = 1;
const prLine = (payee, description, category, amount, slugs, extra = {}) => ({
  id: ++mockPayrollLineId, run_id: 1, category, payee, person_name: category === 'salary' ? payee : null,
  staff_id: extra.staff_id || null, role: extra.role || null, description, slugs, amount, flags: extra.flags || [], edited: false, source_row: mockPayrollLineId, position: mockPayrollLineId,
});
const mockPayrollLines = [
  // Era's real September 2026 sheet (read 4 Sep 2026), so guide screenshots match production.
  prLine('Era', 'Villa manager', 'salary', 11500000, [], { role: 'manager', flags: ['not_in_registry'] }),
  prLine('Ana', 'HK Astanine', 'salary', 2500000, ['astanine'], { staff_id: 4, role: 'housekeeper' }),
  prLine('Wayan', 'Pool Astanine', 'salary', 850000, ['astanine'], { staff_id: 7, role: 'pool' }),
  prLine('Ana', 'HK Lane Haus', 'salary', 1500000, ['lanehaus-1', 'lanehaus-3'], { staff_id: 4, role: 'housekeeper' }),
  prLine('Ketut Buda', 'Gardener Lanehaus', 'salary', 800000, ['lanehaus-1', 'lanehaus-3'], { staff_id: 9, role: 'gardener' }),
  prLine('Dian', 'Pool Lanehaus', 'salary', 1000000, ['lanehaus-1', 'lanehaus-3'], { staff_id: 6, role: 'pool' }),
  prLine('Putu', 'HK A5', 'salary', 1000000, ['tropicana-a5'], { staff_id: 5, role: 'housekeeper', flags: ['roster_mismatch', 'registry:Ita'] }),
  prLine('Dian', 'Pool A5 & garden', 'salary', 800000, ['tropicana-a5'], { staff_id: 6, role: 'pool' }),
  prLine('Putu', 'HK A4', 'salary', 1000000, ['tropicana-a4'], { staff_id: 5, role: 'housekeeper', flags: ['roster_mismatch', 'registry:Ita'] }),
  prLine('Dian', 'Pool A4 & garden', 'salary', 800000, ['tropicana-a4'], { staff_id: 6, role: 'pool' }),
  prLine('Putu', 'HK B4', 'salary', 1000000, ['tropicana-b4'], { staff_id: 5, role: 'housekeeper', flags: ['roster_mismatch', 'registry:Ita'] }),
  prLine('Dian', 'Pool B4 & garden', 'salary', 800000, ['tropicana-b4'], { staff_id: 6, role: 'pool' }),
  prLine('Naomi', 'HK Saturno', 'salary', 2000000, ['villa-saturno'], { staff_id: 2, role: 'housekeeper' }),
  prLine('Yoga', 'Gardener Saturno', 'salary', 800000, ['villa-saturno'], { staff_id: 10, role: 'gardener' }),
  prLine('Wayan', 'Pool Saturno', 'salary', 600000, ['villa-saturno'], { staff_id: 7, role: 'pool' }),
  prLine('Internet', 'Haus Canggu', 'utility', 337500, ['haus-1', 'haus-2', 'haus-4', 'haus-5']),
  prLine('Internet', 'Lane Haus', 'utility', 557500, ['lanehaus-1', 'lanehaus-3']),
  prLine('Advance Payment', 'Haus Canggu', 'advance', 6920000, ['haus-1', 'haus-2', 'haus-4', 'haus-5']),
  prLine('CA management', 'A4,5 & B4', 'building_fee', 2028000, ['tropicana-a4', 'tropicana-a5', 'tropicana-b4']),
  prLine('Era from Romi', 'Haus Unit 2&4', 'receipt', 2500000, ['haus-2', 'haus-4']),
  prLine('Water and garbage', 'Lane and Saturday', 'utility', 650000, ['lanehaus-1', 'lanehaus-3', 'villa-saturno']),
  prLine('Laundry', 'Lane, Haus, Tropicana, Astanine, Saturno', 'laundry', 5000000, ['lanehaus-1', 'lanehaus-3', 'haus-1', 'haus-2', 'haus-4', 'haus-5', 'tropicana-a4', 'tropicana-a5', 'tropicana-b4', 'astanine', 'villa-saturno']),
  prLine('Balance from August', 'Samba', 'balance', 10000000, []),
  prLine('Petty Cash', 'Samba', 'petty_cash', 2000000, []),
  prLine('Electricity', 'Haus, lane and Tropicana', 'utility', 12500000, ['haus-1', 'haus-2', 'haus-4', 'haus-5', 'lanehaus-1', 'lanehaus-3', 'tropicana-a4', 'tropicana-a5', 'tropicana-b4']),
];
const MOCK_MEMO = new Set(['balance', 'receipt', 'petty_cash']);
const mockPayrollPayments = [];
const mockPayrollRuns = [{
  id: 1, period: '2026-09', status: 'draft', salary_total: 0, other_total: 0, run_total: 0, era_total: 54943000, paid_total: 0,
  reconciliation: { checks: [
    { name: 'total_matches_sheet', ok: true, expected: 54943000, actual: 54943000 },
    { name: 'no_vendors_on_payroll', ok: true, actual: [] },
    { name: 'sheet_matches_registry', ok: false, actual: ['Putu paid for tropicana-a5; registry: Ita', 'Putu paid for tropicana-a4; registry: Ita', 'Putu paid for tropicana-b4; registry: Ita'] },
    { name: 'housekeeping_covered', ok: true, actual: [] },
    { name: 'no_unparsed_rows', ok: true, actual: 0 },
  ], unparsed_rows: [] },
  needs_review: true, period_flags: ['period_from_balance_hint'], source_hash: 'x', source_tab: 'Sheet1', parsed_at: '2026-09-04T01:00:00Z',
  has_manual_edits: false, source_changed: false, published_at: null, published_by: null, paid_at: null,
}, {
  id: 2, period: '2026-08', status: 'paid', salary_total: 26950000, other_total: 27993000, run_total: 54943000, era_total: 54943000, paid_total: 54943000,
  reconciliation: { checks: [], unparsed_rows: [] }, needs_review: false, period_flags: [], source_tab: 'August', parsed_at: '2026-08-04T01:00:00Z',
  has_manual_edits: false, source_changed: false, published_at: '2026-08-05T01:00:00Z', published_by: 'admin', paid_at: '2026-08-06T01:00:00Z',
}];
function mockPayrollTotals(run) {
  const lines = mockPayrollLines.filter(l => l.run_id === run.id);
  run.salary_total = lines.filter(l => l.category === 'salary').reduce((a, l) => a + l.amount, 0);
  run.run_total = lines.filter(l => !MOCK_MEMO.has(l.category)).reduce((a, l) => a + l.amount, 0);
  run.memo_total = lines.filter(l => MOCK_MEMO.has(l.category)).reduce((a, l) => a + l.amount, 0);
  run.other_total = run.run_total - run.salary_total;
  const paid = mockPayrollPayments.filter(p => p.run_id === run.id).reduce((a, p) => a + p.amount, 0);
  run.paid_total = paid;
  if (['published', 'partial', 'paid'].includes(run.status)) run.status = paid >= run.run_total - 1 && paid > 0 ? 'paid' : paid > 0 ? 'partial' : 'published';
}
mockPayrollTotals(mockPayrollRuns[0]);
// Double 8: salary rows from the DOUBLE EIGHT ledger (August 2026, real).
mockPayrollLines.push(
  { ...prLine('Gede Baglug', 'Housekeeping Salary', 'salary', 3800000, ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], { staff_id: 1, role: 'housekeeper' }), run_id: 3 },
  { ...prLine('Pool Salary', 'Pool Salary', 'salary', 2400000, ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], { role: 'pool', flags: ['not_in_registry'] }), run_id: 3 },
  { ...prLine('Gardener salary CA &4 unit @200k', 'Gardener salary CA &4 unit @200k', 'salary', 1700000, ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], { role: 'gardener', flags: ['not_in_registry'] }), run_id: 3 },
);
mockPayrollRuns.push({
  id: 3, entity: 'double8', period: '2026-08', status: 'draft', salary_total: 0, other_total: 0, run_total: 0, memo_total: 0, era_total: null, paid_total: 0,
  reconciliation: { checks: [{ name: 'salary_lines_found', ok: true, actual: 3 }], unparsed_rows: [] }, needs_review: true, period_flags: [],
  source_tab: 'Tropicana B statement · August 2026', source_statement_id: 64, parsed_at: '2026-09-04T03:00:00Z', has_manual_edits: false, source_changed: false, published_at: null, published_by: null, paid_at: null,
});
for (const r of mockPayrollRuns) { if (!r.entity) r.entity = 'samba'; }
mockPayrollTotals(mockPayrollRuns[2]);
function mockPayrollApi({ action, payload = {} }) {
  const scope = payload.entity_scope || null;
  const entity = scope || payload.entity || 'samba';
  const run = mockPayrollRuns.find(r => r.id === +payload.id);
  if (run && scope && run.entity !== scope) return { status: 403, body: { error: 'This run is outside your access' } };
  if (action === 'payroll_entities') return { status: 200, body: { entities: [{ key: 'samba', name: 'Samba' }, { key: 'double8', name: 'Double 8' }].filter(e => !scope || e.key === scope), scope } };
  if (action === 'payroll_feedback') { __crmCalls.push({ kind: 'payroll_feedback', body: payload }); return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_list') {
    const runs = mockPayrollRuns.filter(r => r.entity === entity);
    const outstanding = runs.filter(r => ['published', 'partial'].includes(r.status));
    return { status: 200, body: { entity, runs, outstanding: { count: outstanding.length, total: outstanding.reduce((a, r) => a + r.run_total - r.paid_total, 0) } } };
  }
  if (action === 'payroll_sync') return { status: 200, body: { tabs: 1, created: 0, updated: 0, unchanged: 1, kept_edits: 0, discrepancies: 0, skipped: 'unchanged since last sync', runs: [] } };
  if (!run) return { status: 404, body: { error: 'Run not found' } };
  if (action === 'payroll_detail') {
    const lines = mockPayrollLines.filter(l => l.run_id === run.id);
    const payments = mockPayrollPayments.filter(p => p.run_id === run.id);
    const by = new Map();
    for (const l of lines) {
      if (MOCK_MEMO.has(l.category)) continue;
      const r = by.get(l.payee) || { payee: l.payee, staff_id: l.staff_id, category: l.category, role: l.role, lines: [], total: 0, paid: 0, slugs: new Set() };
      r.lines.push(l); r.total += l.amount; l.slugs.forEach(s => r.slugs.add(s)); by.set(l.payee, r);
    }
    for (const p of payments) { const r = by.get(p.payee); if (r) r.paid += p.amount; }
    const payees = [...by.values()].map(r => ({ ...r, slugs: [...r.slugs], balance: r.total - r.paid }));
    const props = new Map();
    for (const l of lines) {
      if (MOCK_MEMO.has(l.category)) continue;
      const slugs = l.slugs.length ? l.slugs : ['samba'];
      for (const s of slugs) { const r = props.get(s) || { slug: s, total: 0, salary: 0, other: 0, lines: 0 }; r.total += l.amount / slugs.length; if (l.category === 'salary') r.salary += l.amount / slugs.length; else r.other += l.amount / slugs.length; r.lines++; props.set(s, r); }
    }
    const properties = [...props.values()];
    const statements = mockGroups.filter(g => g.active).map(g => ({
      group_key: g.key, name: g.name, slugs: g.listing_slugs, allocated: g.listing_slugs.reduce((a, s) => a + (props.get(s)?.total || 0), 0),
      statement: mockStatements.find(s => s.group_key === g.key && s.period === run.period) ? { id: mockStatements.find(s => s.group_key === g.key && s.period === run.period).id, status: 'published', expenses_total: 1250000 } : null,
    })).filter(g => g.allocated > 0 || g.statement);
    return { status: 200, body: { run, lines, payments, payees, properties, statements: run.entity === 'double8' ? [] : statements, entity: { key: run.entity, name: run.entity === 'double8' ? 'Double 8' : 'Samba' }, period_label: run.period } };
  }
  if (action === 'payroll_publish') { run.status = 'published'; run.published_at = new Date().toISOString(); run.published_by = 'admin'; return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_unpublish') { run.status = 'draft'; run.published_at = null; return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_patch_line') {
    const l = mockPayrollLines.find(x => x.id === +payload.line_id); if (l) Object.assign(l, payload.fields, { edited: true }); run.has_manual_edits = true; mockPayrollTotals(run); return { status: 200, body: { ok: true } };
  }
  if (action === 'payroll_add_line') { const f = payload.fields; mockPayrollLines.push({ ...prLine(f.payee, f.description, f.category, f.amount, f.slugs || [], { flags: ['manual'] }), run_id: run.id, edited: true }); run.has_manual_edits = true; mockPayrollTotals(run); return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_delete_line') { const i = mockPayrollLines.findIndex(x => x.id === +payload.line_id); if (i >= 0) mockPayrollLines.splice(i, 1); run.has_manual_edits = true; mockPayrollTotals(run); return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_reimport') { run.has_manual_edits = false; return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_record_payment') { mockPayrollPayments.push({ id: mockPayrollPayId++, run_id: run.id, payee: payload.payee, staff_id: payload.staff_id, amount: +payload.amount, paid_at: payload.paid_at || new Date().toISOString(), note: payload.note || null, proof_url: null, status: 'cleared' }); mockPayrollTotals(run); return { status: 200, body: { ok: true } }; }
  if (action === 'payroll_delete_payment') { const i = mockPayrollPayments.findIndex(p => p.id === +payload.payment_id); if (i >= 0) mockPayrollPayments.splice(i, 1); mockPayrollTotals(run); return { status: 200, body: { ok: true } }; }
  return { status: 400, body: { error: `Unknown action: ${action}` } };
}

// ── mock Housekeeping (kaya-agent-crm /api/housekeeping) ─────────────
// The schedule is derived with the REAL planTasks rules against a fake
// calendar, so what renders offline is what production would produce rather
// than a hand-written list that can drift from the scheduler.
import { planTasks, projectRounds } from '../../kaya-agent-crm/lib/housekeeping.js';
import { DEFAULT_STANDARD } from '../../kaya-agent-crm/lib/housekeeping-readiness.js';
import { UNITS as CATALOG_UNITS } from '../lib/catalog.js';

const hkToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const hkPlus = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
let mockHkTasks = null;
let mockHkId = 0;
let mockHkUnits = [];
const mockStandards = {};
// Handover checks: one of each outcome, attached to the first three past
// or present turnover/pre-arrival/deep-clean tasks the planner produced.
function mockReadiness() {
  const cands = mockHkTasks.filter(t => ['turnover', 'pre_arrival', 'deep_clean'].includes(t.kind)).slice(0, 3);
  const shapes = [
    { status: 'pass', flags: [], checks: [{ spot: 'living', ok: true }, { spot: 'kitchen', ok: true }], photos: ['a', 'b', 'c', 'd', 'e'] },
    { status: 'flagged', flags: ['living: sofa has no cover', 'restock: sabun habis'], restock: 'sabun habis', checks: [{ spot: 'living', ok: false, note: 'sofa has no cover' }, { spot: 'kitchen', ok: true }], photos: ['a', 'b', 'c', 'd'] },
    { status: 'awaiting', flags: [], checks: [], photos: [] },
  ];
  return cands.map((t, i) => ({ id: i + 1, task_id: t.id, slug: t.slug, kind: t.kind, guest_in_date: t.guest_in_date, by_staff_id: t.assigned_staff_id,
    ...shapes[i], photo_count: shapes[i].photos.length, asked_at: new Date().toISOString(), closed_at: null }));
}
// Real per-villa cleaning days, mirroring the property_care seed.
const mockCare = {
  'haus-1': [1, 4], 'haus-2': [2, 5], 'haus-4': [3, 6], 'haus-5': [1, 4],
  'lanehaus-1': [1, 4], 'lanehaus-3': [2, 5], 'villa-saturno': [1, 4],
  'tropicana-a4': [1, 4], 'tropicana-a5': [2, 5], 'tropicana-b4': [3, 6],
  'tropicana-b2': [1, 4], 'tropicana-b3': [2, 5], 'tropicana-b5': [3, 6], 'tropicana-b6': [1, 4],
};

function mockHkBuild() {
  const today = hkToday();
  const stay = (ci, co, vac = null) => ({
    check_in: ci, check_out: co,
    nights: Math.round((Date.parse(co) - Date.parse(ci)) / 86400e3),
    vacant_days_before: vac,
  });
  // A portfolio with one of each situation, so every rule shows up.
  const units = [
    { slug: 'haus-1', stays: [stay(hkPlus(today, -40), hkPlus(today, 2))] },            // leaving soon
    { slug: 'haus-2', stays: [stay(hkPlus(today, -5), hkPlus(today, 40))] },            // long tenancy
    { slug: 'haus-4', stays: [stay(hkPlus(today, -60), hkPlus(today, -30)),
                              stay(hkPlus(today, 3), hkPlus(today, 60), 33)] },         // arriving after a gap
    { slug: 'villa-saturno', stays: [stay(hkPlus(today, -50), hkPlus(today, -25))] },   // empty a while
    { slug: 'tropicana-b4', stays: [] },                                                // never booked
  ];
  mockHkUnits = units;
  const planned = planTasks({ today, units, careDays: mockCare, lastInspection: { 'haus-2': hkPlus(today, -6) },
    lastDeepClean: { 'haus-1': hkPlus(today, -85), 'haus-4': hkPlus(today, -100) } });
  const cover = (slug) => mockStaff.find(s => s.active && (s.roles || []).includes('housekeeper') && (s.slugs || []).includes(slug));
  return planned.map(t => {
    const who = cover(t.slug);
    return {
      id: ++mockHkId, slug: t.slug, task_date: t.task_date, origin_date: t.origin_date, kind: t.kind,
      status: t.task_date < hkToday() ? 'done' : 'planned',
      assigned_staff_id: who?.id ?? null, staff: who || null,
      same_day: !!t.same_day, guest_out_date: t.guest_out_date ?? null,
      guest_in_date: t.guest_in_date ?? null, notified_at: null, notes: null, photos: [],
    };
  });
}

function mockHousekeepingApi({ action, payload = {} }) {
  const fx = fixture(action, payload); if (fx) return fx;
  if (!mockHkTasks) mockHkTasks = mockHkBuild();
  const names = Object.fromEntries(CATALOG_UNITS.map(u => [u.slug, u.name.replace(/\s*[–—]\s*/g, ' · ')]));
  if (action === 'hk_schedule') {
    const today = hkToday();
    // Sorted the way PostgREST's order=task_date.asc,slug.asc returns it.
    const tasks = mockHkTasks
      .map(t => ({ ...t, staff: t.assigned_staff_id ? mockStaff.find(s => s.id === t.assigned_staff_id) || null : null }))
      .sort((a, b) => a.task_date.localeCompare(b.task_date) || a.slug.localeCompare(b.slug));
    return { status: 200, body: { from: today, to: hkPlus(today, 21), today, tasks, names,
      unassigned: tasks.filter(t => !t.assigned_staff_id).length } };
  }
  if (action === 'hk_stays') {
    if (!mockHkTasks) mockHkTasks = mockHkBuild();
    const today = hkToday();
    const named = mockHkUnits.map(u => ({ ...u, stays: u.stays.map((s, i) => ({ ...s, status: 'accepted', channel: 'airbnb', guest: ['Aleksandr', 'Lucinda', 'Jeremie', 'Felicitas'][i % 4] })) }));
    return { status: 200, body: { from: payload.from || today, to: payload.to || hkPlus(today, 30), units: named } };
  }
  if (action === 'hk_generate') {
    const before = mockHkTasks.length;
    mockHkTasks = mockHkBuild();
    return { status: 200, body: { planned: mockHkTasks.length, created: Math.max(0, mockHkTasks.length - before), today: hkToday() } };
  }
  if (action === 'hk_patch') {
    const t = mockHkTasks.find(x => x.id === +payload.id);
    if (t) Object.assign(t, payload.fields || {});
    return { status: 200, body: { ok: true, task: t || null } };
  }
  if (action === 'hk_status') {
    const t = mockHkTasks.find(x => x.id === +payload.id);
    if (t) t.status = payload.status;
    return { status: 200, body: { ok: true } };
  }
  if (action === 'hk_inspections') return { status: 200, body: { inspections: [] } };
  if (action === 'hk_readiness') return { status: 200, body: { checks: mockReadiness() } };
  if (action === 'hk_records') {
    const today = hkToday();
    const recs = mockReadiness().map(c => ({ type: 'handover', id: c.id, slug: c.slug, kind: c.kind, status: c.status, date: hkPlus(today, -c.id * 9), at: hkPlus(today, -c.id * 9) + 'T03:00:00Z', staff: 'Putu', photo_count: c.photo_count, checks: c.checks, flags: c.flags, restock: c.restock || null, guest_in_date: c.guest_in_date, task_id: c.task_id }));
    recs.push({ type: 'inspection', id: 1, slug: 'villa-saturno', kind: 'inspection', status: 'raised', date: hkPlus(today, -3), at: hkPlus(today, -3) + 'T05:00:00Z', staff: 'Naomi', photo_count: 5, findings: 'jamur di plafon kamar mandi', item_ids: [2], task_id: null });
    recs.push({ type: 'inspection', id: 2, slug: 'haus-2', kind: 'inspection', status: 'clear', date: hkPlus(today, -20), at: hkPlus(today, -20) + 'T05:00:00Z', staff: 'Putu', photo_count: 6, findings: null, item_ids: [], task_id: null });
    return { status: 200, body: { from: payload.from, to: payload.to, names, records: recs.sort((a, b) => b.at.localeCompare(a.at)) } };
  }
  if (action === 'hk_record_export') {
    const c = mockReadiness().find(x => x.id === +payload.id) || mockReadiness()[0];
    const today = hkToday();
    const rec = payload.type === 'inspection'
      ? { type: 'inspection', id: +payload.id, slug: 'villa-saturno', kind: 'inspection', status: 'raised', date: hkPlus(today, -3), at: hkPlus(today, -3) + 'T05:00:00Z', staff: 'Naomi', findings: 'jamur di plafon kamar mandi', checks: [], flags: [], restock: null, guest_in_date: null }
      : { type: 'handover', id: c.id, slug: c.slug, kind: c.kind, status: c.status, date: hkPlus(today, -c.id * 9), at: hkPlus(today, -c.id * 9) + 'T03:00:00Z', staff: 'Putu', checks: c.checks, flags: c.flags, restock: c.restock || null, guest_in_date: c.guest_in_date, findings: null };
    return { status: 200, body: { record: rec, villa: names[rec.slug] || rec.slug, photo_urls: ['https://picsum.photos/seed/a/800/600.jpg', 'https://picsum.photos/seed/b/800/600.jpg', 'https://picsum.photos/seed/c/600/800.jpg', 'https://picsum.photos/seed/d/800/600.jpg'], repairs: payload.type === 'inspection' ? [{ title: 'Ceiling mould, master bathroom', status: 'approved' }] : [] } };
  }
  if (action === 'hk_record_photos') {
    const svg = (t) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#d9d2c4"/><text x="150" y="158" font-size="26" text-anchor="middle" fill="#444">${t}</text></svg>`);
    const n = payload.type === 'inspection' ? 5 : 4;
    return { status: 200, body: { id: +payload.id, type: payload.type, photo_urls: Array.from({ length: n }, (_, i) => svg('photo ' + (i + 1))) } };
  }
  if (action === 'hk_readiness_photos') {
    const r = mockReadiness().find(x => x.id === +payload.id);
    const svg = (t) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#dcd6c8"/><text x="100" y="105" font-size="22" text-anchor="middle" fill="#444">${t}</text></svg>`);
    return { status: 200, body: { id: +payload.id, photo_urls: (r?.photos || []).map((_, i) => svg('photo ' + (i + 1))), checks: r?.checks || [], flags: r?.flags || [] } };
  }
  if (action === 'hk_standard') {
    const row = mockStandards[payload.slug];
    const kit = DEFAULT_STANDARD.kit.map(k => ({ ...k, present: row?.kit?.find(x => x.key === k.key)?.present ?? null, note: null }));
    return { status: 200, body: { standard: { slug: payload.slug, kit, consumables: DEFAULT_STANDARD.consumables, photo_spots: DEFAULT_STANDARD.photo_spots, notes: row?.notes || null, audited_at: row?.audited_at || null, audited_by: row?.audited_by || null } } };
  }
  if (action === 'hk_standard_save') {
    const audited = (payload.kit || []).some(k => k.present != null);
    mockStandards[payload.slug] = { kit: payload.kit, notes: payload.notes, audited_at: audited ? new Date().toISOString() : null, audited_by: 'admin' };
    const missing = (payload.kit || []).filter(k => k.present === false).map(k => `Provide: ${k.label}`);
    return { status: 200, body: { ok: true, filed: payload.slug.startsWith('haus') ? missing : [], unowned: payload.slug.startsWith('haus') ? [] : missing } };
  }
  if (action === 'hk_rounds') {
    const today = hkToday();
    const projected = projectRounds({ today, units: mockHkUnits, months: 6, lastInspection: { 'haus-2': hkPlus(today, -6) }, lastDeepClean: { 'haus-1': hkPlus(today, -85) } })
      .filter(r => r.date > hkPlus(today, 21));
    return { status: 200, body: { today, months: 6, names, tasks: mockHkTasks.filter(t => ['inspection', 'deep_clean'].includes(t.kind)), projected } };
  }
  if (action === 'hk_stats') {
    return { status: 200, body: { days: 30, people: mockStaff.filter(s => (s.roles || []).includes('housekeeper')).map(s => ({ staff_id: s.id, name: s.name, visits: 18, done: 17, done_on_day: 16, skipped: 1, checks: 6, pass: 5, flagged: 1, unchecked: 0, villas: s.slugs || [] })) } };
  }
  if (action === 'hk_calendar') return { status: 200, body: { today: hkToday(), months: 6, events: mockHkTasks.map(t => ({ uid: 'hk-task-' + t.id, date: t.task_date, slug: t.slug, kind: t.kind, title: `${names[t.slug] || t.slug}: ${t.kind}`, status: t.status })) } };
  if (action === 'hk_care') {
    return { status: 200, body: { care: Object.entries(mockCare).map(([slug, clean_days]) => ({ slug, clean_days, active: true })) } };
  }
  if (action === 'hk_care_patch') {
    mockCare[payload.slug] = (payload.clean_days || []).map(Number);
    return { status: 200, body: { ok: true, care: { slug: payload.slug, clean_days: mockCare[payload.slug], active: true } } };
  }
  if (action === 'hk_replan') {
    mockHkTasks = mockHkBuild();
    return { status: 200, body: { removed: 0, planned: mockHkTasks.length, created: mockHkTasks.length, today: hkToday() } };
  }
  if (action === 'hk_owner_inspection') {
    // One villa deliberately has no round this week, so the report renders
    // correctly both with and without the section.
    if (payload.slug === 'haus-1') return { status: 200, body: { inspection: null } };
    return { status: 200, body: { inspection: {
      inspected_on: hkPlus(hkToday(), -2),
      findings: null,
      photo_urls: ['a', 'b', 'c', 'd'].map(s => `https://picsum.photos/seed/insp-${payload.slug}-${s}/600/450`),
      photo_count: 6,
      repairs: payload.slug === 'villa-saturno' ? [
        { title: 'Damp patch on the guest bedroom ceiling', status: 'pending_approval', cost: 1800000, currency: 'IDR' },
        { title: 'Cracked tile by the pool steps', status: 'done', cost: 450000, currency: 'IDR' },
      ] : [],
    } } };
  }
  return { status: 400, body: { error: `Unknown action: ${action}` } };
}

function mockMaintenanceApi({ action, payload = {} }) {
  const fx = fixture(action, payload); if (fx) return fx;
  const find = (id) => mockMaint.find(m => m.id === +id);
  const withGroup = (m) => ({ ...m, statement_groups: mockGroups.find(g => g.key === m.group_key) || null,
    staff: m.assigned_staff_id ? mockStaff.find(s => s.id === m.assigned_staff_id) || null : null,
    token: maintenanceToken(m.group_key, m.id),
    job_token: m.assigned_staff_id ? tukangToken(m.id) : null });
  const urls = (m) => (m.photos || []).map((_, i) => `https://picsum.photos/seed/m${m.id}-${i}/600/450`);

  if (action === 'maint_list') {
    const items = mockMaint.map(withGroup);
    return { status: 200, body: { items,
      needsReview: items.filter(i => i.status === 'new').length,
      awaitingOwner: items.filter(i => i.status === 'pending_approval').length,
      openWork: items.filter(i => ['approved', 'scheduled'].includes(i.status)).length,
      counts: {} } };
  }
  if (action === 'maint_detail') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'Item not found' } };
    return { status: 200, body: { item: { ...withGroup(m), photos: m.photos || [], photo_urls: urls(m) } } };
  }
  if (action === 'maint_photo_remove') {
    const m = find(payload.id);
    if (m) m.photos = (m.photos || []).filter(p => p !== payload.path);
    return { status: 200, body: { ok: true, remaining: (m?.photos || []).length } };
  }
  if (action === 'maint_photo') {
    const m = find(payload.id);
    if (m) m.photos = [...(m.photos || []), `${payload.id}/${Date.now()}.jpg`];
    return { status: 200, body: { ok: true } };
  }
  // ── Tukang dispatch ─────────────────────────────────────────────
  if (action === 'maint_assign') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'item not found' } };
    if (!['approved', 'scheduled'].includes(m.status)) {
      return { status: 500, body: { error: `only approved work can be assigned (this one is ${m.status})` } };
    }
    const s = mockStaff.find(x => x.id === +payload.staff_id);
    if (!s) return { status: 500, body: { error: 'no such person in the team register' } };
    Object.assign(m, {
      assigned_staff_id: s.id, assigned_at: new Date().toISOString(), visit_status: 'offered',
      visit_at: null, tukang_notified_at: null, tukang_replied_at: null, visit_reminded_at: null,
      arrival_check_at: null, completion_check_at: null, era_dispatch_update_at: null, era_dispatch_state: null,
    });
    m.thread = [...(m.thread || []), { at: new Date().toISOString(), who: payload.actor || 'admin', text: `Assigned to ${s.name}` }];
    return { status: 200, body: { ok: true, staff: s } };
  }
  if (action === 'maint_unassign') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'item not found' } };
    Object.assign(m, { assigned_staff_id: null, assigned_at: null, visit_status: null, visit_at: null });
    return { status: 200, body: { ok: true } };
  }
  if (action === 'maint_confirm_visit') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'item not found' } };
    if (!['offered', 'confirmed'].includes(m.visit_status)) {
      return { status: 409, body: { error: 'that job is no longer waiting to be scheduled' } };
    }
    m.visit_status = 'confirmed';
    m.visit_at = new Date(payload.at).toISOString();
    m.era_dispatch_update_at = null;
    return { status: 200, body: { ok: true, visit_at: m.visit_at } };
  }
  if (action === 'maint_job') {
    const m = find(payload.item_id ?? payload.id);
    if (!m || !m.assigned_staff_id) return { status: 404, body: { error: 'No job for that link' } };
    const g = mockGroups.find(x => x.key === m.group_key);
    const s = mockStaff.find(x => x.id === m.assigned_staff_id);
    const wita = m.visit_at ? new Date(Date.parse(m.visit_at) + 8 * 3600e3) : null;
    return { status: 200, body: {
      id: m.id, title: m.title, description: m.description,
      place: m.unit_label ? `${g?.name || m.group_key} (${m.unit_label})` : (g?.name || m.group_key),
      urgency: m.urgency, currency: m.currency, budget: m.estimated_cost,
      photo_urls: urls(m), visit_status: m.visit_status, visit_at: m.visit_at,
      // Indonesian, matching witaLabelId in the CRM: the tukang reads this.
      visit_label: wita ? `${new Date(wita.toISOString().slice(0, 10) + 'T00:00:00Z').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}, pukul ${wita.toISOString().slice(11, 16)} WITA` : null,
      assigned_to: s?.name || null, reported_at: m.reported_at,
    } };
  }
  if (action === 'maint_patch') { const m = find(payload.id); if (m) Object.assign(m, payload.fields || {}); return { status: 200, body: { ok: true } }; }
  if (action === 'maint_delete') { const i = mockMaint.findIndex(x => x.id === +payload.id); if (i >= 0) mockMaint.splice(i, 1); return { status: 200, body: { ok: true } }; }
  if (action === 'maint_create') {
    const m = { id: ++mockMaintId, status: 'new', photos: [], thread: [], followup_count: 0, currency: 'IDR',
      requires_approval: true, created_at: new Date().toISOString(), reported_at: new Date().toISOString(), ...payload };
    mockMaint.unshift(m); return { status: 200, body: { ok: true, item: m } };
  }
  if (action === 'maint_publish') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'Item not found' } };
    m.requires_approval = payload.requires_approval !== undefined ? !!payload.requires_approval : m.requires_approval;
    if (payload.estimated_cost !== undefined) m.estimated_cost = payload.estimated_cost;
    m.status = m.requires_approval ? 'pending_approval' : 'scheduled';
    m.published_at = new Date().toISOString(); m.notified_at = null;
    if (!m.requires_approval) m.next_followup_at = dayISO(-3);
    return { status: 200, body: { ok: true, status: m.status } };
  }
  if (action === 'maint_approve') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'Item not found' } };
    m.status = 'approved'; m.approved_at = new Date().toISOString(); m.approved_by = payload.by || 'owner';
    m.staff_notified_at = null; m.next_followup_at = dayISO(-3);
    return { status: 200, body: { ok: true } };
  }
  if (action === 'maint_decline') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'Item not found' } };
    m.status = 'declined'; m.declined_at = new Date().toISOString(); m.decline_note = payload.note || null;
    m.staff_notified_at = null; return { status: 200, body: { ok: true } };
  }
  if (action === 'maint_complete') {
    const m = find(payload.id); if (!m) return { status: 404, body: { error: 'Item not found' } };
    m.status = 'done'; m.completed_at = new Date().toISOString(); m.completion_note = payload.note || null;
    if (payload.actual_cost !== undefined) m.actual_cost = payload.actual_cost;
    m.done_notified_at = null; m.next_followup_at = null; return { status: 200, body: { ok: true } };
  }
  if (action === 'maint_public') {
    const m = mockMaint.find(x => x.id === +(payload.item_id ?? payload.id) && x.group_key === payload.group_key);
    if (!m || m.status === 'new') return { status: 404, body: { error: 'No maintenance item for that link' } };
    const g = mockGroups.find(x => x.key === m.group_key) || {};
    return { status: 200, body: { ...m, group: { key: g.key, name: g.name, owner_names: g.owner_names }, photo_urls: urls(m) } };
  }
  if (action === 'maint_owner_items') {
    const keys = payload.group_keys || [];
    return { status: 200, body: { items: mockMaint.filter(m => keys.includes(m.group_key) && m.status !== 'new').map(m => ({
      ...m, group_name: (mockGroups.find(g => g.key === m.group_key) || {}).name || m.group_key,
      photo_urls: urls(m), url: `/m/${maintenanceToken(m.group_key, m.id)}` })) } };
  }
  if (action === 'maint_reporters') return { status: 200, body: { reporters: [{ wa_num: '6281246357778', name: 'Era', role: 'manager', active: true }] } };
  return { status: 400, body: { error: 'unsupported action: ' + action } };
}

// ── mock Owner Statements engine (kaya-agent-crm /api/statements) ─────
// Stateful enough that edit → publish → mark-paid visibly works in
// payouts.html, and /st/<token> + the portal Statements tab render.
const mockGroups = [
  { key: 'haus-2-4', name: 'HAUS Canggu – Units 2 & 4', sheet_file_id: 'SHEET_HAUS24', listing_slugs: ['haus-2', 'haus-4'], owner_wa_nums: ['628111111111', '628122222222'], owner_names: 'Romina & Tim', notify: true, active: true, charges_commission: true },
  { key: 'lanehaus', name: 'LaneHAUS – Units 1 & 3', sheet_file_id: 'SHEET_LANE', listing_slugs: ['lanehaus-1', 'lanehaus-3'], owner_wa_nums: [], owner_names: 'Ikiel & Guy', notify: false, active: true, charges_commission: false, tracks_payments: false },
  { key: 'villa-saturno', name: 'Villa Saturno', sheet_file_id: 'SHEET_SAT', listing_slugs: ['villa-saturno'], owner_wa_nums: ['628133333333'], owner_names: 'Pedro', notify: true, active: true },
  { key: 'tropicana-b2356', name: 'Tropicana Valley – Units B2, B3, B5 & B6', sheet_file_id: '', listing_slugs: ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6'], owner_wa_nums: ['6287832988120'], owner_names: 'Ikiel & Oli', notify: true, active: true },
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
  // June: partial + carry-over adjustment — exercises the portal's expanded
  // row (paid-to-date / still-on-its-way) and payouts.html's calm carry banner.
  { id: 4, group_key: 'lanehaus', period: '2026-06', status: 'partial', currency: 'IDR',
    gross_total: 18000000, commission_total: 2700000, nett_total: 15300000, expenses_total: 3000000, adjustments_total: -4000000, payout_total: 8300000,
    era_payout_total: 12300000, needs_review: false, has_manual_edits: false, source_changed: false, discrepancy: null,
    hostex_snapshot: { period: '2026-06', days_in_month: 30, units: {}, group: { nights_sold: 38, occupancy_pct: 74, reservations: 4, channels: { Airbnb: 26, Direct: 12 }, adr: 473000 } },
    reconciliation: { checks: [], unparsed_rows: [] },
    source_tab: 'June', parsed_at: dayISO(32), published_at: dayISO(30), published_by: 'admin', notified_at: dayISO(30), paid_at: null, proof_path: null,
    paid_total: 5000000,
    payments: [{ id: 901, amount: 5000000, paid_at: dayISO(20), note: 'first tranche', proof_path: null }],
    lines: [
      { id: 30, kind: 'booking', unit_name: 'LaneHAUS – Unit 1', position: 0, guest_name: 'Priya', stay_dates: '2-20 June', platform: 'Airbnb', nights: 18, amount: 18000000, commission: 2700000, nett: 15300000, flags: [], edited: false },
      { id: 31, kind: 'expense', position: 1, expense_date: '28 Jun 2026', description: 'Pool + garden + utilities', amount: 3000000, flags: [], edited: false },
      { id: 32, kind: 'adjustment', position: 2, description: 'Carried over from May deficit', amount: -4000000, flags: ['carry_forward'], edited: false },
    ] },
  { id: 5, group_key: 'lanehaus', period: '2026-05', status: 'paid', currency: 'IDR',
    gross_total: 16000000, commission_total: 2400000, nett_total: 13600000, expenses_total: 1150000, adjustments_total: 0, payout_total: 12450000,
    era_payout_total: 12450000, needs_review: false, has_manual_edits: false, source_changed: false, discrepancy: null,
    hostex_snapshot: { period: '2026-05', days_in_month: 31, units: {}, group: { nights_sold: 44, occupancy_pct: 81, reservations: 6, channels: { Airbnb: 30, 'Booking.com': 14 }, adr: 364000 } },
    reconciliation: { checks: [], unparsed_rows: [] },
    source_tab: 'May', parsed_at: dayISO(62), published_at: dayISO(60), published_by: 'admin', notified_at: dayISO(60), paid_at: dayISO(58), proof_path: null,
    paid_total: 12450000,
    payments: [{ id: 902, amount: 12450000, paid_at: dayISO(58), note: 'BCA transfer', proof_path: null }],
    lines: [
      { id: 40, kind: 'booking', unit_name: 'LaneHAUS – Unit 3', position: 0, guest_name: 'Wei', stay_dates: '1-31 May', platform: 'Airbnb', nights: 30, amount: 16000000, commission: 2400000, nett: 13600000, flags: [], edited: false },
      { id: 41, kind: 'expense', position: 1, expense_date: '30 May 2026', description: 'Utilities', amount: 1150000, flags: [], edited: false },
    ] },
  { id: 3, group_key: 'villa-saturno', period: '2026-06', status: 'published', currency: 'IDR',
    gross_total: 36460000, commission_total: 5469000, nett_total: 30991000, expenses_total: 4700000, adjustments_total: 0, payout_total: 26291000,
    era_payout_total: 26291000, needs_review: false, has_manual_edits: false, source_changed: false, discrepancy: null,
    hostex_snapshot: { period: '2026-06', days_in_month: 30, units: {}, group: { nights_sold: 26, occupancy_pct: 87, reservations: 4, channels: { Airbnb: 20, 'Booking.com': 6 }, adr: 1050000 } },
    reconciliation: { checks: [], unparsed_rows: [] },
    source_tab: 'June', parsed_at: dayISO(30), published_at: dayISO(28), published_by: 'admin', notified_at: dayISO(28), paid_at: dayISO(26), proof_path: 'villa-saturno/2026-06.jpg',
    paid_total: 0,
    payments: [],
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
  if (action === 'statement_wa_login_code') {
    const to = String(payload?.wa_num || '').replace(/\D/g, '');
    const known = mockGroups.some(g => (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === to));
    if (!known && !payload?.allow_unregistered) return { status: 403, body: { error: 'Number not registered to any property' } };
    console.log(`[mock] WhatsApp sign-in link for ${to}: http://localhost:3456/portal?wa_login=${payload.token}`);
    return { status: 200, body: { ok: true, message_id: 'wamid.mock' } };
  }
  if (action === 'statement_group_patch') {
    const g = mockGroups.find(x => x.key === payload.key);
    if (g) Object.assign(g, payload.fields || {});
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_list') {
    const rows = mockStatements.map(stripLines);
    const out = rows.filter(s => s.status === 'published' || s.status === 'partial');
    // Groups that settle privately never count as outstanding (mirrors the CRM).
    const owed = out.filter(s => (mockGroups.find(g => g.key === s.group_key) || {}).tracks_payments !== false);
    return { status: 200, body: { statements: rows, outstanding: { count: owed.length, total: owed.reduce((a, s) => a + Math.max(0, s.payout_total - (s.paid_total || 0)), 0) } } };
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
  if (action === 'statement_unit_nights') {
    const group = mockGroups.find(g => g.key === payload.group_key);
    if (!group) return { status: 404, body: { error: 'Unknown group' } };
    const bySlug = {}; let unassigned = 0;
    for (const st of mockStatements.filter(s => s.group_key === group.key && s.status !== 'void'
        && (!payload.from || s.period >= payload.from) && (!payload.to || s.period <= payload.to))) {
      for (const l of st.lines.filter(x => x.kind === 'booking')) {
        if (/owner/i.test(l.platform || '') || (l.flags || []).includes('zero_amount')) continue;
        const n = Number(l.nights) || 0;
        if (!n) continue;
        let slug = group.listing_slugs.length === 1 ? group.listing_slugs[0] : null;
        if (!slug) for (const sl of group.listing_slugs) {
          const d = sl.match(/-(\d+)$/)?.[1];
          if (d && new RegExp(`unit\\s*0*${d}\\b`, 'i').test(l.unit_name || '')) { slug = sl; break; }
        }
        if (slug) bySlug[slug] = (bySlug[slug] || 0) + n; else unassigned += n;
      }
    }
    return { status: 200, body: { bySlug, unassigned, from: payload.from, to: payload.to } };
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
    const amending = Array.isArray(st.revisions) && st.revisions.some(r => r && r.open);
    if (st.status !== 'draft' && !amending) return { status: 409, body: { error: `Statement is ${st.status} — lines are frozen (use Amend)` } };
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
  if (action === 'statement_amend_start') {
    const st = find(payload.id);
    if (!st) return { status: 404, body: { error: 'Statement not found' } };
    if (!['published', 'partial', 'paid'].includes(st.status)) return { status: 400, body: { error: `only published statements can be amended — this one is ${st.status}` } };
    st.revisions = st.revisions || [];
    if (st.revisions.some(r => r.open)) return { status: 200, body: { ok: true, already_open: true } };
    const prev = {}; for (const k of ['gross_total', 'commission_total', 'nett_total', 'expenses_total', 'adjustments_total', 'payout_total', 'era_payout_total']) prev[k] = st[k];
    st.revisions.push({ open: true, started_at: new Date().toISOString(), by: payload.actor || 'admin', prev, prev_lines: JSON.parse(JSON.stringify(st.lines)) });
    return { status: 200, body: { ok: true } };
  }
  if (action === 'statement_amend_finalize') {
    const st = find(payload.id);
    const rev = st?.revisions?.find(r => r.open);
    if (!rev) return { status: 400, body: { error: 'no amendment in progress' } };
    stTotals(st);
    delete rev.prev_lines;
    rev.open = false; rev.at = new Date().toISOString(); rev.by = payload.actor || 'admin';
    rev.note = String(payload.note || '').slice(0, 300) || null;
    rev.new = { gross_total: st.gross_total, commission_total: st.commission_total, nett_total: st.nett_total, expenses_total: st.expenses_total, adjustments_total: st.adjustments_total, payout_total: st.payout_total };
    st.has_manual_edits = true;
    if (payload.notify_owner) st.notified_at = null;
    stRecomputePayments(st);
    return { status: 200, body: { ok: true, payout_total: st.payout_total, prev_payout: rev.prev?.payout_total ?? null } };
  }
  if (action === 'statement_amend_cancel') {
    const st = find(payload.id);
    const idx = st?.revisions?.findIndex(r => r.open) ?? -1;
    if (idx < 0) return { status: 400, body: { error: 'no amendment in progress' } };
    const rev = st.revisions[idx];
    st.lines = rev.prev_lines || st.lines;
    Object.assign(st, rev.prev || {});
    st.revisions.splice(idx, 1);
    stRecomputePayments(st);
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
      revisions: (st.revisions || []).filter(r => !r.open && r.at).map(r => ({ at: r.at, note: r.note || null, prev_payout: r.prev?.payout_total ?? null, new_payout: r.new?.payout_total ?? null })),
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

// Seed one owned catalog unit so the admin's owner card has something real to
// render (Rushika signed in with WhatsApp, so she has no email).
store.set('owner:wa:61433733473', JSON.stringify({ sub: 'wa:61433733473', name: 'Rushika', wa: '61433733473', email: null }));
store.set('listing:haus-5', JSON.stringify({ slug: 'haus-5', ownerSub: 'wa:61433733473', ownerEmail: null, reportContacts: [{ name: 'Co-owner', wa: '61400111222' }] }));
store.set('owner_listings:wa:61433733473', JSON.stringify(['haus-5']));
// Co-owned units: Ikiel is the primary owner; the dev owner is claimed as a
// co-owner on sign-in through coOwnerEmails (the guide screenshots use this).
store.set('owner:wa:15142400048', JSON.stringify({ sub: 'wa:15142400048', name: 'Ikiel', wa: '15142400048', email: 'ikielptito@gmail.com' }));
for (const s of ['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6']) {
  store.set(`listing:${s}`, JSON.stringify({ slug: s, ownerSub: 'wa:15142400048', ownerEmail: 'ikielptito@gmail.com',
    coOwnerEmails: [process.env.DEV_OWNER_EMAIL || 'owner@example.com'], reportContacts: [{ name: 'Oli', wa: '6287832988120' }] }));
}
store.set('owner_listings:wa:15142400048', JSON.stringify(['tropicana-b2', 'tropicana-b3', 'tropicana-b5', 'tropicana-b6']));

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
      sub: 'dev-owner-1', email: process.env.DEV_OWNER_EMAIL || 'owner@example.com', email_verified: true,
      name: process.env.DEV_OWNER_NAME || 'Dev Owner', picture: '', aud: process.env.GOOGLE_CLIENT_ID,
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
  if (u.includes('/__crm_mock/api/maintenance')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'maintenance', body });
    const out = mockMaintenanceApi(body);
    return { ok: out.status === 200, status: out.status, json: async () => out.body };
  }
  if (u.includes('/__crm_mock/api/staff')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'staff', body });
    const out = mockStaffApi(body);
    return { ok: out.status === 200, status: out.status, json: async () => out.body };
  }
  if (u.includes('/__crm_mock/api/payroll')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'payroll', body });
    const out = mockPayrollApi(body);
    return { ok: out.status === 200, status: out.status, json: async () => out.body };
  }
  if (u.includes('/__crm_mock/api/housekeeping')) {
    const body = JSON.parse(opts.body || '{}');
    __crmCalls.push({ kind: 'housekeeping', body });
    const out = mockHousekeepingApi(body);
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
    await handlers.listings.default({ method: 'GET', headers: req.headers, query: Object.fromEntries(u.searchParams), body: null }, res);
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
    // Dev-only: ?devpw=1 pre-seeds the admin password so headless captures
    // (guide screenshots) can reach the logged-in cockpit. Never shipped.
    if (['/payouts', '/campaigns', '/admin'].includes(u.pathname) && u.searchParams.get('devpw') === '1') {
      // ?capture=<name> opens a named modal after boot, so headless-Chrome
      // guide screenshots can photograph states that normally need a click.
      const cap = u.searchParams.get('capture') || '';
      // ?focus=<selector>&nth=<i> isolates one element after boot (the
      // guide's per-card crops): everything else leaves the page, the element
      // sits at a fixed width on the plain background, and a trim does the rest.
      const focus = u.searchParams.get('focus') || '';
      const nth = parseInt(u.searchParams.get('nth') || '0', 10) || 0;
      const focusJs = focus ? `<script>window.addEventListener('load',()=>setTimeout(()=>{try{
        var el=document.querySelectorAll(${JSON.stringify(focus)})[${nth}]; if(!el) return;
        var st=[].slice.call(document.querySelectorAll('style,link[rel=stylesheet]'));
        document.body.innerHTML=''; st.forEach(function(x){document.body.appendChild(x)});
        document.body.style.background='#F4F1ED'; document.body.style.padding='24px';
        el.style.maxWidth='1080px'; el.style.width='1080px'; el.style.margin='0'; el.style.transform='none'; el.style.position='static';
        document.body.appendChild(el);
      }catch(e){}},4200));</script>` : '';
      const capJs = cap ? `<script>window.addEventListener('load',()=>setTimeout(()=>{try{
        if(${JSON.stringify(cap)}==='care'&&window.hkCareEdit)hkCareEdit();
        var C=${JSON.stringify(cap)};
        if(C==='hkvilla'&&window.schedShowVilla)schedShowVilla('haus-4');
        if(C==='hkstd'&&window.hkStandardSheet)hkStandardSheet('haus-4');
        if(C==='hkrounds'&&window.hkRoundsSheet)hkRoundsSheet();
        if(C==='hkfeed'&&window.hkCalendarSheet)hkCalendarSheet();
        if(C==='hkwho'&&window.schedSetFilter)schedSetFilter('who:5');
        if(C==='hkflag'&&window.hkTaskSheet){var r=(hkReady&&hkReady.checks||[]).find(function(x){return x.status==='flagged'});if(r)hkTaskSheet(r.task_id);}
        if(C==='hkpass'&&window.hkTaskSheet){var r2=(hkReady&&hkReady.checks||[]).find(function(x){return x.status==='pass'});if(r2)hkTaskSheet(r2.task_id);}
        if(${JSON.stringify(cap)}==='addstaff'&&window.staffEdit)staffEdit(null);
        var PR=(typeof prDet!=='undefined')&&prDet;
        if(${JSON.stringify(cap)}==='predit'&&PR)payrollEditLine(PR.run.id, PR.lines[6].id);
        if(${JSON.stringify(cap)}==='prpay'&&PR){var p=PR.payees.find(function(x){return x.payee==='Dian'});payrollPay(PR.run.id,'Dian',6,Math.round(p.balance));}
        if(${JSON.stringify(cap)}==='prpublish'&&PR){window.confirm=function(){return true};payrollPublish(PR.run.id);}
        if(${JSON.stringify(cap)}==='prpaid'&&PR){window.confirm=function(){return true};payrollApi('payroll_publish',{id:PR.run.id}).then(function(){return payrollApi('payroll_record_payment',{id:PR.run.id,payee:'Dian',staff_id:6,amount:3400000,note:'Transfer BCA 5 Sep'})}).then(function(){return payrollApi('payroll_record_payment',{id:PR.run.id,payee:'Naomi',staff_id:2,amount:2000000,note:'Transfer BCA 5 Sep'})}).then(function(){renderPayrollRun(PR.run.id)});}
      }catch(e){}},2600));</script>` : '';
      const extraJs = capJs + focusJs;
      const html = fs.readFileSync(path.join(ROOT, 'public', u.pathname.slice(1) + '.html'), 'utf8')
        .replace('<script src="/shared.js"></script>',
          `<script>sessionStorage.setItem('admin_pw', ${JSON.stringify(process.env.DASHBOARD_PASSWORD)});</script>\n${extraJs}<script src="/shared.js"></script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(html);
    }
    // /j/<token> → listing-page in job mode (matches vercel.json).
    if (u.pathname.startsWith('/j/')) {
      const fakeReq = { method: 'GET', headers: req.headers, query: { job: u.pathname.slice(3) }, body: null };
      return void await handlers['listing-page'].default(fakeReq, shimRes(res));
    }
    // /m/<token> → listing-page in maintenance mode (matches vercel.json).
    if (u.pathname.startsWith('/m/')) {
      const fakeReq = { method: 'GET', headers: req.headers, query: { maintenance: u.pathname.slice(3) }, body: null };
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
