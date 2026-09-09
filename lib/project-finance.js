// Project finance — the maths behind the Tropicana Valley dashboard.
//
// Pure functions over the rows the CRM stores (lib/project-finance.js in
// kaya-agent-crm: ledger, commitments, receivables, loans, accounts) plus
// the rental months the portal computes from Hostex and Era's statements.
// Nothing here touches the network, so dev/project-finance.test.mjs can pin
// every number.
//
// The headline question is Ikiel's: how much of the loan that bought the
// land is still to pay, once you count what is in the company account, what
// the project still has to pay out, what the buyers still owe, and the rent
// the unsold units bring in. So:
//
//   loan outstanding  = drawn − repaid (+ simple interest when a rate is set)
//   cash              = last bank balance per cash account, rolled forward by
//                       the ledger rows dated after that balance
//   remaining costs   = Σ open commitments (total − paid against them)
//   receivables       = Σ open buyer balances
//   gap               = loan outstanding − (cash − remaining costs + receivables)
//   months to close   = gap ÷ average monthly rental net (trailing)

export const CATEGORIES = {
  out: [
    ['land', 'Land lease'], ['architecture', 'Architecture & engineering'], ['construction', 'Construction'],
    ['construction_addon', 'Construction add-ons'], ['doors_windows', 'Doors & windows'], ['kitchen_wardrobe', 'Kitchen & wardrobe'],
    ['aircon', 'Air conditioning'], ['furniture', 'Furniture'], ['appliances', 'Appliances'], ['fit_out', 'Fit-out & deco'],
    ['finishing', 'Finishing works'], ['slf', 'SLF permit'], ['landscaping', 'Landscaping'], ['permits_fees', 'Permits, utilities & fees'],
    ['operating', 'Operating & unit prep'], ['rental_expense', 'Rental unit expenses'], ['agent_commission', 'Agent commission'],
    ['deposit_refund', 'Tenant deposit returned'], ['partner_out', 'To a partner'], ['loan_repayment', 'Loan repayment'], ['bank_charges', 'Bank charges & tax'], ['other', 'Other'],
  ],
  in: [
    ['unit_sale', 'Unit sale'], ['rental_income', 'Rental income'], ['loan_drawdown', 'Loan received'], ['capital_in', 'Partner capital'],
    ['deposit_in', 'Tenant deposit'], ['bank_interest', 'Bank interest'], ['other', 'Other'],
  ],
};
export const CATEGORY_LABEL = Object.fromEntries([...CATEGORIES.out, ...CATEGORIES.in]);

const num = (v) => (v == null || v === '' ? 0 : Number(v)) || 0;
const sum = (rows, f) => rows.reduce((a, r) => a + (f ? num(f(r)) : num(r)), 0);
export const addMonths = (period, n) => { const [y, m] = String(period).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
export const monthOf = (date) => String(date || '').slice(0, 7);

// Simple interest on the outstanding balance, accrued per drawdown /
// repayment interval. Interest-free loans (the default) return 0.
export function accruedInterest(loan, events, today) {
  const rate = num(loan.interest_rate) / 100;
  if (!rate) return 0;
  const evs = events.slice().sort((a, b) => a.date.localeCompare(b.date));
  let bal = 0, acc = 0, last = null;
  const days = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 86400000);
  for (const e of evs) {
    if (last) acc += bal * rate * days(last, e.date) / 365;
    bal += e.kind === 'in' ? e.amount : -e.amount;
    last = e.date;
  }
  if (last) acc += bal * rate * days(last, today) / 365;
  return Math.round(acc);
}

export function loanPositions(loans, ledger, today) {
  return (loans || []).map(l => {
    const mine = (ledger || []).filter(r => r.counterparty === l.key && (r.category === 'loan_drawdown' || r.category === 'loan_repayment'));
    const drawn = sum(mine.filter(r => r.direction === 'in'), r => r.amount);
    const repaid = sum(mine.filter(r => r.direction === 'out'), r => r.amount);
    const events = mine.map(r => ({ date: r.entry_date, kind: r.direction, amount: num(r.amount) }));
    const interest = accruedInterest(l, events, today);
    // When nothing has been drawn on the ledger yet, the agreed principal
    // (converted at fx_rate for a foreign-currency loan) stands in.
    const principalIdr = num(l.principal) * (l.currency && l.currency !== 'IDR' ? num(l.fx_rate) || 0 : 1);
    const base = drawn > 0 ? drawn : principalIdr;
    return { ...l, drawn, repaid, interest, principal_idr: principalIdr, outstanding: Math.max(0, base - repaid + interest), events: mine };
  });
}

// One account: the last bank balance, then every ledger row on that account
// dated after it. No balance on file → the ledger from the start (the
// sheet's "CALC BALANCE").
export function accountPositions(accounts, ledger) {
  return (accounts || []).map(a => {
    const rows = (ledger || []).filter(r => r.account === a.name);
    const asOf = a.balance_as_of || null;
    const after = asOf ? rows.filter(r => r.entry_date > asOf) : rows;
    const base = a.balance != null && asOf ? num(a.balance) : 0;
    const computed = base + sum(after.filter(r => r.direction === 'in'), r => r.amount) - sum(after.filter(r => r.direction === 'out'), r => r.amount);
    const ledgerOnly = sum(rows.filter(r => r.direction === 'in'), r => r.amount) - sum(rows.filter(r => r.direction === 'out'), r => r.amount);
    return { ...a, computed, ledger_only: ledgerOnly, rows_after: after.length, has_snapshot: a.balance != null && !!asOf };
  });
}

