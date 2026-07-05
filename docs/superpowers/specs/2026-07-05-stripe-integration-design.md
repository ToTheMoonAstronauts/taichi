# Stripe Integration — Design Spec

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan
**Scope:** Full payment flow for Tai Motion — base subscription + one-click upsells — with webhook-driven provisioning.

## Context

Tai Motion is a Chair Tai Chi product: a marketing funnel (`taimotion.com`, repo `taichi`) and a members' app (`app.taimotion.com`, repo `taichi_app`), both static sites now hosted on Cloudflare Pages, backed by a shared Supabase project (`pixtozeghxwiidpnloih`). The frontend uses the public anon key; **RLS is the only wall protecting data.**

Today payments are **faked**: `pay.html` sets `paid:true` in `localStorage` and the `complete-order` edge function provisions app access from **client-supplied data** — exploitable once real money is involved. This spec replaces that with a real Stripe integration where **only a signed Stripe webhook can grant access**.

Server logic lives in **Supabase Edge Functions** (Deno) — where `submit-quiz`/`login-link` already run and where secrets can safely live. The browser only ever holds the Stripe *publishable* key.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Scope | Full flow: base subscription **+** one-click upsells |
| Checkout UX | **Stripe Elements** embedded in `pay.html` (no redirect; keeps branded funnel) |
| Upsell billing | **Mixed** per-offer: one-time (PaymentIntent) or recurring (subscription item) |
| Tax / VAT | **Deferred** to a tax advisor; build so **Stripe Tax** switches on later with no rework (collect billing address now) |
| Provisioning / access | **Webhook is the sole source of truth** (Approach A) |

**Trust rule threaded through everything:** the browser sends only a **plan id / upsell id**. All amounts, prices, and coupons are resolved from a **server-side map** in the edge functions. The client never names a price or an amount.

## Architecture

```
pay.html (Stripe Elements)
   │  create-subscription (edge fn) ── Customer + Subscription(incomplete) + intro coupon
   │  confirmPayment() in browser (handles 3DS)          ↑ card saved as default PM
   ▼
Stripe ──(signed webhook: invoice.paid)──▶ stripe-webhook (edge fn, verifies sig)
                                              └─ writes subscription_status=active, current_period_end
   ▼
browser waits on users row (Supabase Realtime) → flips active → upsell1.html
   │  each accepted upsell → charge-upsell (edge fn), off-session on saved card
   ▼
thankyou.html → magic link → app  (hasAccess() truthfully backed by Stripe)
```

## Stripe object model (create in test mode first)

- **3 Products:** `1-week`, `4-week`, `12-week`.
- **1 recurring Price per product** at the **regular renewal amount** + interval:
  - 1-week: `$21.99` `interval=week, interval_count=1`
  - 4-week: `$49.95` `interval=week, interval_count=4`
  - 12-week: `$84.95` `interval=week, interval_count=12`
- **Intro pricing:** a per-plan **one-time coupon** (`duration: once`, `amount_off = regular − intro`) applied at subscription creation. First invoice = intro (`$5.19`/`$9.99`/`$19.99`); every renewal = regular. (Subscription Schedules are the alternative if multi-phase ramps are needed later.)
- **Customer per user:** created on first checkout; `stripe_customer_id` stored on the user; card saved as **default payment method** so upsells charge off-session.
- **Upsell prices/amounts:** defined server-side per offer (one-time → PaymentIntent; recurring → subscription item).

## Edge functions (Supabase, Deno)

**1. `create-subscription`** *(auth required)*
- Input: `{ plan_id }` only → resolve to `{ price_id, intro_coupon }` via server map.
- Find/create Stripe Customer (store `stripe_customer_id`).
- Create Subscription: `items:[{price}]`, `coupon: intro`, `payment_behavior:'default_incomplete'`, `save_default_payment_method:'on_subscription'`, `expand:['latest_invoice.payment_intent']`.
- Return `{ client_secret, subscription_id }`.

**2. `charge-upsell`** *(auth required)*
- Input: `{ upsell_id }` only → resolve to `{ type, price_id|amount }` via server map.
- `type:one_time` → off-session **PaymentIntent** on saved default card (`off_session:true, confirm:true`). On `requires_action` (SCA), return that to the browser for inline authentication.
- `type:recurring` → add a **subscription item** to the user's existing subscription.
- Return status: `accepted` / `needs_auth` / `failed`.

**3. `stripe-webhook`** *(`verify_jwt = false`)*
- Verify Stripe signature with `STRIPE_WEBHOOK_SECRET` against the **raw body** (critical on Deno).
- Idempotent: record each `event.id` in `stripe_events`; ignore replays.
- Handle: `invoice.paid` / `customer.subscription.updated` → write `subscription_status`, `current_period_end`, `stripe_subscription_id`; `customer.subscription.deleted`/past_due → downgrade; `payment_intent.succeeded` (upsell) → record purchase/entitlement.
- **Only code that writes billing columns** (runs as service role).

