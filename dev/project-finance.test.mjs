// The project-finance maths (lib/project-finance.js): the loan headline and
// the pieces under it, pinned with a small ledger shaped like the real one.
import { position, loanPositions, accountPositions, commitmentPositions, receivablePositions, rentalSeries, projectPnl, accruedInterest, addMonths } from '../lib/project-finance.js';

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

const ledger = [
  { id: 1, entry_date: '2023-04-23', direction: 'in', amount: 2000, category: 'loan_drawdown', counterparty: 'mil', account: 'Oliver Permata', source: 'import' },
  { id: 2, entry_date: '2023-04-23', direction: 'out', amount: 2000, category: 'land', account: 'Oliver Permata', source: 'import' },
  { id: 3, entry_date: '2026-04-16', direction: 'out', amount: 500, category: 'loan_repayment', counterparty: 'mil', account: 'OCBC', source: 'import' },
  { id: 4, entry_date: '2026-07-15', direction: 'in', amount: 250, category: 'rental_income', account: 'OCBC', source: 'import' },
  { id: 5, entry_date: '2026-08-05', direction: 'out', amount: 100, category: 'slf', account: 'OCBC', commitment_id: 7, source: 'manual' },
  { id: 6, entry_date: '2026-08-20', direction: 'in', amount: 300, category: 'unit_sale', counterparty: 'will', account: 'OCBC', source: 'manual' },
  { id: 7, entry_date: '2026-08-31', direction: 'in', amount: 80, category: 'rental_income', source: 'rental', source_ref: 'rental:tropicana-b2:2026-08:income' },
  { id: 8, entry_date: '2026-08-31', direction: 'out', amount: 20, category: 'rental_expense', source: 'rental', source_ref: 'rental:g:2026-08:expense' },
  { id: 9, entry_date: '2026-08-02', direction: 'out', amount: 15, category: 'rental_expense', account: 'OCBC', source: 'import' },
];
const data = {
  settings: { fx_usd: 16000 },
  loans: [{ key: 'mil', lender: 'MIL', principal: 2000, currency: 'IDR', interest_rate: 0, headline: true }],
  accounts: [
    { name: 'OCBC', counts_as_cash: true, balance: 1000, balance_as_of: '2026-07-31' },
    { name: 'Oliver Permata', counts_as_cash: false },
  ],
  commitments: [{ id: 7, name: 'SLF', total: 574, status: 'open' }, { id: 8, name: 'Wall', total: 200, status: 'dropped' }],
  receivables: [
    { id: 1, buyer: 'Will', contract_amount: 0.05, currency: 'USD', fx_rate: 16000, ledger_match: 'will', status: 'open' },  // 800 IDR
    { id: 2, buyer: 'Kate', contract_amount: 1, currency: 'USD', ledger_match: 'kate', status: 'settled' },
    { id: 3, buyer: 'SG', contract_amount: 900, currency: 'IDR', ledger_match: 'singapore', status: 'open', balance_override: 50 },
  ],
  ledger,
};

// Loans
const [mil] = loanPositions(data.loans, ledger, '2026-09-09');
t('loan drawn / repaid / outstanding', [mil.drawn, mil.repaid, mil.outstanding], [2000, 500, 1500]);
t('interest-free loan accrues nothing', mil.interest, 0);
t('a loan with no drawdown on the ledger falls back to the principal (FX applied)',
  loanPositions([{ key: 'x', principal: 10, currency: 'USD', fx_rate: 16000, interest_rate: 0 }], [], '2026-09-09')[0].outstanding, 160000);
t('simple interest: 12% a year on 1000 for 365 days', accruedInterest({ interest_rate: 12 }, [{ date: '2025-09-09', kind: 'in', amount: 1000 }], '2026-09-09'), 120);
t('…and stops accruing on what was repaid', accruedInterest({ interest_rate: 12 }, [{ date: '2025-09-09', kind: 'in', amount: 1000 }, { date: '2026-03-11', kind: 'out', amount: 1000 }], '2026-09-09'), 60);

// Accounts: snapshot rolled forward by rows AFTER the snapshot date only,
// and calendar (source rental) rows never touch a bank balance.
const acc = accountPositions(data.accounts, ledger);
t('OCBC = 1000 − 100 + 300 − 15 (rows after 31 Jul; the 15 Jul rent is inside the balance already)', acc[0].computed, 1185);
t('an account without a balance on file is the ledger from the start', acc[1].computed, 0);
t('has_snapshot flags', [acc[0].has_snapshot, acc[1].has_snapshot], [true, false]);

// Commitments and receivables
const com = commitmentPositions(data.commitments, ledger);
t('SLF paid 100 of 574 → 474 left', [com[0].paid, com[0].remaining], [100, 474]);
t('a dropped commitment has nothing remaining', com[1].remaining, 0);
const rec = receivablePositions(data.receivables, ledger, 16000);
t('Will: USD 0.05 × 16000 = 800, received 300 → 500 due', [rec[0].contract_idr, rec[0].received, rec[0].due], [800, 300, 500]);
t('a settled buyer owes nothing even with no receipts on the ledger', rec[1].due, 0);
t('an override wins over the computed balance', [rec[2].computed_due, rec[2].due], [900, 50]);

// Rental series: trailing average over closed months, banked from cash rows
const months = [
  { period: '2026-06', gross: 100, expenses: 40, net: 60, closed: true },
  { period: '2026-07', gross: 200, expenses: 50, net: 150, closed: true },
  { period: '2026-08', gross: 80, expenses: 20, net: 60, closed: true },
  { period: '2026-09', gross: 500, expenses: 0, net: 500, closed: false },
];
const rs = rentalSeries(months, { window: 3, ledger });
t('average net over the last 3 closed months', rs.avg_net, 90);
t('the open month is not in the average or totals', rs.total_net, 270);
t('banked per month comes from bank/manual rows, not calendar rows', [months[1].banked_income, months[2].banked_income, months[2].banked_expenses], [250, 0, 15]);

// P&L: calendar rows are reported apart, never added to the cash figures
const pnl = projectPnl(ledger);
t('build cost = land + slf', pnl.build_cost, 2100);
t('rental income on a cash basis', [pnl.rental_income, pnl.rental_expense], [250, 15]);
t('calendar totals kept apart', [pnl.calendar_income, pnl.calendar_expense], [80, 20]);

// The headline
const pos = position(data, rs, { today: '2026-09-09' });
t('cash counts only cash accounts', pos.cash, 1185);
t('remaining costs', pos.remaining_costs, 474);
t('receivables due', pos.receivables_due, 550);
t('net position = cash − costs + receivables', pos.net_position, 1261);
t('gap = outstanding − net position', pos.gap, 239);
t('months to close at the trailing average', pos.months_to_close, 3);
t('payoff month', pos.payoff_eta, '2026-12');
t('covered when the position exceeds the loan', position({ ...data, commitments: [] }, rs, { today: '2026-09-09' }).covered, true);
t('no rental average → months unknown, not zero', position(data, { avg_net: 0 }, { today: '2026-09-09' }).months_to_close, null);
t('addMonths crosses a year', addMonths('2026-11', 3), '2027-02');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
