// Minimal error capture for the serverless functions. Appends caught errors to
// a capped Redis list (`errors:recent`, newest first, ~200 kept) that the admin
// console reads via /api/dashboard?errors=1. Deliberately tiny and dependency-
// free — it's a "something broke, and roughly what" signal for a solo operator,
// not a full APM. Logging must never throw or block the response, so every path
// swallows its own failures.
export async function logError(kvUrl, kvToken, context, err, meta = {}) {
  if (!kvUrl || !kvToken) return;
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      context: String(context || 'unknown').slice(0, 80),
      message: (err && err.message ? err.message : String(err)).slice(0, 500),
      stack: (err && err.stack ? String(err.stack) : '').split('\n').slice(0, 4).join('\n'),
      ...meta,
    });
    await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['LPUSH', 'errors:recent', entry],
        ['LTRIM', 'errors:recent', '0', '199'],
      ]),
    });
  } catch { /* logging failures are never fatal */ }
}