**4. `login-link`** — unchanged (magic link into app).
**Removed:** `complete-order` client-trust grant.

**Server-side config maps** (single source of truth, in the functions):
```
PLANS   = { "1w": {price:"price_…", coupon:"co_…"}, "4w":{…}, "12w":{…} }
UPSELLS = { "essential_guides": {type:"one_time", amount:999}, …:{type:"recurring", price:"price_…"} }
```

## Database changes + RLS lockdown

**Schema:**
- `users`: add `stripe_customer_id text`, `stripe_subscription_id text`. (Already has `subscription_status`, `current_period_end`, `cancel_at_period_end`.)
- `subscriptions` (exists): mirror of Stripe sub state — service-role write only.
- **`purchases`** (new): `{ user_id, kind, stripe_payment_intent_id|stripe_subscription_item_id, created_at }` — entitlements/upsells owned.
- **`stripe_events`** (new): `{ event_id pk, type, received_at }` — webhook idempotency.

**RLS (the critical part — Postgres RLS is row-level, not column-level):**
- `users` SELECT: own row only.
- `users` UPDATE: **only non-billing columns** (name, units, palette, …). Billing columns (`subscription_status`, `current_period_end`, `stripe_subscription_id`, `stripe_customer_id`, `cancel_at_period_end`) are **not user-writable** — enforced via **column-level `GRANT UPDATE (…)`** to `authenticated` (excluding billing columns) or a `SECURITY DEFINER` profile-edit RPC with direct UPDATE denied.
- `subscriptions`, `purchases`, `stripe_events`: **no client write policy**; service role only. Users get SELECT on own `purchases`/`subscriptions` for display.

**Prerequisite audit:** before money flows, sweep **every** existing table's RLS so the anon key can't read other users' data or self-write billing columns. Any world-readable or self-billing-writable table is a live hole independent of Stripe.

## Client flow

**`pay.html` (rebuilt on Elements):**
1. Load `Stripe.js` + publishable key. Mount **Payment Element** + **Address Element** (billing country/address, for future Stripe Tax).
2. On pay: `create-subscription` `{ plan_id }` → `client_secret`.
3. `stripe.confirmPayment(...)` — handles 3DS/SCA inline; on decline show message + retry.
4. On success (card saved, sub `incomplete→active` pending webhook): show **"finalizing…"** and **wait on the `users` row via Supabase Realtime** (fallback poll ~1.5s, ~20s timeout) until `subscription_status` flips active.
5. Advance to `upsell1.html`. (Timeout → "confirming payment, check your email" — webhook still provisions.)

**`upsell1/2/3.html` (one-click, off-session):**
- Accept → `charge-upsell` `{ upsell_id }`: success → next; `requires_action` → inline `stripe.handleNextAction` SCA confirm → next; failure → soft message, allow continue/decline.
- Decline → next (keeps existing `NEXT` page chaining).

**`thankyou.html`:** finalized order from `purchases`/entitlements (not client `order[]`), then existing magic-link → app handoff.

**App:** no change — `hasAccess()` already gates on `subscription_status`/`current_period_end`, now truthfully webhook-written. The `localStorage` `order[]` becomes display-only.

## Prerequisites & secrets

- Stripe account (test mode first): create Products/Prices/coupons/upsell prices (scriptable via a restricted Stripe test key, or created in dashboard with IDs handed over).
- Webhook endpoint → `stripe-webhook` URL; events: `invoice.paid`, `customer.subscription.updated/deleted`, `payment_intent.succeeded/failed`.
- Supabase edge-function secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. `stripe-webhook` set `verify_jwt=false`.
- Frontend `config.js`: add `Stripe.js` + **publishable** key. `PLANS`/`UPSELLS` maps live in edge functions, not the browser.

## Testing plan

- Stripe test mode + test cards: success, decline, **3DS** (`4000 0025 0000 3155`), off-session-fail.
- Stripe CLI to forward webhooks + `stripe trigger` events.
- Checks:
  1. Base sub → access granted **only after** webhook (not on client confirm).
  2. **RLS proof:** authenticated `update users set subscription_status='active'` is **rejected**.
  3. Upsell one-time + recurring both work off-session.
  4. SCA fallback on off-session upsell surfaces confirm step and completes.
  5. Idempotency: replaying a webhook event doesn't double-provision.
  6. Email (Zoho/Resend records) untouched.

## Out of scope (this round)

- Live-mode launch, tax registration/remittance (advisor-gated).
- Video hosting migration (R2/Stream) — tracked separately.
- Dunning/failed-renewal email sequences beyond status downgrade.
- Refund/chargeback UI (webhook downgrade covers access; ops handled in Stripe dashboard).
