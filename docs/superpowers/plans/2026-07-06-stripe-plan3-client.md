# Stripe Integration — Plan 3: Client Rebuild (Elements + upsells) & anonymous-checkout auth

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the funnel's fake payment with a real Stripe Elements checkout + one-click upsells, driven by the anonymous funnel visitor (identified by quiz email + a capability token), with provisioning still coming only from the webhook.

**Architecture:** The funnel stays **anonymous** (no Supabase session). `create-subscription` (revised: `verify_jwt=false`) takes the quiz `email`, creates/links the auth user + Stripe customer server-side, creates the incomplete subscription, and returns `{clientSecret, subscriptionId, checkoutToken}`. `pay.html` mounts Elements with the `clientSecret`. Upsell pages call `charge-upsell` (revised: `verify_jwt=false`) passing `{subscriptionId, checkoutToken, upsell_id}` — the token (stored in the base sub's Stripe metadata) proves the caller owns this checkout, so it's safe to charge the saved card. The webhook provisions `users` access; `thankyou.html` gets a magic link (`login-link`) into the app. `complete-order` is retired.

**Tech Stack:** Stripe.js v3 + Elements (browser), Deno edge functions, Cloudflare Pages (funnel deploy via `wrangler`), Supabase.

## Global Constraints

- **Funnel is anonymous** — no supabase-js in the funnel; keep using `assets/api.js` plain `fetch` + add Stripe.js only on `pay`/`upsell` pages.
- **Publishable key only in the browser:** `pk_test_51Tq6eVEKxtNHIkyEH26s3Yb09P17pwsgrnl3e8ylSrOGhv2ODsw4mVh2IU3Nycl2vSY9afNCWSD0QHJubdo64Fos00roD8Yf2g`. Secret key stays server-side.
- **Capability token** (`checkoutToken`) = `crypto.randomUUID()`, stored in the base subscription's Stripe `metadata.checkout_token`; returned once to the client; required by `charge-upsell`.
- **Currency USD**; amounts resolved server-side (client sends only ids).
- **Funnel deploys via `wrangler pages deploy`** (project `taimotion`) — NOT git auto-deploy. Edit → deploy.
- Keep the existing funnel look, page sequence, and theme engine intact.
- `?t=g` theme carry + cross-domain cookie behavior unchanged.

## File Structure

- Modify (edge, redeploy): `supabase/functions/create-subscription/index.ts`, `supabase/functions/charge-upsell/index.ts`
- Modify (funnel): `assets/api.js` (add createSubscription/chargeUpsell wrappers), `pay.html` (Elements), `upsell1.html`, `upsell2.html`, `upsell3.html`, `thankyou.html`
- Add (funnel): Stripe.js `<script>` + `pk` in the pages that need it (via a tiny `assets/stripe.js` helper)
- Modify (app repo `taichi_app`): `supabase/functions/set-auto-renew/index.ts` (new) + `assets/db.js` `setAutoRenew`
- Retire: `complete-order` (edge function → no-op/removed)

---

### Task 1: Revise `create-subscription` — anonymous, email-based, returns token

**Files:** Modify `supabase/functions/create-subscription/index.ts`; redeploy `verify_jwt=false`.

**Interfaces:**
- Consumes: `{ email, plan_id, quiz_session_id? }` (no JWT).
- Produces: `{ clientSecret, subscriptionId, checkoutToken }`.

- [ ] **Step 1: Replace the function body**

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
  '1w':  { price: 'price_1Tq6jrEKxtNHIkyECsS78Flp', coupon: 'pkEtKPXU' },
  '4w':  { price: 'price_1Tq6jsEKxtNHIkyEephY6ycG', coupon: 'BBjhT92G' },
  '12w': { price: 'price_1Tq6jtEKxtNHIkyE2LbKbfuk', coupon: 'vgeoGVPv' },
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Resolve (create if needed) the auth user + public.users row for an email. Mirrors complete-order.
async function resolveUser(db: ReturnType<typeof createClient>, email: string): Promise<string> {
  const created = await db.auth.admin.createUser({ email, email_confirm: true });
  if (created.data?.user) return created.data.user.id;
  const { data: u } = await db.from('users').select('id').eq('email', email).maybeSingle();
  if (u?.id) return u.id;
  const { data: list } = await db.auth.admin.listUsers();
  const found = list?.users?.find((x) => (x.email || '').toLowerCase() === email.toLowerCase());
  if (found) return found.id;
  throw new Error('could not resolve user');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { email, plan_id, quiz_session_id } = await req.json();
    const clean = (email || '').trim().toLowerCase();
    const plan = PLANS[plan_id];
    if (!clean) return json({ error: 'missing email' }, 400);
    if (!plan) return json({ error: 'unknown plan' }, 400);

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const userId = await resolveUser(db, clean);

    // find/create + link Stripe customer
    const { data: row } = await db.from('users').select('stripe_customer_id').eq('id', userId).maybeSingle();
    let customerId = row?.stripe_customer_id as string | null;
    if (!customerId) {
      const c = await stripe.customers.create({ email: clean, metadata: { user_id: userId } });
      customerId = c.id;
    }
    const updates: Record<string, unknown> = { stripe_customer_id: customerId, email: clean };
    if (quiz_session_id) updates.linked_quiz_session_id = quiz_session_id;
    await db.from('users').update(updates).eq('id', userId);   // service role -> past billing guard
    if (quiz_session_id) await db.from('quiz_sessions').update({ user_id: userId, selected_plan: plan_id }).eq('id', quiz_session_id);

    const checkoutToken = crypto.randomUUID();
    const sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.price }],
      discounts: [{ coupon: plan.coupon }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { user_id: userId, plan_id, checkout_token: checkoutToken },
    });
    const pi = (sub.latest_invoice as Stripe.Invoice).payment_intent as Stripe.PaymentIntent;
    return json({ clientSecret: pi.client_secret, subscriptionId: sub.id, checkoutToken });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
