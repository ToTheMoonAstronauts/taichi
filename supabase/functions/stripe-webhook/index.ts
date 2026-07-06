import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const WHSEC = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const SLACK = Deno.env.get('SLACK_WEBHOOK_URL');
const svc = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

async function notify(text: string) {
  if (!SLACK) return;
  try { await fetch(SLACK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); } catch (_) { /* never block provisioning on Slack */ }
}

async function userForCustomer(db: ReturnType<typeof svc>, customerId: string): Promise<string | null> {
  const { data } = await db.from('users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  return data?.id ?? null;
}
async function emailForUser(db: ReturnType<typeof svc>, userId: string | null): Promise<string> {
  if (!userId) return 'unknown';
  const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
  return data?.email ?? 'unknown';
}

// Mirror a subscription into public.subscriptions; only the BASE subscription (no upsell_id) drives users access.
async function syncSubscription(db: ReturnType<typeof svc>, subId: string) {
  const sub = await stripe.subscriptions.retrieve(subId);
  const userId = await userForCustomer(db, sub.customer as string);
  if (!userId) return;
  const start = new Date(sub.current_period_start * 1000).toISOString();
  const end = new Date(sub.current_period_end * 1000).toISOString();
  const active = sub.status === 'active' || sub.status === 'trialing';
  const isUpsell = !!sub.metadata?.upsell_id;
  await db.from('subscriptions').upsert({
    id: sub.id, user_id: userId, status: sub.status,
    price_id: sub.items.data[0]?.price?.id ?? null,
    current_period_start: start, current_period_end: end,
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (!isUpsell) {
    await db.from('users').update({
      subscription_status: active ? 'active' : sub.status,
      subscription_plan: (sub.metadata?.plan_id as string) ?? undefined,
      current_period_start: start, current_period_end: end,
      cancel_at_period_end: sub.cancel_at_period_end,
    }).eq('id', userId);
  }
}

Deno.serve(async (req) => {
  const sig = req.headers.get('Stripe-Signature');
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, WHSEC);
  } catch (e) {
    return new Response(`bad signature: ${String((e as Error).message)}`, { status: 400 });
  }
  const db = svc();
  const { error: dupErr } = await db.from('stripe_events').insert({ id: event.id, type: event.type, payload: event as unknown as Record<string, unknown> });
  if (dupErr) return new Response('duplicate', { status: 200 });
  try {
    switch (event.type) {
      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        const subId = inv.subscription as string;
        if (subId) await syncSubscription(db, subId);
        const userId = await userForCustomer(db, inv.customer as string);
        const kind = inv.billing_reason === 'subscription_create' ? 'initial' : 'renewal';
        await db.from('payments').insert({
          id: inv.id, user_id: userId, subscription_id: subId,
          amount: (inv.amount_paid ?? 0) / 100, currency: inv.currency,
          kind, status: 'succeeded', raw: inv as unknown as Record<string, unknown>,
        });
        const email = inv.customer_email || await emailForUser(db, userId);
        const amt = ((inv.amount_paid ?? 0) / 100).toFixed(2);
        const tag = (inv.amount_paid ?? 0) <= 100 ? ' _(test)_' : '';
        await notify(`:moneybag: *${kind === 'initial' ? 'New subscription' : 'Renewal'}* — ${email} — $${amt} ${inv.currency.toUpperCase()}${tag}`);
        break;
      }
      case 'customer.subscription.created':
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
          const email = await emailForUser(db, pi.metadata.user_id);
          const amt = ((pi.amount_received ?? 0) / 100).toFixed(2);
          const tag = pi.metadata.test === '1' ? ' _(test)_' : '';
          await notify(`:heavy_plus_sign: *Upsell:* ${pi.metadata.upsell_id} — ${email} — $${amt} ${pi.currency.toUpperCase()}${tag}`);
        }
        break;
      }
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    return new Response(String((e as Error).message), { status: 500 });
  }
});
