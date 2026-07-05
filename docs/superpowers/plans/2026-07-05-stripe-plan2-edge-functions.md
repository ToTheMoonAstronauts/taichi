# Stripe Integration — Plan 2: Stripe Objects + Edge Functions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the server side of payments — real Stripe subscription checkout, one-click upsells, and webhook-driven provisioning — in **Stripe test mode**, without breaking the currently-live fake flow.

**Architecture:** Three new Supabase Edge Functions (Deno). `create-subscription` and `charge-upsell` are called by the (future) browser with the user's Supabase JWT. `stripe-webhook` is called by Stripe (no JWT), verifies the signature, and is the **only** thing that writes billing columns / provisions access — replicating today's `complete-order` logic but triggered by verified Stripe events. Server-side `PLANS`/`UPSELLS` maps are the sole source of prices; the browser only ever sends an id.

**Tech Stack:** Deno, `npm:stripe@17`, `jsr:@supabase/supabase-js@2`, Supabase Edge Functions, Stripe CLI (local webhook forwarding + test triggers).

## Global Constraints

- **Stripe TEST MODE only** in this plan. No live keys.
- **Currency: USD** (checkout copy is `$`). The `payments.currency` column defaults to `eur` — the webhook writes the actual Stripe currency (`usd`).
- **Do not touch the live flow.** `complete-order` stays deployed and functional until Plan 3 cuts the client over. New functions are additive.
- **Secrets live only in Supabase function env:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Never in the frontend. The frontend gets only the **publishable** key (Plan 3).
- **`stripe-webhook` must be `verify_jwt = false`**; the other two `verify_jwt = true`.
- **Webhook signature verification uses `stripe.webhooks.constructEventAsync`** (Deno/SubtleCrypto — the sync variant throws in Deno) against the **raw request text**.
- **Idempotency:** every webhook event id is recorded in `public.stripe_events` (already exists); replays are ignored.
- **Provisioning writes** (`users` billing columns, `subscriptions`, `payments`) run as **service role** — allowed past the `trg_users_billing_guard` from Plan 1.
- Existing code style (from `complete-order`): `Deno.serve`, a `cors` object, service client via `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.

## Server-side config maps (single source of truth)

Filled with real Stripe test IDs during Task 1. One-time upsells use ad-hoc PaymentIntent amounts (cents); recurring upsells reference a Price.

```ts
// plan_id → { price, coupon }  (recurring price at REGULAR amount + one-time intro coupon)
const PLANS = {
  '1w':  { price: 'price_XXX_1w',  coupon: 'co_XXX_1w'  }, // renews $21.99/wk,  intro $5.19
  '4w':  { price: 'price_XXX_4w',  coupon: 'co_XXX_4w'  }, // renews $49.95/4wk, intro $9.99
  '12w': { price: 'price_XXX_12w', coupon: 'co_XXX_12w' }, // renews $84.95/12wk,intro $19.99
};
// upsell_id → one-time (amount in cents) or recurring (subscription-item price)
const UPSELLS = {
  essential_guides:         { type: 'recurring', price: 'price_XXX_eg_rec' }, // $1.25/day → per-cycle price set at Task 1
  essential_guides_onetime: { type: 'one_time',  amount: 999  },
  guide_sleep:              { type: 'one_time',  amount: 1899 },
  guide_eating:             { type: 'one_time',  amount: 1899 },
  guide_aging:              { type: 'one_time',  amount: 1899 },
  all_guides:               { type: 'recurring', price: 'price_XXX_all_guides' }, // $38.99 bundle
  vip:                      { type: 'one_time',  amount: 499  },
};
```

## File Structure

- `supabase/functions/create-subscription/index.ts` — create Customer + incomplete Subscription, return client secret.
- `supabase/functions/charge-upsell/index.ts` — off-session one-time charge OR add recurring subscription item.
- `supabase/functions/stripe-webhook/index.ts` — verify signature, provision (the `complete-order` logic, event-driven), idempotent.
- (Deploy each via MCP `deploy_edge_function` or `supabase functions deploy`. Keep functions self-contained — duplicate the small `cors`/`PLANS`/`UPSELLS` where needed rather than a shared import, to keep MCP single-file deploys simple.)

---

### Task 1: Create Stripe test-mode objects + fill the config maps

**Files:** none in-repo (Stripe dashboard/API). Records the IDs used by Tasks 3–5.

**Interfaces:**
- Produces: the real `price_*` / `co_*` ids that populate `PLANS` and the recurring `UPSELLS` entries.

- [ ] **Step 1: Confirm you're in Stripe TEST mode** (dashboard toggle top-right). Grab the **test** secret key `sk_test_…` and publishable key `pk_test_…`.

- [ ] **Step 2: Create 3 Products + 3 recurring Prices** (dashboard → Products, or API). Recurring, USD:
  - `1-week` → Price `$21.99` `interval=week`
  - `4-week` → Price `$49.95` `interval=week, interval_count=4`
  - `12-week`→ Price `$84.95` `interval=week, interval_count=12`

- [ ] **Step 3: Create 3 one-time intro coupons** (`duration: once`, `amount_off` in USD cents):
  - 1w: `amount_off = 2199 − 519 = 1680`
  - 4w: `amount_off = 4995 − 999 = 3996`
  - 12w:`amount_off = 8495 − 1999 = 6496`

- [ ] **Step 4: Create recurring upsell Prices** (subscription items, USD, same interval as base — decide the per-cycle amount for `essential_guides` from the "$1.25/day" copy; e.g. on a 4-week cycle ≈ `$35`, confirm the number you want):
  - `essential_guides` recurring price
  - `all_guides` recurring price (`$38.99`)

- [ ] **Step 5: Record all IDs** into the `PLANS`/`UPSELLS` maps (used verbatim in Tasks 3–5). One-time upsells need no Price (ad-hoc PaymentIntent amounts already in the map).

- [ ] **Step 6: Commit the filled maps** (as a snippet file for reference)

```bash
mkdir -p taichi/docs/superpowers/reference
# write the filled PLANS/UPSELLS into stripe-config.md
git add taichi/docs/superpowers/reference/stripe-config.md
git commit -m "docs: Stripe test-mode product/price/coupon ids"
```

---

### Task 2: Set Supabase function secrets

**Files:** none in-repo.

**Interfaces:**
- Produces: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` available to functions. (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` are auto-injected.)

- [ ] **Step 1: Set the Stripe secret key**

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_xxx --project-ref pixtozeghxwiidpnloih
```
(`STRIPE_WEBHOOK_SECRET` is set in Task 6 after the endpoint exists — its value comes from the Stripe CLI / dashboard endpoint.)

- [ ] **Step 2: Verify**

```bash
supabase secrets list --project-ref pixtozeghxwiidpnloih
```
Expected: `STRIPE_SECRET_KEY` listed.

---

### Task 3: `create-subscription` edge function

**Files:**
- Create: `supabase/functions/create-subscription/index.ts`

**Interfaces:**
- Consumes: `PLANS` map; caller's Supabase JWT (Authorization header); `users.stripe_customer_id`.
- Produces: JSON `{ clientSecret: string, subscriptionId: string }`. Consumed by Plan 3 `pay.html`.

- [ ] **Step 1: Write the function**

```ts
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const PLANS: Record<string, { price: string; coupon: string }> = {
  '1w':  { price: 'price_XXX_1w',  coupon: 'co_XXX_1w'  },
  '4w':  { price: 'price_XXX_4w',  coupon: 'co_XXX_4w'  },
  '12w': { price: 'price_XXX_12w', coupon: 'co_XXX_12w' },
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'unauthenticated' }, 401);

    const { plan_id } = await req.json();
    const plan = PLANS[plan_id];
    if (!plan) return json({ error: 'unknown plan' }, 400);

    const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });
    const { data: row } = await svc.from('users').select('stripe_customer_id,email').eq('id', user.id).maybeSingle();

    let customerId = row?.stripe_customer_id as string | null;
    if (!customerId) {
      const c = await stripe.customers.create({ email: user.email ?? row?.email ?? undefined, metadata: { user_id: user.id } });
      customerId = c.id;
      await svc.from('users').update({ stripe_customer_id: customerId }).eq('id', user.id); // service role → past billing guard
    }

    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.price }],
      discounts: [{ coupon: plan.coupon }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { user_id: user.id, plan_id },
    });
    const pi = (sub.latest_invoice as Stripe.Invoice).payment_intent as Stripe.PaymentIntent;
    return json({ clientSecret: pi.client_secret, subscriptionId: sub.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
```

- [ ] **Step 2: Deploy (verify_jwt = true)**

Via MCP `deploy_edge_function` (files: index.ts, verify_jwt: true) or:
```bash
supabase functions deploy create-subscription --project-ref pixtozeghxwiidpnloih
```

- [ ] **Step 3: Smoke test (needs a real user JWT)**

```bash
curl -sX POST https://pixtozeghxwiidpnloih.supabase.co/functions/v1/create-subscription \
  -H "Authorization: Bearer <A_REAL_USER_JWT>" -H "Content-Type: application/json" \
  -d '{"plan_id":"4w"}'
```
Expected: `{"clientSecret":"pi_..._secret_...","subscriptionId":"sub_..."}`. Then confirm in Stripe test dashboard the Customer + incomplete Subscription exist and the first invoice equals the **intro** price.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/create-subscription/index.ts
git commit -m "feat(fn): create-subscription — Stripe Elements base checkout"
```

---

### Task 4: `charge-upsell` edge function

**Files:**
- Create: `supabase/functions/charge-upsell/index.ts`

**Interfaces:**
- Consumes: `UPSELLS` map; caller JWT; `users.stripe_customer_id` + default payment method; user's active subscription id (for recurring).
- Produces: JSON `{ status: 'accepted' | 'requires_action' | 'failed', clientSecret?: string }`. Consumed by Plan 3 upsell pages.

- [ ] **Step 1: Write the function**

```ts
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
type Offer = { type: 'one_time'; amount: number } | { type: 'recurring'; price: string };
const UPSELLS: Record<string, Offer> = {
  essential_guides:         { type: 'recurring', price: 'price_XXX_eg_rec' },
  essential_guides_onetime: { type: 'one_time',  amount: 999  },
  guide_sleep:              { type: 'one_time',  amount: 1899 },
  guide_eating:             { type: 'one_time',  amount: 1899 },
  guide_aging:              { type: 'one_time',  amount: 1899 },
  all_guides:               { type: 'recurring', price: 'price_XXX_all_guides' },
  vip:                      { type: 'one_time',  amount: 499  },
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'unauthenticated' }, 401);

    const { upsell_id } = await req.json();
    const offer = UPSELLS[upsell_id];
    if (!offer) return json({ error: 'unknown upsell' }, 400);

    const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: row } = await svc.from('users').select('stripe_customer_id').eq('id', user.id).maybeSingle();
    const customerId = row?.stripe_customer_id as string | null;
    if (!customerId) return json({ error: 'no customer' }, 400);

    if (offer.type === 'one_time') {
      const cust = await stripe.customers.retrieve(customerId) as Stripe.Customer;
      const pm = cust.invoice_settings?.default_payment_method as string | undefined;
      const pi = await stripe.paymentIntents.create({
        amount: offer.amount, currency: 'usd', customer: customerId,
        payment_method: pm, off_session: true, confirm: true,
        metadata: { user_id: user.id, upsell_id },
      });
      if (pi.status === 'succeeded') return json({ status: 'accepted' });
      if (pi.status === 'requires_action') return json({ status: 'requires_action', clientSecret: pi.client_secret });
      return json({ status: 'failed' });
    } else {
      // recurring: add an item to the user's active subscription
      const { data: sub } = await svc.from('subscriptions').select('id').eq('user_id', user.id)
        .in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (!sub) return json({ error: 'no active subscription' }, 400);
      await stripe.subscriptionItems.create({ subscription: sub.id, price: offer.price });
      return json({ status: 'accepted' });
    }
  } catch (e) {
    // off_session PI that needs auth throws with the PI attached
    const err = e as Stripe.errors.StripeError & { payment_intent?: Stripe.PaymentIntent };
    if (err?.payment_intent?.client_secret)
      return json({ status: 'requires_action', clientSecret: err.payment_intent.client_secret });
    return json({ status: 'failed', error: String(err?.message || err) }, 200);
  }
});
```

- [ ] **Step 2: Deploy (verify_jwt = true)** — as Task 3 Step 2, slug `charge-upsell`.

- [ ] **Step 3: Smoke test** a one-time upsell with a test user who has a saved card (from a completed Task-3 checkout using test card `4242…`). Expected `{"status":"accepted"}`; verify the PaymentIntent in Stripe test dashboard.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/charge-upsell/index.ts
git commit -m "feat(fn): charge-upsell — off-session one-time + recurring add-on"
```