```

- [ ] **Step 2: Deploy with `verify_jwt=false`** (via MCP `deploy_edge_function` verify_jwt:false, or `supabase functions deploy create-subscription --no-verify-jwt`).

- [ ] **Step 3: Smoke test (no auth now)**

```bash
curl -sX POST https://pixtozeghxwiidpnloih.supabase.co/functions/v1/create-subscription \
  -H "Content-Type: application/json" -d '{"email":"test+p3@example.com","plan_id":"4w"}'
```
Expected: `{"clientSecret":"pi_..._secret_...","subscriptionId":"sub_...","checkoutToken":"...uuid..."}`. Verify in Stripe the sub is incomplete with `metadata.checkout_token`.

- [ ] **Step 4: Commit** (`git commit -am "feat(fn): create-subscription anonymous email+token flow"`).

---

### Task 2: Revise `charge-upsell` — token-authorized

**Files:** Modify `supabase/functions/charge-upsell/index.ts`; redeploy `verify_jwt=false`.

**Interfaces:**
- Consumes: `{ subscriptionId, checkoutToken, upsell_id }`.
- Produces: `{ status: 'accepted' | 'requires_action' | 'failed', clientSecret? }`.

- [ ] **Step 1: Replace the function body**

```ts
import Stripe from 'npm:stripe@17';
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
type Offer = { type: 'one_time'; amount: number } | { type: 'recurring'; price: string };
const UPSELLS: Record<string, Offer> = {
  essential_guides:         { type: 'recurring', price: 'price_1Tq7L7EKxtNHIkyEi3VZYxCJ' },
  all_guides:               { type: 'recurring', price: 'price_1Tq7L7EKxtNHIkyE7kbWBgwe' },
  essential_guides_onetime: { type: 'one_time',  amount: 999  },
  guide_sleep:              { type: 'one_time',  amount: 1899 },
  guide_eating:             { type: 'one_time',  amount: 1899 },
  guide_aging:              { type: 'one_time',  amount: 1899 },
  vip:                      { type: 'one_time',  amount: 499  },
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { subscriptionId, checkoutToken, upsell_id } = await req.json();
    const offer = UPSELLS[upsell_id];
    if (!offer) return json({ error: 'unknown upsell' }, 400);
    if (!subscriptionId || !checkoutToken) return json({ error: 'missing checkout auth' }, 400);

    // authorize: token must match the base subscription's metadata
    const base = await stripe.subscriptions.retrieve(subscriptionId);
    if (base.metadata?.checkout_token !== checkoutToken) return json({ error: 'bad token' }, 403);
    const customerId = base.customer as string;
    const userId = base.metadata?.user_id as string;

    const cust = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    const pm = cust.invoice_settings?.default_payment_method as string | undefined;
    if (!pm) return json({ error: 'no saved payment method' }, 400);

    if (offer.type === 'one_time') {
      const pi = await stripe.paymentIntents.create({
        amount: offer.amount, currency: 'usd', customer: customerId,
        payment_method: pm, off_session: true, confirm: true,
        metadata: { user_id: userId, upsell_id },
      });
      if (pi.status === 'succeeded') return json({ status: 'accepted' });
      if (pi.status === 'requires_action') return json({ status: 'requires_action', clientSecret: pi.client_secret });
      return json({ status: 'failed' });
    } else {
      const sub = await stripe.subscriptions.create({
        customer: customerId, items: [{ price: offer.price }],
        default_payment_method: pm, off_session: true,
        expand: ['latest_invoice.payment_intent'],
        metadata: { user_id: userId, upsell_id },
      });
      if (sub.status === 'active' || sub.status === 'trialing') return json({ status: 'accepted' });
      const pi = (sub.latest_invoice as Stripe.Invoice)?.payment_intent as Stripe.PaymentIntent | null;
      if (pi?.status === 'requires_action') return json({ status: 'requires_action', clientSecret: pi.client_secret });
      return json({ status: 'failed' });
    }
  } catch (e) {
    const err = e as Stripe.errors.StripeError & { payment_intent?: Stripe.PaymentIntent };
    if (err?.payment_intent?.client_secret)
      return json({ status: 'requires_action', clientSecret: err.payment_intent.client_secret });
    return json({ status: 'failed', error: String(err?.message || err) }, 200);
  }
});
```

- [ ] **Step 2: Deploy `verify_jwt=false`.**
- [ ] **Step 3: Test** — bad token → 403; valid token (from a Task-1 checkout with a confirmed card) → `accepted`.
- [ ] **Step 4: Commit.**

---

### Task 3: Funnel Stripe loader + api.js wrappers

**Files:** Create `assets/stripe.js`; modify `assets/api.js`.

> ⚠️ **Do NOT add Subresource Integrity (`integrity=`/SRI) to `js.stripe.com/v3/`.** Stripe requires loading it live from their domain (it self-updates for fraud/PCI); pinning a hash breaks checkout and violates Stripe's terms. SRI is only for truly static third-party assets — not Stripe.js. (This is the one external script that intentionally has no SRI.)

- [ ] **Step 1: `assets/stripe.js`** — loads Stripe.js and exposes the publishable key.

```html
<!-- Included on pay/upsell pages BEFORE assets/stripe.js -->
<script src="https://js.stripe.com/v3/"></script>
```
```js
// assets/stripe.js
window.STRIPE_PK = "pk_test_51Tq6eVEKxtNHIkyEH26s3Yb09P17pwsgrnl3e8ylSrOGhv2ODsw4mVh2IU3Nycl2vSY9afNCWSD0QHJubdo64Fos00roD8Yf2g";
window.stripeClient = () => window.Stripe(window.STRIPE_PK);
```

- [ ] **Step 2: Add to `assets/api.js`**

```js
createSubscription: (p) => call("create-subscription", p),   // { email, plan_id, quiz_session_id }
chargeUpsell: (p) => call("charge-upsell", p),                // { subscriptionId, checkoutToken, upsell_id }
```

- [ ] **Step 3: Commit.**

---

### Task 4: Rebuild `pay.html` with Stripe Elements

**Files:** Modify `pay.html`.

**Interfaces:**
- Consumes: `FLOW.get()` session (`email`, `selected_plan`, `id`); `API.createSubscription`; Stripe.js.
- Produces: on success, stores `session.subscriptionId` + `session.checkoutToken`, navigates to `upsell1.html`.

- [ ] **Step 1: Add scripts to `<head>`/before the pay script**: `https://js.stripe.com/v3/`, `assets/stripe.js`.

