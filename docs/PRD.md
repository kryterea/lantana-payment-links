# PRD — LagosPay (Demo Merchant Payments)

**Version:** 1.0 — 28 Oct 2026
**Status:** Live demo / MVP
**Audience:** Team + clients

## 1. Overview

LagosPay is a payment-link product for small businesses in Lagos, Nigeria.

A business signs up, creates a payment link with an amount and description, and shares it (e.g. via WhatsApp). The customer opens the link and pays with Paystack (cards, bank transfer, USSD). The business tracks payments on a dashboard and can issue full refunds.

Tech summary: Node.js + Express (`server.js`), SQLite via `better-sqlite3` (`data.db`, auto-created), Paystack Inline popup + server-side verification + webhook. No framework on the frontend — static pages in `public/` (`index.html`, `dashboard.html`, `pay.html`).

## 2. Problem and goals

**Problem:** Small businesses (e.g. market stalls, hair salons, fabric sellers) have no simple way to collect remote payments without building a store or handling cash on delivery.

**Goals (current MVP):**

1. Let a merchant create a shareable payment link in under 30 seconds.
2. Let a customer pay without creating an account.
3. Give the merchant a single view of links and payment statuses.
4. Support full refunds from the dashboard.

**Non-goals (current MVP):** No shopping cart, no inventory, no partial refunds, no multi-staff roles, no payouts/split payments, no mobile app.

## 3. Users

| User | Needs |
|---|---|
| Merchant (small business owner) | Sign up / log in, create links, share them, confirm who paid, refund when needed. |
| Customer (buyer) | Open a link on a phone, see what it is for and the amount in naira, pay via Paystack, get confirmation. |

## 4. What exists today

### 4.1 Auth and merchant account

- Signup: `POST /api/auth/signup` with `{businessName, email, password}` (min 6 chars, bcrypt hash, email unique, case-insensitive).
- Login/logout with httpOnly session cookie (`sid`, 7-day expiry): `POST /api/auth/login`, `POST /api/auth/logout`.
- Current merchant: `GET /api/me` returns business name, email, and a `paystackConfigured` flag.
- Pages: `/` (landing + signup/login forms), `/dashboard` (protected client-side; redirects to `/` on 401).

### 4.2 Payment links

- Create: `POST /api/links` with `{amountNaira, title, description?}`. Amount validated: > 0, ≤ ₦10,000,000, stored in **kobo** (integer).
- List: `GET /api/links` — merchant's own links, newest first, each with a shareable URL `${APP_BASE_URL}/pay/:code`.
- Link code: random 8-hex string (`crypto.randomBytes(4)`), unique in `links.code`.
- Dashboard (`public/dashboard.html`): create-link form, link list with copyable URLs, validation errors shown inline.

### 4.3 Customer pay flow

1. Customer opens `GET /pay/:code` (static `public/pay.html`, data loaded from `GET /api/pay/:code`).
2. Page shows business name, title, description, amount in ₦.
3. Customer enters email → `POST /api/pay/:code/initiate` creates a `pending` payment row with a unique reference (`LGP_...`) and returns `{publicKey, reference, amountKobo, email}`.
   **Repeat-tap rule:** tapping Pay twice for the same link + customer email (case-insensitive) within 30 minutes reuses the open `pending` reference and returns `{reused: true}` plus a customer message ("A payment is already in progress for this sale — finish it instead of starting a new one"). The merchant sees only one active `pending` row per sale; paid rows are never reused. Concurrent double taps are guarded by re-reading the just-created row instead of inserting a second.
   **Request limits:** signup, login, initiate, and verify are rate-limited to 10 tries per minute per IP per route; excess calls return `429 { error: "too_many_requests" }` with a `Retry-After` header, and the pay page asks the customer to wait before retrying.
4. Paystack Inline popup (`https://js.paystack.co/v1/inline.js`) collects payment in NGN.
5. On popup callback, client calls `POST /api/pay/:code/verify` with `{reference}`. Server calls Paystack `GET /transaction/verify/:reference`, checks `status === 'success'` **and** amount matches, then marks payment `paid` (idempotent — re-verify of an already-paid payment returns success).
6. Webhook `POST /webhook/paystack` runs in parallel: verifies `x-paystack-signature` (HMAC-SHA512 of raw body with secret key), handles `charge.success`, re-verifies with Paystack, and marks paid. Both paths are idempotent.
7. Customer sees a success screen; merchant sees `paid` in the dashboard.

Graceful degradation: without `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY`, initiate/verify/refund return `503 { error: "paystack_not_configured" }` and the dashboard shows a banner. Signup, link creation, and link listing still work for demo purposes.

### 4.4 Dashboard payments and refunds

- List: `GET /api/payments` — merchant's payments joined with link titles, newest first (limit 200), amounts formatted in ₦. Stale `pending` rows past their lifetime are marked `expired` and excluded from the active list (see §4.5).
- Statuses: `pending`, `paid`, `failed`, `refunded`, `refund_pending`, `expired`.
- Refund: `POST /api/payments/:id/refund` — only `paid` payments with a stored `paystack_id`. Calls Paystack `POST /refund` with the transaction id. `refunded` on success, `refund_pending` if Paystack queues it. Full refunds only.
- UI: payments table with status pills and a per-row Refund button (with confirm dialog).

