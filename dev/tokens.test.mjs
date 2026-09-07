// Signed report links (lib/tokens.js). The portfolio token is the contract
// with the CRM (kaya-agent-crm/lib/tokens.js carries the same algorithm):
// one Monday link for an owner's whole set of villas.
process.env.LISTING_SYNC_SECRET = 'test-secret';
const { reportToken, verifyReportToken, portfolioToken, verifyPortfolioToken, portfolioSig } = await import('../lib/tokens.js');

let pass = 0, fail = 0;
const t = (name, got, expect) => {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(expect)}`); }
};

const tok = portfolioToken(['villa-saturno', 'haus-1', 'lanehaus-3']);
t('slugs are sorted so the same set always signs the same way', tok.split('~')[0], 'haus-1+lanehaus-3+villa-saturno');
t('round-trips', verifyPortfolioToken(tok), ['haus-1', 'lanehaus-3', 'villa-saturno']);
t('order in the URL does not matter', verifyPortfolioToken('villa-saturno+haus-1+lanehaus-3~' + tok.split('~')[1]), ['haus-1', 'lanehaus-3', 'villa-saturno']);
t('a tampered set fails', verifyPortfolioToken('haus-1+lanehaus-3+villa-rice~' + tok.split('~')[1]), null);
t('a bad signature fails', verifyPortfolioToken('haus-1+lanehaus-3+villa-saturno~0000000000000000'), null);
t('a single-villa report token is not a portfolio', verifyPortfolioToken(reportToken('villa-saturno')), null);
t('a portfolio token is not a single-villa report', verifyReportToken(tok), null);
t('one slug plus a signature is not a portfolio either', verifyPortfolioToken('haus-1~' + portfolioSig(['haus-1'])), null);
t('duplicates collapse', verifyPortfolioToken(portfolioToken(['haus-1', 'haus-1', 'haus-2'])), ['haus-1', 'haus-2']);
t('the signature is 16 hex chars', /^[0-9a-f]{16}$/.test(tok.split('~')[1]), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