- [ ] **Step 2: Add the Elements mount point** where the fake pay button is: a `<div id="payment-element"></div>`, an `<div id="address-element"></div>`, a `#pay` button, and a `#payMsg` error line.

- [ ] **Step 3: Replace the pay script** (keeps the existing PLANS display map for the summary):

```js
const s = FLOW.get();
const plan = ({ "1w":{name:"1-week plan",intro:5.19}, "4w":{name:"4-week plan",intro:9.99}, "12w":{name:"12-week plan",intro:19.99} })[s.selected_plan] || {name:"4-week plan",intro:9.99};
document.getElementById("planName").textContent = plan.name + " (introductory)";
document.getElementById("total").textContent = FLOW.money(plan.intro);

let stripe, elements;
(async function init() {
  const r = await API.createSubscription({ email: s.email, plan_id: s.selected_plan || "4w", quiz_session_id: s.id });
  if (!r || r.error || !r.clientSecret) { document.getElementById("payMsg").textContent = "Could not start checkout. Please retry."; return; }
  s.subscriptionId = r.subscriptionId; s.checkoutToken = r.checkoutToken; FLOW.save(s);
  stripe = window.stripeClient();
  elements = stripe.elements({ clientSecret: r.clientSecret, appearance: { theme: "flat" } });
  elements.create("payment").mount("#payment-element");
  elements.create("address", { mode: "billing" }).mount("#address-element");
})();

document.getElementById("pay").onclick = async () => {
  const btn = document.getElementById("pay"); btn.disabled = true;
  const msg = document.getElementById("payMsg"); msg.textContent = "";
  const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
  if (error) { msg.textContent = error.message || "Payment failed."; btn.disabled = false; return; }
  // success: card saved, subscription activating; webhook will provision during the upsell steps
  const s2 = FLOW.get(); s2.paid = true; s2.status = "paid"; FLOW.save(s2);
  location.href = "upsell1.html";
};
```

