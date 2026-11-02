require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || '';
const APP_BASE = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// Double-tap / expiry rules (see docs/PRD.md §4.3–§4.5):
// - One active pending payment per sale: repeat initiate for the same link +
//   customer email reuses the recent pending reference instead of inserting.
// - Pending rows expire after PENDING_TTL_HOURS and stop showing as active.
const PENDING_TTL_HOURS = Number(process.env.PENDING_TTL_HOURS || 24);
const REUSE_WINDOW_MINUTES = Number(process.env.PENDING_REUSE_MINUTES || 30);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    amount_kobo INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    reference TEXT NOT NULL UNIQUE,
    amount_kobo INTEGER NOT NULL,
    customer_email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    paystack_id INTEGER,
    paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expired_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_link_email_status ON payments(link_id, customer_email, status);
  CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
`);

// Expired pending rows stop appearing as active: GET /api/payments and the
// verify/webhook paths treat pending rows older than the TTL as expired.
function pendingCutoffExpr() {
  return `datetime('now', '-${PENDING_TTL_HOURS} hours')`;
}
function reuseCutoffExpr() {
  return `datetime('now', '-${REUSE_WINDOW_MINUTES} minutes')`;
}

// Mark stale pending rows expired so they leave the active list without
// manual work. Runs inline on reads/writes (single server, no cron).
function expireStalePending() {
  try {
    db.prepare(
      `UPDATE payments SET status = 'expired', expired_at = COALESCE(expired_at, datetime('now'))
       WHERE status = 'pending' AND created_at < ${pendingCutoffExpr()}`
    ).run();
  } catch (e) { /* expiry is best-effort; reads still filter by cutoff */ }
}

// In-memory sliding-window rate limiter (single server): slows repeated
// tries on sign-in and payment start so one script cannot block others.
const rateBuckets = new Map();

// created_at is stored as "YYYY-MM-DD HH:MM:SS" (UTC); compare in SQL where
// possible, and here with a Date threshold for single-row checks.
function isPendingExpired(payment) {
  if (!payment || payment.status !== 'pending') return false;
  const created = Date.parse(String(payment.created_at || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(created)) return false;
  return Date.now() - created > PENDING_TTL_HOURS * 3600 * 1000;
}
function rateLimit(req, res, next) {
  const now = Date.now();
  const key = (req.ip || 'unknown') + ':' + req.path;
  let hits = rateBuckets.get(key) || [];
  hits = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'too_many_requests' });
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  next();
}
function resetRateLimits() { rateBuckets.clear(); }

// --- helpers ---
const naira = (kobo) => (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function newCode() {
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString('hex');
    if (!db.prepare('SELECT 1 FROM links WHERE code = ?').get(code)) return code;
  }
  return crypto.randomBytes(6).toString('hex');
}

function newReference() {
  return 'LGP_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function signSession(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function paystackHeaders() {
  return { Authorization: `Bearer ${PAYSTACK_SECRET}`, 'Content-Type': 'application/json' };
}

async function paystackVerify(reference) {
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: paystackHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(body.message || 'paystack_verify_failed');
  return body.data;
}

function markPaid(payment, data) {
  db.prepare(
    `UPDATE payments SET status = 'paid', paystack_id = ?, customer_email = ?, paid_at = COALESCE(paid_at, datetime('now')) WHERE id = ?`
  ).run(data && data.id ? data.id : payment.paystack_id, (data && data.customer && data.customer.email) || payment.customer_email, payment.id);
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
}

// --- middleware ---
function auth(req, res, next) {
  const token = req.cookies && req.cookies.sid;
  if (!token) return res.status(401).json({ error: 'not_logged_in' });
  const row = db.prepare('SELECT m.* FROM sessions s JOIN merchants m ON m.id = s.merchant_id WHERE s.token = ?').get(token);
  if (!row) return res.status(401).json({ error: 'not_logged_in' });
  req.merchant = row;
  next();
}

// Webhook needs the RAW body for signature check — register before express.json().
app.post('/webhook/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
    const signature = req.headers['x-paystack-signature'] || '';
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(req.body).digest('hex');
    if (signature !== expected) return res.status(401).json({ error: 'bad_signature' });
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'charge.success' && event.data && event.data.reference) {
      const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(event.data.reference);
      if (payment && payment.status === 'pending' && isPendingExpired(payment)) {
        db.prepare(`UPDATE payments SET status = 'expired', expired_at = COALESCE(expired_at, datetime('now')) WHERE id = ?`).run(payment.id);
      } else if (payment && payment.status !== 'paid' && payment.status !== 'refunded') {
        try {
          const data = await paystackVerify(event.data.reference);
          if (data.status === 'success' && data.amount === payment.amount_kobo) markPaid(payment, data);
        } catch (e) { /* leave pending; client-side verify will retry */ }
      }
    }
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: 'bad_webhook' });
  }
});
app.use(express.json());
app.use(cookieParser());

// --- auth ---
app.post('/api/auth/signup', rateLimit, (req, res) => {
  const { businessName, email, password } = req.body || {};
  if (!businessName || !businessName.trim()) return res.status(400).json({ error: 'business_name_required' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password_min_6' });
  const exists = db.prepare('SELECT 1 FROM merchants WHERE email = ?').get(email.toLowerCase());
  if (exists) return res.status(409).json({ error: 'email_taken' });
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO merchants (business_name, email, password_hash) VALUES (?, ?, ?)').run(
    businessName.trim(), email.toLowerCase(), hash
  );
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, merchant_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/auth/login', rateLimit, (req, res) => {
  const { email, password } = req.body || {};
  const m = db.prepare('SELECT * FROM merchants WHERE email = ?').get((email || '').toLowerCase());
  if (!m || !bcrypt.compareSync(password || '', m.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, merchant_id) VALUES (?, ?)').run(token, m.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({
    id: req.merchant.id,
    businessName: req.merchant.business_name,
    email: req.merchant.email,
    paystackConfigured: Boolean(PAYSTACK_PUBLIC && PAYSTACK_SECRET),
  });
});

// --- merchant: links ---
app.post('/api/links', auth, (req, res) => {
  const { amountNaira, title, description } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title_required' });
  const n = Number(amountNaira);
  if (!Number.isFinite(n) || n <= 0 || n > 10000000) return res.status(400).json({ error: 'amount_invalid' });
  const amountKobo = Math.round(n * 100);
  const code = newCode();
  const info = db.prepare(
    'INSERT INTO links (merchant_id, code, title, description, amount_kobo) VALUES (?, ?, ?, ?, ?)'
  ).run(req.merchant.id, code, String(title).trim(), String(description || '').trim(), amountKobo);
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(info.lastInsertRowid);
  res.json({ ...link, url: `${APP_BASE}/pay/${link.code}`, amountNaira: naira(link.amount_kobo) });
});

app.get('/api/links', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM links WHERE merchant_id = ? ORDER BY id DESC').all(req.merchant.id);
  res.json(rows.map((l) => ({ ...l, url: `${APP_BASE}/pay/${l.code}`, amountNaira: naira(l.amount_kobo) })));
});

// --- merchant: payments + refund ---
app.get('/api/payments', auth, (req, res) => {
  expireStalePending();
  const rows = db.prepare(
    `SELECT p.*, l.title AS link_title FROM payments p JOIN links l ON l.id = p.link_id
     WHERE p.merchant_id = ?
       AND NOT (p.status = 'pending' AND p.created_at < ${pendingCutoffExpr()})
     ORDER BY p.id DESC LIMIT 200`
  ).all(req.merchant.id);
  res.json(rows.map((p) => ({ ...p, amountNaira: naira(p.amount_kobo) })));
});

app.post('/api/payments/:id/refund', auth, async (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND merchant_id = ?').get(req.params.id, req.merchant.id);
  if (!p) return res.status(404).json({ error: 'payment_not_found' });
  if (p.status !== 'paid') return res.status(400).json({ error: 'only_paid_can_refund' });
  if (!p.paystack_id) return res.status(400).json({ error: 'no_paystack_transaction' });
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
  try {
    const r = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: paystackHeaders(),
      body: JSON.stringify({ transaction: p.paystack_id }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.status) return res.status(502).json({ error: body.message || 'refund_failed' });
    const status = body.data && body.data.status === 'pending' ? 'refund_pending' : 'refunded';
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, p.id);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(502).json({ error: 'refund_failed' });
  }
});

// --- public: pay flow ---
app.get('/api/pay/:code', (req, res) => {
  const link = db.prepare(
    'SELECT l.*, m.business_name FROM links l JOIN merchants m ON m.id = l.merchant_id WHERE l.code = ?'
  ).get(req.params.code);
  if (!link) return res.status(404).json({ error: 'link_not_found' });
  res.json({
    title: link.title,
    description: link.description,
    amountKobo: link.amount_kobo,
    amountNaira: naira(link.amount_kobo),
    businessName: link.business_name,
  });
});

app.post('/api/pay/:code/initiate', rateLimit, (req, res) => {
  expireStalePending();
  if (!PAYSTACK_PUBLIC || !PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
  const link = db.prepare('SELECT * FROM links WHERE code = ?').get(req.params.code);
  if (!link) return res.status(404).json({ error: 'link_not_found' });
  const email = String((req.body || {}).email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid_email_required' });
  const lowerEmail = email.toLowerCase();
  // Double-tap rule: one active pending payment per sale. Repeat initiate
  // for the same link + email within the reuse window returns the existing
  // reference so the merchant sees one pending row and the customer sees
  // one clear payment to finish.
  const existing = db.prepare(
    `SELECT * FROM payments WHERE link_id = ? AND customer_email = ? AND status = 'pending'
     AND amount_kobo = ? AND created_at >= ${reuseCutoffExpr()}
     ORDER BY id DESC LIMIT 1`
  ).get(link.id, lowerEmail, link.amount_kobo);
  if (existing) {
    return res.json({
      publicKey: PAYSTACK_PUBLIC,
      reference: existing.reference,
      amountKobo: link.amount_kobo,
      email: lowerEmail,
      reused: true,
      message: 'A payment is already in progress for this sale — finish it instead of starting a new one.',
    });
  }
  const reference = newReference();
  try {
    db.prepare(
      'INSERT INTO payments (link_id, merchant_id, reference, amount_kobo, customer_email) VALUES (?, ?, ?, ?, ?)'
    ).run(link.id, link.merchant_id, reference, link.amount_kobo, lowerEmail);
  } catch (e) {
    // Concurrent double tap: re-read the row the other request just created.
    const raced = db.prepare(
      `SELECT * FROM payments WHERE link_id = ? AND customer_email = ? AND status = 'pending'
       AND amount_kobo = ? ORDER BY id DESC LIMIT 1`
    ).get(link.id, lowerEmail, link.amount_kobo);
    if (raced) {
      return res.json({
        publicKey: PAYSTACK_PUBLIC,
        reference: raced.reference,
        amountKobo: link.amount_kobo,
        email: lowerEmail,
        reused: true,
        message: 'A payment is already in progress for this sale — finish it instead of starting a new one.',
      });
    }
    throw e;
  }
  res.json({ publicKey: PAYSTACK_PUBLIC, reference, amountKobo: link.amount_kobo, email: lowerEmail, reused: false });
});

app.post('/api/pay/:code/verify', rateLimit, async (req, res) => {
  expireStalePending();
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'paystack_not_configured' });
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference_required' });
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!payment) return res.status(404).json({ error: 'payment_not_found' });
  // Expired pending rows are no longer active: tell the customer to restart.
  if (payment.status === 'expired' || isPendingExpired(payment)) {
    return res.status(410).json({ error: 'payment_expired', message: 'This payment expired — please start again from the payment link.' });
  }
  const link = db.prepare('SELECT * FROM links WHERE id = ?').get(payment.link_id);
  if (!link || link.code !== req.params.code) return res.status(400).json({ error: 'reference_mismatch' });
  if (payment.status === 'paid') return res.json({ ok: true, status: 'paid' });
  try {
    const data = await paystackVerify(reference);
    if (data.status === 'success' && data.amount === payment.amount_kobo) {
      markPaid(payment, data);
      return res.json({ ok: true, status: 'paid' });
    }
    db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('failed', payment.id);
    return res.json({ ok: false, status: data.status || 'failed' });
  } catch (e) {
    return res.status(502).json({ error: 'verify_failed' });
  }
});

// --- pages ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/pay/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Merchant payments live on ${APP_BASE}`));
}

module.exports = { app, db, resetRateLimits, expireStalePending, isPendingExpired, PENDING_TTL_HOURS, REUSE_WINDOW_MINUTES, RATE_LIMIT_MAX };