---

### Task 5: `stripe-webhook` edge function (provisioning — source of truth)

**Files:**
- Create: `supabase/functions/stripe-webhook/index.ts`

**Interfaces:**
- Consumes: raw request body + `Stripe-Signature` header + `STRIPE_WEBHOOK_SECRET`; `stripe_events` (idempotency).
- Produces: writes `users` billing columns, `subscriptions`, `payments` (service role). This replaces `complete-order`'s trust-the-client provisioning.

- [ ] **Step 1: Write the function**

```ts
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const WHSEC = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const sig = req.headers.get('Stripe-Signature');
  const body = await req.text();                       // RAW body — required for signature check
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, WHSEC); // async variant for Deno
  } catch (e) {
    return new Response(`bad signature: ${String((e as Error).message)}`, { status: 400 });
  }

  const db = svc();
  // idempotency: ignore replays
  const { error: dupErr } = await db.from('stripe_events').insert({ id: event.id, type: event.type, payload: event as unknown as Record<string, unknown> });
  if (dupErr) return new Response('duplicate', { status: 200 }); // pk conflict = already processed

  try {
    switch (event.type) {
      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string;
        if (subId) await syncSubscription(db, subId);
        await db.from('payments').insert({
          id: inv.id, user_id: await userForCustomer(db, inv.customer as string),
          subscription_id: subId, amount: (inv.amount_paid ?? 0) / 100, currency: inv.currency,
          kind: inv.billing_reason === 'subscription_create' ? 'initial' : 'renewal',
          status: 'succeeded', raw: inv as unknown as Record<string, unknown>,
        });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await syncSubscription(db, (event.data.object as Stripe.Subscription).id);
        break;
      }
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.upsell_id) {
          await db.from('payments').insert({
            id: pi.id, user_id: pi.metadata.user_id, amount: (pi.amount_received ?? 0) / 100,
            currency: pi.currency, kind: 'upsell:' + pi.metadata.upsell_id, status: 'succeeded',
            raw: pi as unknown as Record<string, unknown>,
          });
        }
        break;
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    return new Response(String((e as Error).message), { status: 500 });
  }
});

async function userForCustomer(db: ReturnType<typeof svc>, customerId: string): Promise<string | null> {
  const { data } = await db.from('users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  return data?.id ?? null;
}

// Pull the subscription from Stripe (source of truth) and mirror into users + subscriptions.
async function syncSubscription(db: ReturnType<typeof svc>, subId: string) {
  const sub = await stripe.subscriptions.retrieve(subId);
  const userId = await userForCustomer(db, sub.customer as string);
  if (!userId) return;
  const start = new Date(sub.current_period_start * 1000).toISOString();
  const end = new Date(sub.current_period_end * 1000).toISOString();
  const active = sub.status === 'active' || sub.status === 'trialing';

  await db.from('subscriptions').upsert({
    id: sub.id, user_id: userId, status: sub.status,
    price_id: sub.items.data[0]?.price?.id ?? null,
    current_period_start: start, current_period_end: end,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  await db.from('users').update({                       // service role → past Plan 1 billing guard
    subscription_status: active ? 'active' : sub.status,
    subscription_plan: (sub.metadata?.plan_id as string) ?? undefined,
    current_period_start: start, current_period_end: end,
    cancel_at_period_end: sub.cancel_at_period_end,
  }).eq('id', userId);
}
```