- [ ] **Step 4: Deploy funnel** (`wrangler pages deploy . --project-name=taimotion`) and **test with card `4242 4242 4242 4242`** → lands on upsell1; verify Stripe shows the sub active and the webhook set `users.subscription_status='active'`.

- [ ] **Step 5: Commit.**

---

### Task 5: Wire upsell pages to `charge-upsell` (+ SCA)

**Files:** Modify `upsell1.html`, `upsell2.html`, `upsell3.html`.

**Interfaces:** each accept button → `API.chargeUpsell({ subscriptionId, checkoutToken, upsell_id })`; handle `requires_action` via `stripe.handleNextAction`.

- [ ] **Step 1: Shared accept helper** (add to each page after loading Stripe.js + stripe.js):

```js
async function acceptUpsell(upsell_id, nextUrl) {
  const s = FLOW.get();
  const r = await API.chargeUpsell({ subscriptionId: s.subscriptionId, checkoutToken: s.checkoutToken, upsell_id });
  if (r && r.status === "requires_action" && r.clientSecret) {
    const stripe = window.stripeClient();
    const { error } = await stripe.handleNextAction({ clientSecret: r.clientSecret });
    if (error) { /* show soft message; still allow continue */ }
  }
  // record for the thank-you summary (display only)
  FLOW.addItem({ id: upsell_id, label: upsell_id, accepted: r && r.status === "accepted" });
  location.href = nextUrl;
}
```

- [ ] **Step 2: `upsell1.html`** — recurring button → `acceptUpsell("essential_guides","upsell2.html")`; one-time button → `acceptUpsell("essential_guides_onetime","upsell2.html")`; decline → `upsell2.html`.
- [ ] **Step 3: `upsell2.html`** — individual guide → `acceptUpsell("guide_<id>","upsell3.html")`; bundle → `acceptUpsell("all_guides","upsell3.html")`; decline → `upsell3.html`.
- [ ] **Step 4: `upsell3.html`** — `acceptUpsell("vip","thankyou.html")`; decline → `thankyou.html`.
- [ ] **Step 5: Deploy + test** each accept path (use `4242…` base; for SCA path re-run with a base card `4000 0025 0000 3155`). Verify `payments` rows `upsell:*` appear via webhook.
- [ ] **Step 6: Commit.**

---

### Task 6: `thankyou.html` — magic link only (drop `complete-order`)

**Files:** Modify `thankyou.html`.