export function commitmentPositions(commitments, ledger) {
  return (commitments || []).map(c => {
    const paid = sum((ledger || []).filter(r => r.direction === 'out' && Number(r.commitment_id) === Number(c.id)), r => r.amount);
    const remaining = c.status === 'open' ? Math.max(0, num(c.total) - paid) : 0;
    return { ...c, paid, remaining };
  });
}

export function receivablePositions(receivables, ledger, fxUsd) {
  return (receivables || []).map(rc => {
    const received = sum((ledger || []).filter(r => r.direction === 'in' && r.counterparty === rc.ledger_match), r => r.amount);
    const rate = rc.currency === 'IDR' ? 1 : (num(rc.fx_rate) || num(fxUsd) || 1);
    const contractIdr = num(rc.contract_amount) * rate;
    const computed = Math.max(0, contractIdr - received);
    const due = rc.status !== 'open' ? 0 : (rc.balance_override != null && rc.balance_override !== '' ? num(rc.balance_override) : computed);
    return { ...rc, received, contract_idr: contractIdr, computed_due: computed, due };
  });
}

// Cost by category and the sales side, the sheet's "Profit Overview".
export function projectPnl(ledger) {
  const byCat = {};
  for (const r of ledger || []) {
    if (r.source === 'rental') continue;
    const k = `${r.direction}:${r.category || 'other'}`;
    byCat[k] = (byCat[k] || 0) + num(r.amount);
  }
  const outOf = (c) => byCat[`out:${c}`] || 0, inOf = (c) => byCat[`in:${c}`] || 0;
  const build = CATEGORIES.out.map(([c]) => c).filter(c => !['rental_expense', 'agent_commission', 'deposit_refund', 'partner_out', 'loan_repayment', 'bank_charges'].includes(c));
  const buildCost = sum(build, outOf);
  const sales = inOf('unit_sale');
  // Rent on a cash basis: what the bank saw (imported or typed rows). The
  // calendar rows the portal writes (source 'rental') are the booking view
  // and are reported next to it, never added to it.
  const cash = (ledger || []).filter(r => r.source !== 'rental');
  const rentalIncome = sum(cash.filter(r => r.direction === 'in' && r.category === 'rental_income'), r => r.amount);
  const rentalExpense = sum(cash.filter(r => r.direction === 'out' && ['rental_expense', 'agent_commission'].includes(r.category)), r => r.amount);
  const cal = (ledger || []).filter(r => r.source === 'rental');
  return {
    by_category: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, Math.round(v)])),
    build_cost: buildCost, sales, gross_profit: sales - buildCost,
    rental_income: rentalIncome, rental_expense: rentalExpense, rental_net: rentalIncome - rentalExpense,
    calendar_income: sum(cal.filter(r => r.direction === 'in'), r => r.amount), calendar_expense: sum(cal.filter(r => r.direction === 'out'), r => r.amount),
    total_in: sum(cash.filter(r => r.direction === 'in'), r => r.amount),
    total_out: sum(cash.filter(r => r.direction === 'out'), r => r.amount),
  };
}

// The rental months: closed months from the ledger (rental rows are written
// there by the portal) and the current month live. `avg` is the trailing
// average net over the last `window` closed months with any activity.
export function rentalSeries(months, { window = 3, ledger = [] } = {}) {
  const banked = {};
  for (const r of ledger || []) {
    if (r.source === 'rental') continue;
    const p = monthOf(r.entry_date);
    const b = (banked[p] ||= { income: 0, expenses: 0 });
    if (r.direction === 'in' && (r.category === 'rental_income' || r.category === 'deposit_in')) b.income += num(r.amount);
    if (r.direction === 'out' && ['rental_expense', 'agent_commission', 'deposit_refund'].includes(r.category)) b.expenses += num(r.amount);
  }
  for (const m of months || []) { m.banked_income = Math.round(banked[m.period]?.income || 0); m.banked_expenses = Math.round(banked[m.period]?.expenses || 0); }
  const closed = (months || []).filter(m => m.closed);
  const recent = closed.slice(-window);
  const avg = recent.length ? sum(recent, m => m.net) / recent.length : 0;
  return { months, avg_net: avg, window: recent.length, total_net: sum(closed, m => m.net), total_gross: sum(closed, m => m.gross), total_expenses: sum(closed, m => m.expenses) };
}

export function position(data, rental, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const fx = num(data.settings?.fx_usd) || 16300;
  const loans = loanPositions(data.loans, data.ledger, today);
  const accounts = accountPositions(data.accounts, data.ledger);
  const commitments = commitmentPositions(data.commitments, data.ledger);
  const receivables = receivablePositions(data.receivables, data.ledger, fx);
  const headline = loans.find(l => l.headline) || loans[0] || null;
  const loanOutstanding = headline ? headline.outstanding : 0;
  const cash = sum(accounts.filter(a => a.counts_as_cash), a => a.computed);
  const remainingCosts = sum(commitments, c => c.remaining);
  const receivablesDue = sum(receivables, r => r.due);
  const netPosition = cash - remainingCosts + receivablesDue;
  const gap = loanOutstanding - netPosition;
  const avg = rental?.avg_net || 0;
  const months = gap > 0 ? (avg > 0 ? Math.ceil(gap / avg) : null) : 0;
  const eta = months == null ? null : addMonths(today.slice(0, 7), months);
  return {
    today, fx_usd: fx,
    loan: headline, loans, accounts, commitments, receivables,
    cash, remaining_costs: remainingCosts, receivables_due: receivablesDue,
    net_position: netPosition, gap, covered: gap <= 0,
    rental_avg_net: avg, months_to_close: months, payoff_eta: eta,
    pnl: projectPnl(data.ledger),
  };
}
