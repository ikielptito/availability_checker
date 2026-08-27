// ── OWNER FINANCIALS → EXCEL WORKBOOKS ───────────────────────────────
// Turns statement data into accountant-ready workbooks (via lib/xlsx.js).
// The format follows general bookkeeping convention rather than any single
// national standard: a summary sheet plus separate ledgers for income,
// expenses, and payments — dates, descriptions, and raw IDR amounts in
// dedicated numeric columns, totals on bold rows. Any accountant (or
// accounting software importer) can take it from there.

import { buildXlsx } from './xlsx.js';

const N = (v) => Number(v) || 0;
const d10 = (iso) => (iso ? String(iso).slice(0, 10) : '');

function accountRows(account) {
  if (!account || (!account.bank && !account.account_name && !account.account_number)) return [];
  return [
    [''],
    [{ v: 'Payout account', bold: true }],
    ['Bank', account.bank || ''],
    ['Account name', account.account_name || ''],
    ['Account number', account.account_number || ''],
    ...(account.note ? [['Note', account.note]] : []),
  ];
}

function incomeSheetRows(months) {
  // months: [{label, lines}] — one entry for a single statement, many for a year.
  const multi = months.length > 1;
  const head = [...(multi ? ['Month'] : []), 'Unit', 'Guest', 'Stay dates', 'Platform', 'Nights', 'Gross (IDR)', 'Management fee (IDR)', 'Net to owner (IDR)'];
  const rows = [head];
  let g = 0, c = 0, n = 0;
  for (const m of months) {
    for (const l of m.lines.filter(x => x.kind === 'booking')) {
      rows.push([...(multi ? [m.label] : []), l.unit_name || '', l.guest_name || '', l.stay_dates || '', l.platform || '', l.nights ?? '', N(l.amount), N(l.commission), N(l.nett)]);
      g += N(l.amount); c += N(l.commission); n += N(l.nett);
    }
  }
  rows.push([...(multi ? [''] : []), { v: 'Total', bold: true }, '', '', '', '', { v: g, bold: true }, { v: c, bold: true }, { v: n, bold: true }]);
  return { name: 'Income', rows, colWidths: [...(multi ? [14] : []), 22, 22, 18, 16, 8, 16, 16, 18] };
}

function expensesSheetRows(months) {
  const multi = months.length > 1;
  const rows = [[...(multi ? ['Month'] : []), 'Date', 'Description', 'Amount (IDR)']];
  let t = 0;
  for (const m of months) {
    for (const l of m.lines.filter(x => x.kind === 'expense')) {
      rows.push([...(multi ? [m.label] : []), l.expense_date || '', l.description || '', N(l.amount)]);
      t += N(l.amount);
    }
  }
  rows.push([...(multi ? [''] : []), { v: 'Total', bold: true }, '', { v: t, bold: true }]);
  return { name: 'Expenses', rows, colWidths: [...(multi ? [14] : []), 14, 44, 16] };
}

function paymentsSheetRows(months) {
  const multi = months.length > 1;
  const rows = [[...(multi ? ['Month'] : []), 'Date paid', 'Amount (IDR)', 'Note']];
  let t = 0;
  for (const m of months) {
    for (const p of m.payments || []) {
      rows.push([...(multi ? [m.label] : []), d10(p.paid_at), N(p.amount), p.note || '']);
      t += N(p.amount);
    }
  }
  rows.push([...(multi ? [''] : []), { v: 'Total paid', bold: true }, { v: t, bold: true }, '']);
  return { name: 'Payments', rows, colWidths: [...(multi ? [14] : []), 14, 16, 40] };
}

// One month — from a publicStatement payload.
export function buildStatementWorkbook(pub) {
  const t = pub.totals || {};
  const adjustments = (pub.lines || []).filter(l => l.kind === 'adjustment');
  const summary = {
    name: 'Statement',
    colWidths: [30, 22],
    rows: [
      [{ v: 'Samba Realty — Owner Statement', bold: true }],
      [''],
      ['Property', pub.group?.name || ''],
      ['Owner', pub.group?.owner_names || ''],
      ['Period', pub.period_label || pub.period],
      ['Currency', pub.currency || 'IDR'],
      ['Published', d10(pub.published_at)],
      ['Payment status', pub.status === 'paid' ? `Paid in full (${d10(pub.paid_at)})` : pub.status === 'partial' ? 'Partially paid' : 'Payout pending'],
      [''],
      [{ v: 'Summary', bold: true }, { v: 'IDR', bold: true }],
      ['Gross rental income', N(t.gross)],
      ['Samba Realty management fee', -N(t.commission)],
      ['Nett rental income', N(t.nett)],
      ['Villa expenses', -N(t.expenses)],
      ...adjustments.map(a => [`Adjustment — ${a.description || ''}`, N(a.amount)]),
      [{ v: 'Total payout', bold: true }, { v: N(t.payout), bold: true }],
      ['Paid to date', N(t.paid)],
      [{ v: 'Balance due', bold: true }, { v: N(t.balance), bold: true }],
      ...accountRows(pub.group?.payout_account),
    ],
  };
  const month = [{ label: pub.period_label || pub.period, lines: pub.lines || [], payments: pub.payments || [] }];
  return buildXlsx([summary, incomeSheetRows(month), expensesSheetRows(month), paymentsSheetRows(month)]);
}

// Whole group, optionally a period range — from statement_export_data.
// rangeLabel: '2026' | 'March – July 2026' | null (all months).
export function buildGroupWorkbook({ group, statements }, rangeLabel) {
  const months = statements.map(st => ({ label: st.period_label || st.period, lines: st.lines || [], payments: st.payments || [] }));
  const sumRows = [['Month', 'Gross (IDR)', 'Management fee (IDR)', 'Net income (IDR)', 'Expenses (IDR)', 'Adjustments (IDR)', 'Payout (IDR)', 'Paid (IDR)', 'Balance (IDR)', 'Status'].map(v => ({ v, bold: true }))];
  const tot = { g: 0, c: 0, n: 0, e: 0, a: 0, p: 0, pd: 0, b: 0 };
  for (const st of statements) {
    const bal = N(st.payout_total) - N(st.paid_total);
    sumRows.push([st.period_label || st.period, N(st.gross_total), N(st.commission_total), N(st.nett_total), N(st.expenses_total), N(st.adjustments_total), N(st.payout_total), N(st.paid_total), bal, st.status]);
    tot.g += N(st.gross_total); tot.c += N(st.commission_total); tot.n += N(st.nett_total);
    tot.e += N(st.expenses_total); tot.a += N(st.adjustments_total); tot.p += N(st.payout_total);
    tot.pd += N(st.paid_total); tot.b += bal;
  }
  sumRows.push([{ v: 'Total', bold: true }, { v: tot.g, bold: true }, { v: tot.c, bold: true }, { v: tot.n, bold: true }, { v: tot.e, bold: true }, { v: tot.a, bold: true }, { v: tot.p, bold: true }, { v: tot.pd, bold: true }, { v: tot.b, bold: true }, '']);
  const summary = {
    name: 'Summary',
    colWidths: [16, 14, 15, 16, 14, 15, 14, 14, 14, 12],
    rows: [
      [{ v: `Samba Realty — Owner Financials — ${group.name}${rangeLabel ? ` — ${rangeLabel}` : ''}`, bold: true }],
      ['Owner', group.owner_names || ''],
      [''],
      ...sumRows,
      ...accountRows(group.payout_account),
    ],
  };
  return buildXlsx([summary, incomeSheetRows(months), expensesSheetRows(months), paymentsSheetRows(months)]);
}
