// Tests for: "Tapping Pay twice shows one clear payment that expires if not finished".
// Run: node --test tests/pay-twice.test.js  (needs PAYSTACK keys stubbed below)
process.env.PORT = '0';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_stub';
process.env.PAYSTACK_PUBLIC_KEY = 'pk_test_stub';
process.env.SESSION_SECRET = 'test-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { app, db, resetRateLimits, expireStalePending } = require('../server.js');

let server;
let base;
let cookie = '';
let linkCode = '';
let merchantId = 0;

async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Merchant + link via the real API so auth cookie is exercised.
  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ businessName: 'Test Shop', email: 'PayTwice@example.com', password: 'secret123' }),
  });
  assert.equal(signup.res.status, 200);
  cookie = signup.res.headers.get('set-cookie').split(';')[0];
  merchantId = db.prepare('SELECT id FROM merchants WHERE email = ?').get('paytwice@example.com').id;

  const created = await api('/api/links', {
    method: 'POST',
    body: JSON.stringify({ amountNaira: 2500, title: 'Test item', description: 'dedupe test' }),
  });
  assert.equal(created.res.status, 200);
  linkCode = created.body.code;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.prepare('DELETE FROM merchants WHERE id = ?').run(merchantId);
});

describe('double-tap dedupe', () => {
  it('tapping Pay twice returns the same reference, one pending row', async () => {
    const first = await api(`/api/pay/${linkCode}/initiate`, {
      method: 'POST',
      body: JSON.stringify({ email: 'customer@example.com' }),
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.reused, false);

    const second = await api(`/api/pay/${linkCode}/initiate`, {
      method: 'POST',
      body: JSON.stringify({ email: 'customer@example.com' }),
    });
    assert.equal(second.res.status, 200);
    assert.equal(second.body.reused, true);
    assert.equal(second.body.reference, first.body.reference);
    assert.match(second.body.message || '', /already in progress/);

    const rows = db.prepare(
      `SELECT * FROM payments WHERE link_id = (SELECT id FROM links WHERE code = ?) AND customer_email = ?`
    ).all(linkCode, 'customer@example.com');
    assert.equal(rows.length, 1);
  });

  it('email match is case-insensitive', async () => {
    const third = await api(`/api/pay/${linkCode}/initiate`, {
      method: 'POST',
      body: JSON.stringify({ email: 'CUSTOMER@EXAMPLE.COM' }),
    });
    assert.equal(third.res.status, 200);
    assert.equal(third.body.reused, true);
    const rows = db.prepare(
      `SELECT * FROM payments WHERE link_id = (SELECT id FROM links WHERE code = ?) AND customer_email = ?`
    ).all(linkCode, 'customer@example.com');
    assert.equal(rows.length, 1);
  });
});

describe('pending expiry', () => {
  it('stale pending rows are marked expired and leave the active list', async () => {
    db.prepare(
      `INSERT INTO payments (link_id, merchant_id, reference, amount_kobo, customer_email, status, created_at)
       VALUES ((SELECT id FROM links WHERE code = ?), ?, 'LGP_oldstale', 250000, 'stale@example.com', 'pending',
               datetime('now', '-25 hours'))`
    ).run(linkCode, merchantId);

    expireStalePending();
    const row = db.prepare('SELECT * FROM payments WHERE reference = ?').get('LGP_oldstale');
    assert.equal(row.status, 'expired');
    assert.ok(row.expired_at);

    const list = await api('/api/payments');
    assert.equal(list.res.status, 200);
    // Expired rows stop appearing as *active*: no longer pending, shown as expired.
    assert.ok(!list.body.some((p) => p.reference === 'LGP_oldstale' && p.status === 'pending'), 'expired row must not appear as active/pending');
    const shown = list.body.find((p) => p.reference === 'LGP_oldstale');
    assert.equal(shown && shown.status, 'expired');

    // Fresh pending from the double-tap test still shows as active.
    assert.ok(list.body.some((p) => p.status === 'pending'));

    db.prepare('DELETE FROM payments WHERE reference = ?').run('LGP_oldstale');
  });

  it('verify on an expired payment returns 410 with restart guidance', async () => {
    db.prepare(
      `INSERT INTO payments (link_id, merchant_id, reference, amount_kobo, customer_email, status, created_at)
       VALUES ((SELECT id FROM links WHERE code = ?), ?, 'LGP_verifyexpired', 250000, 'gone@example.com', 'expired',
               datetime('now', '-25 hours'))`
    ).run(linkCode, merchantId);
    resetRateLimits();
    const v = await api(`/api/pay/${linkCode}/verify`, {
      method: 'POST',
      body: JSON.stringify({ reference: 'LGP_verifyexpired' }),
    });
    assert.equal(v.res.status, 410);
    assert.equal(v.body.error, 'payment_expired');
    db.prepare('DELETE FROM payments WHERE reference = ?').run('LGP_verifyexpired');
  });
});

describe('rate limiting', () => {
  it('11 rapid login tries get 429 with Retry-After', async () => {
    resetRateLimits();
    let lastStatus = 0;
    let retryAfter = null;
    for (let i = 0; i < 11; i++) {
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
      });
      lastStatus = r.res.status;
      if (lastStatus === 429) retryAfter = r.res.headers.get('retry-after');
    }
    assert.equal(lastStatus, 429);
    assert.ok(retryAfter, '429 must carry Retry-After');
  });
});