- [ ] **Step 1:** Remove the `API.completeOrder(...)` call entirely (provisioning is the webhook's job now). Keep the order summary (from `FLOW.get().order`, display only).
- [ ] **Step 2:** Keep `API.loginLink(s.email)` → redirect to `action_link` (the auth user already exists from Task 1, so the magic link works immediately). Fallback: `https://app.taimotion.com/`.
- [ ] **Step 3: Deploy + test** the full funnel end-to-end lands logged-in on the app with access.
- [ ] **Step 4: Commit.**

---

### Task 7: Retire `complete-order`

**Files:** `supabase/functions/complete-order/index.ts`.

- [ ] **Step 1:** Replace its body with a `410 Gone` stub returning `{ error: 'deprecated: provisioning is handled by stripe-webhook' }` (keeps the slug from 404-ing any stale client), and remove the fake-provisioning logic. Deploy.
- [ ] **Step 2: Commit** (add the file to the repo — it currently isn't tracked).

---

### Task 8: Move `setAutoRenew` server-side (app repo)

**Files (app repo `taichi_app`):** Create `supabase/functions/set-auto-renew/index.ts`; modify `assets/db.js`.

Rationale: Plan 1's guard now blocks the client's direct `users.cancel_at_period_end` write, and `subscriptions` has no client write policy — so the app's current `setAutoRenew` fails. The app IS authenticated, so this function can be JWT-based.

- [ ] **Step 1: `set-auto-renew` (verify_jwt=true)** — reads the user's active subscription, calls `stripe.subscriptions.update(subId, { cancel_at_period_end })`; the webhook then syncs `users`/`subscriptions`.

```ts
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const cors = { 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json'}});
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false } });
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return json({ error: 'unauthenticated' }, 401);
  const { on } = await req.json();
  const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: sub } = await svc.from('subscriptions').select('id').eq('user_id', user.id).in('status',['active','trialing']).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if (!sub) return json({ error: 'no active subscription' }, 400);
  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: !on });
  return json({ ok: true });
});
```

- [ ] **Step 2:** In `taichi_app/assets/db.js`, replace `setAutoRenew` body with a call to the function:

```js
async setAutoRenew(on) {
  const { data: { session } } = await SB.auth.getSession();
  await fetch(SUPA.url + "/functions/v1/set-auto-renew", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token, "apikey": SUPA.key },
    body: JSON.stringify({ on }),
  });
},
```

- [ ] **Step 3: Deploy the function; deploy the app to Cloudflare Pages** (`wrangler pages deploy . --project-name=taimotion-app`, excluding the oversized videos as before). Test toggling auto-renew in the app.
- [ ] **Step 4: Commit** (app repo).

---

### Task 9: Full end-to-end browser test

- [ ] **Step 1:** From `taimotion.com`, complete quiz → checkout → pay (`4242 4242 4242 4242`) → accept one upsell, decline others → thank-you → confirm you land in the app **with access**.
- [ ] **Step 2: Verify DB:** `users.subscription_status='active'`, `subscriptions` row for the base sub, `payments` `initial` + any `upsell:*` rows.
- [ ] **Step 3: SCA path:** repeat with `4000 0025 0000 3155` (3DS) at pay → confirm the challenge UI appears and completes.
- [ ] **Step 4: Decline-all path:** buy base, decline all upsells → still provisioned, thank-you → app.
- [ ] **Step 5:** Confirm the RLS guard (Plan 1) still blocks a self-grant. Clean up test data.

---

## Self-Review

**Spec coverage (design Section 4 + carried items):**
- `pay.html` Elements + Address (for future tax) → Task 4. ✅
- Upsell one-click + SCA `requires_action` → Task 5. ✅
- Provisioning via webhook, no client trust → Tasks 1/4 (webhook unchanged from Plan 2). ✅
- Magic-link handoff, drop `complete-order` → Tasks 6, 7. ✅
- Move `setAutoRenew` server-side → Task 8. ✅
- Anonymous-checkout auth (email + capability token) → Tasks 1, 2 (revises Plan 2's JWT assumption). ✅

**Placeholder scan:** `pk_test_…` is the publishable key (safe in browser, not a placeholder); `guide_<id>` in Task 5 expands to `guide_sleep|eating|aging`. Function code is complete and deployable.

**Type consistency:** `create-subscription` now returns `{clientSecret, subscriptionId, checkoutToken}`; `charge-upsell` consumes `{subscriptionId, checkoutToken, upsell_id}` and returns `{status, clientSecret?}`; `pay.html` stores `subscriptionId`/`checkoutToken` in `FLOW` session; upsell pages read them. Consistent.

**Security note:** the capability token in the base sub's Stripe metadata is what authorizes upsell charges — an attacker would need both the (unguessable) `subscriptionId` and the token, both returned only to the client that created the checkout. `create-subscription` creating a sub for an arbitrary email is not an attack (attacker pays with their own card; provisioning is keyed to the Stripe customer/webhook).

**Execution note:** funnel + app deploy via `wrangler pages deploy` (direct upload), not git — edit, then deploy. Consider connecting Git integration afterward so pushes auto-deploy.