- [ ] **Step 2: Deploy with `verify_jwt = false`**

Via MCP `deploy_edge_function` (verify_jwt: false) or:
```bash
supabase functions deploy stripe-webhook --no-verify-jwt --project-ref pixtozeghxwiidpnloih
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/stripe-webhook/index.ts
git commit -m "feat(fn): stripe-webhook — signed, idempotent provisioning (source of truth)"
```

---

### Task 6: Wire the webhook endpoint + set the signing secret

**Files:** none in-repo.

- [ ] **Step 1: Register the endpoint in Stripe (test mode)**
Stripe → Developers → Webhooks → Add endpoint:
- URL: `https://pixtozeghxwiidpnloih.supabase.co/functions/v1/stripe-webhook`
- Events: `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`, `payment_intent.succeeded`.

- [ ] **Step 2: Copy the endpoint's signing secret and set it**

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx --project-ref pixtozeghxwiidpnloih
```
(Setting a secret redeploys functions; confirm `stripe-webhook` picks it up.)

- [ ] **Step 3: Verify signature handling with a bad payload**

```bash
curl -sX POST https://pixtozeghxwiidpnloih.supabase.co/functions/v1/stripe-webhook \
  -H "Content-Type: application/json" -d '{"fake":true}'
```
Expected: HTTP 400 `bad signature` (proves verification is live and unsigned calls are rejected).

---

### Task 7: End-to-end test in Stripe test mode

**Files:** none in-repo (verification).

- [ ] **Step 1: Forward events locally / trigger from CLI**

```bash
stripe listen --forward-to https://pixtozeghxwiidpnloih.supabase.co/functions/v1/stripe-webhook
```

- [ ] **Step 2: Full base-checkout path**
Using a test user JWT, call `create-subscription` → confirm the PaymentIntent with test card `4242 4242 4242 4242` (via a scratch Elements page or Stripe's hosted test confirm). Then verify:
- `stripe_events` has the `invoice.paid` event id (inserted once).
- `users.subscription_status = 'active'`, `current_period_end` set — **written by the webhook, not the client.**
- `subscriptions` row upserted with the real `sub_…` id and `price_id`.
- `payments` row `kind='initial'`, `currency='usd'`.

- [ ] **Step 3: RLS proof still holds** (re-run Plan 1's guard test): authenticated `update users set subscription_status='active'` → **rejected**.

- [ ] **Step 4: Upsell paths**
- One-time (`vip`): `charge-upsell` → `{status:'accepted'}`; `payments` row `kind='upsell:vip'`.
- 3DS card `4000 0025 0000 3155` on an off-session upsell → `{status:'requires_action', clientSecret}` returned (Plan 3 handles the confirm UI).
- Recurring (`all_guides`): subscription item added; visible on the Stripe subscription.

- [ ] **Step 5: Idempotency**
`stripe events resend <evt_id>` (or re-trigger) → second delivery is a no-op (pk conflict on `stripe_events`, no duplicate `payments` row).

- [ ] **Step 6: Record results** in an execution log appended to this plan; commit.

---

## Self-Review

**Spec coverage (design Section 2 — edge functions):**
- `create-subscription` (Customer + incomplete sub + intro coupon, save default PM) → Task 3. ✅
- `charge-upsell` (one-time off-session + recurring item + SCA `requires_action`) → Task 4. ✅
- `stripe-webhook` (verify_jwt=false, async sig verify, raw body, idempotent, provisions) → Tasks 5–6. ✅
- Server-side `PLANS`/`UPSELLS` maps; browser sends only ids → maps in Tasks 3–4. ✅
- `complete-order` untouched until Plan 3 (per Global Constraints). ✅

**Placeholder scan:** `price_XXX_*` / `co_XXX_*` are Stripe IDs filled in Task 1 (not code placeholders); `<A_REAL_USER_JWT>` / `whsec_xxx` / `sk_test_xxx` are per-environment secrets the executor supplies. All logic is complete.

**Type consistency:** `create-subscription` returns `{clientSecret, subscriptionId}`; `charge-upsell` returns `{status, clientSecret?}`; webhook `syncSubscription(subId)` / `userForCustomer(customerId)` signatures consistent across their call sites.

**Carried to Plan 3:** the browser side (`pay.html` Elements consuming `clientSecret`; upsell pages consuming `charge-upsell` + SCA `requires_action`; provisioning wait on `users`; deleting `complete-order`; moving `setAutoRenew` server-side).

**Execution prerequisites:** Stripe test account + `sk_test`/`pk_test`; ability to deploy Supabase functions (MCP `deploy_edge_function` or `supabase` CLI logged into `pixtozeghxwiidpnloih`); Stripe CLI for Task 7.