### 4.5 Data model (SQLite)

- `merchants(id, business_name, email UNIQUE, password_hash, created_at)`
- `sessions(token PK, merchant_id, created_at)`
- `links(id, merchant_id, code UNIQUE, title, description, amount_kobo, created_at)`
- `payments(id, link_id, merchant_id, reference UNIQUE, amount_kobo, customer_email, status, paystack_id, paid_at, created_at, expired_at)`
- **Pending lifetime:** `pending` rows expire 24 hours after `created_at` (`PENDING_TTL_HOURS`, overridable via env). Expiry is applied inline on reads/writes (`expireStalePending()`): expired rows get `status = 'expired'` + `expired_at`, stop appearing as active in `GET /api/payments`, and `verify`/webhook reject them (`410 { error: "payment_expired" }` → customer restarts from the link). The dashboard shows `expired` with its own pill so old rows leave the active list without manual work.
- Lookup indexes: `(link_id, customer_email, status)` for the repeat-tap reuse query, `(status, created_at)` for expiry.

### 4.6 Configuration

`.env` keys (see `.env.example`): `PORT`, `SESSION_SECRET`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `APP_BASE_URL` (used to build shareable links), `PENDING_TTL_HOURS` (default 24), `PENDING_REUSE_MINUTES` (default 30).

## 5. Current limitations (known)

- Single-server sessions and in-memory rate limiting (resets on restart); no password reset or email verification.
- One-time payments only — no recurring billing (see §6).
- Full refunds only; no partial refunds, no dispute handling.
- No search/filter/export on payments; list capped at 200.
- Links cannot be edited, disabled, or given expiry dates or stock limits.
- No customer receipts beyond the Paystack confirmation; no merchant notifications (email/SMS).
- Amount mismatch on verify marks payment `failed` with no retry UI for the customer.

## 6. What is next — Monthly Subscriptions (priority feature)

**Objective:** Let merchants sell monthly recurring offerings (e.g. "Monthly hair-care plan — ₦15,000/mo", "Ankara subscription box") via a subscription link, with automatic monthly charges through Paystack.

### 6.1 User stories

1. As a merchant, I create a **subscription plan** with a name, monthly amount (₦), and optional description, and get a shareable link.
2. As a customer, I open the link, enter my email, and authorize recurring monthly charges via Paystack.
3. As a merchant, I see active / cancelled / past-due subscriptions and per-cycle payment history on the dashboard.
4. As a merchant, I can cancel a subscription on behalf of a customer; as a customer, I can cancel via a manage link (email-based token).
5. As a merchant, I get notified (dashboard + email, phase 2) when a renewal succeeds or fails.

### 6.2 Proposed behavior

- New link type: `links.billing_type` = `one_time | subscription` plus a `plans` table (`id, merchant_id, link_id, paystack_plan_code, amount_kobo, interval='monthly', status`).
- Creation flow reuses the existing dashboard form with a "One-time / Monthly" toggle.
- Checkout uses Paystack **Plans + Subscriptions API** (`POST /plan`, transaction initialize with `plan` code to capture an authorization) instead of Inline one-off. First charge happens at signup; subsequent charges are automatic.
- Webhook extended: handle `subscription.create`, `subscription.disable`, `invoice.payment_failed` / `charge.success` for renewals, updating subscription status and appending to payment history (one row per cycle).
- Dashboard additions: Subscriptions tab (status, customer, next charge date, cycle count), Cancel button (`POST /api/subscriptions/:id/cancel` → Paystack `POST /subscription/disable`), per-plan revenue summary.
- Customer manage page: `GET /sub/:code` shows plan details, status, next billing date, and a cancel action gated by an emailed token.

### 6.3 Paystack integration notes

- Requires Paystack **plans** (`/plan`) and **subscriptions** (`/subscription`) endpoints; amounts still in kobo, currency NGN.
- Webhook signature check already exists — reuse it for the new event types.
- Renewal verification reuses `paystackVerify()` + amount check pattern from one-time flow.

### 6.4 Acceptance criteria (for sign-off)

- [ ] Merchant can create a monthly plan and share its link.
- [ ] Customer can subscribe and is charged the first month immediately.
- [ ] Renewal charges produce new `paid` payment rows linked to the subscription.
- [ ] Failed renewals mark the subscription `past_due` and are visible on the dashboard.
- [ ] Merchant cancel stops future charges (verified against Paystack).
- [ ] Existing one-time links and refunds keep working unchanged.

### 6.5 Out of scope for v1 of subscriptions

Proration, plan upgrades/downgrades mid-cycle, weekly/annual intervals, trials, coupons, and dunning emails. These go to a later phase.

## 7. Later roadmap (after subscriptions)

1. Link controls: edit, disable, expiry dates, usage limits.
2. Payments UX: search, filter by status/date, CSV export.
3. Notifications: customer receipts, merchant new-payment emails, failed-renewal reminders.
4. Partial refunds and refund reasons.
5. Multi-user merchant accounts and basic analytics (revenue by link/month).

## 8. Success metrics

- Links created per merchant; share-to-paid conversion rate.
- Time from signup to first paid link.
- Refund rate and failed-payment rate.
- (After §6) Active subscriptions, monthly recurring revenue, renewal success rate, churn.
