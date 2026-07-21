import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  formatStats, gatherStats, hasFullDiscount, isCountedSub, monthlyCents, pctChange,
  type StatsDeps, type StatsInvoice, type StatsPaymentIntent, type StatsRefund, type StatsSub,
} from './slack-stats.ts';

const NOW = new Date('2026-07-20T12:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;
const daysAgo = (d: number) => nowSec - d * DAY;

// The real Stripe SDK's list() is async-iterable; tests use plain generators —
// no SDK mocking (that's the point of the structural interfaces).
function iter<T>(items: T[]): { list: () => AsyncIterable<T> } {
  return { list: async function* () { yield* items; } };
}

function deps(input: {
  subs?: StatsSub[]; invoices?: StatsInvoice[]; refunds?: StatsRefund[];
  pis?: StatsPaymentIntent[]; leads?: (from: number, to: number) => number;
}): StatsDeps {
  return {
    stripe: {
      subscriptions: iter(input.subs ?? []),
      invoices: iter(input.invoices ?? []),
      refunds: iter(input.refunds ?? []),
      paymentIntents: iter(input.pis ?? []),
    },
    countLeads: (from, to) => Promise.resolve(input.leads ? input.leads(from, to) : 0),
    now: NOW,
  };
}

const weekly = (amount: number): StatsSub['items'] =>
  ({ data: [{ quantity: 1, price: { id: 'p', unit_amount: amount, recurring: { interval: 'week', interval_count: 1 } } }] });

Deno.test('monthlyCents normalizes week/month/year and interval_count', () => {
  assertEquals(monthlyCents(2199, 1, 'week', 1), 2199 * (52 / 12)); // $21.99/wk
  assertEquals(monthlyCents(4995, 1, 'week', 4), 4995 * (52 / 12) / 4); // $49.95/4wk
  assertEquals(monthlyCents(1000, 1, 'month', 1), 1000);
  assertEquals(monthlyCents(12000, 1, 'year', 1), 1000);
  assertEquals(monthlyCents(500, 2, 'month', 1), 1000); // quantity
  assertEquals(monthlyCents(1000, 1, 'bogus', 1), 0);
});

Deno.test('pctChange never divides by zero and signs correctly', () => {
  assertEquals(pctChange(5, 0), 'n/a');
  assertEquals(pctChange(5, 4), '+25%');
  assertEquals(pctChange(3, 4), '-25%');
  assertEquals(pctChange(0, 0), 'n/a');
});

Deno.test('hasFullDiscount handles 2024 (coupon) and newer (source.coupon) shapes', () => {
  const base: StatsSub = { status: 'active', created: 0 };
  assertEquals(hasFullDiscount({ ...base, discounts: [{ coupon: { percent_off: 100 } }] }), true);
  assertEquals(hasFullDiscount({ ...base, discounts: [{ source: { coupon: { percent_off: 100 } } }] }), true);
  assertEquals(hasFullDiscount({ ...base, discounts: [{ coupon: { percent_off: 50 } }] }), false); // partial = real customer
  assertEquals(hasFullDiscount({ ...base, discounts: [] }), false);
  assertEquals(hasFullDiscount(base), false);
});

Deno.test('isCountedSub excludes upsell, test, and 100%-off subs', () => {
  const base: StatsSub = { status: 'active', created: 0 };
  assertEquals(isCountedSub(base), true);
  assertEquals(isCountedSub({ ...base, metadata: { upsell_id: 'all_guides' } }), false);
  assertEquals(isCountedSub({ ...base, metadata: { test: '1' } }), false);
  assertEquals(isCountedSub({ ...base, discounts: [{ coupon: { percent_off: 100 } }] }), false);
});

Deno.test('gatherStats: actives, MRR, plan mix count only real base subs', async () => {
  const s = await gatherStats(deps({
    subs: [
      { status: 'active', created: daysAgo(3), metadata: { plan_id: '4w' }, items: weekly(2199) },
      { status: 'trialing', created: daysAgo(2), metadata: { plan_id: '1w' }, items: weekly(2199) },
      { status: 'active', created: daysAgo(1), metadata: { upsell_id: 'all_guides' }, items: weekly(999) }, // excluded
      { status: 'active', created: daysAgo(1), metadata: { test: '1' }, items: weekly(200) }, // excluded
      { status: 'incomplete', created: daysAgo(1), items: weekly(2199) }, // abandoned cart: not "new", not active
      { status: 'canceled', created: daysAgo(40), canceled_at: daysAgo(5), metadata: { plan_id: '4w' } },
    ],
  }));
  assertEquals(s.active, 1);
  assertEquals(s.trialing, 1);
  assertEquals(s.mrrCents, Math.round(2 * 2199 * (52 / 12)));
  assertEquals(s.planMix, { '4w': 1, '1w': 1 });
  assertEquals(s.d7.newSubs, 2); // incomplete excluded, upsell/test excluded
  assertEquals(s.d7.cancels, 1);
  assertEquals(s.d30.cancels, 1);
  assertEquals(s.churn30, ((1 / 3) * 100).toFixed(1) + '%'); // 1 cancel / (2 actives + 1)
});

Deno.test('gatherStats: revenue = paid invoices >$0 + upsell PIs; test subs skipped', async () => {
  const s = await gatherStats(deps({
    invoices: [
      { status: 'paid', created: daysAgo(1), amount_paid: 519 },
      { status: 'paid', created: daysAgo(1), amount_paid: 0 }, // 100%-off promo invoice
      { status: 'paid', created: daysAgo(2), amount_paid: 200, subscription_details: { metadata: { test: '1' } } }, // TMTEST50
      { status: 'paid', created: daysAgo(2), amount_paid: 300, parent: { subscription_details: { metadata: { test: '1' } } } }, // newer shape
      { status: 'paid', created: daysAgo(10), amount_paid: 4995 }, // prev7 + d30
      { status: 'open', created: daysAgo(3), amount_due: 2199, attempt_count: 2 }, // failed
      { status: 'open', created: daysAgo(3), amount_due: 999, attempt_count: 0 }, // not yet attempted: not failed
    ],
    pis: [
      { status: 'succeeded', created: daysAgo(1), amount_received: 2599, metadata: { upsell_id: 'essential_guides' } },
      { status: 'succeeded', created: daysAgo(1), amount_received: 100, metadata: { upsell_id: 'vip', test: '1' } }, // test
      { status: 'succeeded', created: daysAgo(1), amount_received: 5000, metadata: {} }, // sub-invoice PI: no upsell_id
    ],
  }));
  assertEquals(s.d7.revenueCents, 519);
  assertEquals(s.d7.upsellCents, 2599);
  assertEquals(s.prev7.revenueCents, 4995);
  assertEquals(s.d30.revenueCents, 519 + 4995);
  assertEquals(s.failed7, { count: 1, amountCents: 2199 });
});

Deno.test('gatherStats: refunds, leads, conversion, and window bucketing', async () => {
  const s = await gatherStats(deps({
    subs: [
      { status: 'active', created: daysAgo(20), metadata: { plan_id: '12w' }, items: weekly(1999) },
      { status: 'active', created: daysAgo(45), metadata: { plan_id: '4w' }, items: weekly(2199) }, // prev30 signup
    ],
    refunds: [
      { status: 'succeeded', created: daysAgo(2), amount: 519 },
      { status: 'failed', created: daysAgo(2), amount: 999 }, // ignored
      { status: 'succeeded', created: daysAgo(40), amount: 4995 }, // prev30
    ],
    leads: (from) => (from === daysAgo(30) ? 10 : from === daysAgo(60) ? 5 : 2),
  }));
  assertEquals(s.d7.refundCents, 519);
  assertEquals(s.d7.refundCount, 1);
  assertEquals(s.prev30.refundCents, 4995);
  assertEquals(s.d30.newSubs, 1);
  assertEquals(s.prev30.newSubs, 1);
  assertEquals(s.d30.leads, 10);
  assertEquals(s.conversion30, '10.0%'); // 1 new sub / 10 leads
});

Deno.test('gatherStats: zero data ⇒ n/a everywhere, no crashes', async () => {
  const s = await gatherStats(deps({}));
  assertEquals(s.active, 0);
  assertEquals(s.churn30, 'n/a');
  assertEquals(s.conversion30, 'n/a');
  const text = formatStats(s);
  assert(text.includes('n/a'));
  assert(text.includes('plans: —'));
});

Deno.test('formatStats renders mrkdwn with both windows and derived metrics', async () => {
  const s = await gatherStats(deps({
    subs: [{ status: 'active', created: daysAgo(3), metadata: { plan_id: '4w' }, items: weekly(4995) }],
    invoices: [{ status: 'paid', created: daysAgo(1), amount_paid: 999 }],
    leads: () => 4,
  }));
  const text = formatStats(s);
  assert(text.includes('*Right now:* <https://dashboard.stripe.com/subscriptions?status=active|1 active>'));
  assert(text.includes('*Last 7 days*'));
  assert(text.includes('*Last 30 days*'));
  assert(text.includes('• <https://dashboard.stripe.com/payments|Revenue>: $9.99'));
  assert(text.includes('<https://dashboard.stripe.com/subscriptions?status=all|New subscribers>'));
  assert(text.includes('<https://dashboard.stripe.com/payments?status%5B%5D=refunded|Refunds>'));
  assert(text.includes('<https://dashboard.stripe.com/invoices?status=open|Failed payments>'));
  assert(text.includes('<https://dashboard.stripe.com/subscriptions?status=canceled|Churn>'));
  assert(text.includes('editor|Leads>'));
  assert(text.includes('Lead→paid conversion: 25.0%'));
  assert(text.includes('plans: 4w×1'));
});
