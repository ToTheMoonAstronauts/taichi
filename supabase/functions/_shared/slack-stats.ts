// Business stats for the /stats Slack slash command.
// Pure math + formatting; gatherStats(deps) takes injected clients via MINIMAL
// structural interfaces (only the methods/fields it reads, lists typed as
// AsyncIterable). The real Stripe SDK satisfies them (its list() results
// auto-paginate under `for await`); tests pass plain async generators.
//
// Metric rules (get these wrong and the numbers lie):
// - Subscriber stats count BASE, REAL subs only: exclude upsell subs
//   (metadata.upsell_id — separate Stripe subs here, never members), internal
//   test subs (metadata.test === '1', the TMTEST50 flow), and 100%-off-coupon
//   subs. "New" additionally excludes incomplete/incomplete_expired — checkout
//   creates the sub before payment, so those are abandoned carts.
// - Revenue = paid invoices > $0 (100%-off promos generate real $0 "paid"
//   invoices) PLUS succeeded one-time upsell PaymentIntents (guides/upsells
//   are ad-hoc PIs here, no invoice). Subscription-invoice PIs carry no
//   upsell_id metadata, so nothing double-counts.
// - MRR is LIST-PRICE: active items' unit_amount×quantity normalized to
//   monthly; coupons not subtracted (excluding 100%-off handles the worst case).
// - % change vs the preceding window of equal length; previous 0 ⇒ 'n/a'.
// - Churn(30d) = cancels30 ÷ (actives now + cancels30) — approximation.
//   Caveat: Stripe omits canceled subs of deleted customers.

// ── Minimal structural interfaces ────────────────────────────────────────────

export interface StatsSub {
  status: string;
  created: number; // unix sec
  canceled_at?: number | null;
  metadata?: Record<string, string> | null;
  discounts?: unknown[] | null; // expanded Discount objects
  items?: { data: Array<{ quantity?: number; price?: { id?: string; unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } | null } | null }> } | null;
}
export interface StatsInvoice {
  status?: string | null;
  created: number;
  amount_paid?: number | null;
  amount_due?: number | null;
  attempt_count?: number | null;
  // sub metadata mirrors: 2024-era shape and the newer `parent` nesting
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
}
export interface StatsRefund { status?: string | null; created: number; amount: number }
export interface StatsPaymentIntent { status: string; created: number; amount_received?: number | null; metadata?: Record<string, string> | null }

export interface StatsStripe {
  subscriptions: { list(params: Record<string, unknown>): AsyncIterable<StatsSub> };
  invoices: { list(params: Record<string, unknown>): AsyncIterable<StatsInvoice> };
  refunds: { list(params: Record<string, unknown>): AsyncIterable<StatsRefund> };
  paymentIntents: { list(params: Record<string, unknown>): AsyncIterable<StatsPaymentIntent> };
}

export interface StatsDeps {
  stripe: StatsStripe;
  // Leads live in Supabase (quiz_sessions with an email); injected as a plain
  // counting function so tests need no Supabase client shape.
  countLeads: (fromSec: number, toSec: number) => Promise<number>;
  now: Date;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

type Coupon = { percent_off?: number | null } | null | undefined;
type Discount = { coupon?: Coupon; source?: { coupon?: Coupon } | null } | null | undefined;

// 100%-off detection. Recent Stripe API versions nest coupon under
// discount.source.coupon; 2024 versions have discount.coupon. Handle both.
export function hasFullDiscount(sub: StatsSub): boolean {
  for (const d of (sub.discounts ?? []) as Discount[]) {
    const pct = d?.coupon?.percent_off ?? d?.source?.coupon?.percent_off;
    if (pct === 100) return true;
  }
  return false;
}

export function isCountedSub(sub: StatsSub): boolean {
  if (sub.metadata?.upsell_id) return false; // upsell subs never count as members
  if (sub.metadata?.test === '1') return false; // internal TMTEST50 checkouts
  if (hasFullDiscount(sub)) return false; // free/test users
  return true;
}

// Normalize one subscription item to list-price cents/month.
export function monthlyCents(unitAmount: number, quantity: number, interval: string, intervalCount: number): number {
  const per = unitAmount * quantity;
  const n = intervalCount || 1;
  switch (interval) {
    case 'day': return per * (365 / 12) / n;
    case 'week': return per * (52 / 12) / n;
    case 'month': return per / n;
    case 'year': return per / (12 * n);
    default: return 0;
  }
}

export function subMonthlyCents(sub: StatsSub): number {
  let total = 0;
  for (const item of sub.items?.data ?? []) {
    const p = item.price;
    if (!p?.unit_amount || !p.recurring?.interval) continue;
    total += monthlyCents(p.unit_amount, item.quantity ?? 1, p.recurring.interval, p.recurring.interval_count ?? 1);
  }
  return total;
}

// previous === 0 ⇒ 'n/a' — never divide by zero.
export function pctChange(current: number, previous: number): string {
  if (previous === 0) return 'n/a';
  const pct = ((current - previous) / previous) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

export const fmtUsd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const inWindow = (t: number | null | undefined, fromSec: number, toSec: number) =>
  typeof t === 'number' && t >= fromSec && t < toSec;

function invoiceSubMetadata(inv: StatsInvoice): Record<string, string> {
  return inv.subscription_details?.metadata ?? inv.parent?.subscription_details?.metadata ?? {};
}

// ── Gathering ────────────────────────────────────────────────────────────────

interface WindowCounts { newSubs: number; cancels: number; revenueCents: number; upsellCents: number; refundCents: number; refundCount: number; leads: number }

export interface Stats {
  active: number;
  trialing: number;
  mrrCents: number;
  planMix: Record<string, number>;
  d7: WindowCounts;
  prev7: WindowCounts;
  d30: WindowCounts;
  prev30: WindowCounts;
  failed7: { count: number; amountCents: number };
  conversion30: string; // lead→paid
  churn30: string;
}

const DAY = 86_400;

export async function gatherStats(deps: StatsDeps): Promise<Stats> {
  const nowSec = Math.floor(deps.now.getTime() / 1000);
  const windows = {
    d7: [nowSec - 7 * DAY, nowSec] as const,
    prev7: [nowSec - 14 * DAY, nowSec - 7 * DAY] as const,
    d30: [nowSec - 30 * DAY, nowSec] as const,
    prev30: [nowSec - 60 * DAY, nowSec - 30 * DAY] as const,
  };
  const horizon = nowSec - 60 * DAY;
  const blank = (): WindowCounts => ({ newSubs: 0, cancels: 0, revenueCents: 0, upsellCents: 0, refundCents: 0, refundCount: 0, leads: 0 });
  const w = { d7: blank(), prev7: blank(), d30: blank(), prev30: blank() };
  const keys = ['d7', 'prev7', 'd30', 'prev30'] as const;

  let active = 0, trialing = 0, mrrCents = 0;
  const planMix: Record<string, number> = {};
  const failed7 = { count: 0, amountCents: 0 };

  const scanSubs = async () => {
    // status:'all' includes canceled subs (needed for cancel buckets).
    for await (const sub of deps.stripe.subscriptions.list({ status: 'all', limit: 100, expand: ['data.discounts'] })) {
      if (!isCountedSub(sub)) continue;
      if (sub.status === 'active' || sub.status === 'trialing') {
        if (sub.status === 'active') active++; else trialing++;
        mrrCents += subMonthlyCents(sub);
        const plan = sub.metadata?.plan_id || sub.items?.data[0]?.price?.id || 'unknown';
        planMix[plan] = (planMix[plan] ?? 0) + 1;
      }
      const realSignup = sub.status !== 'incomplete' && sub.status !== 'incomplete_expired';
      for (const k of keys) {
        if (realSignup && inWindow(sub.created, windows[k][0], windows[k][1])) w[k].newSubs++;
        if (inWindow(sub.canceled_at, windows[k][0], windows[k][1])) w[k].cancels++;
      }
    }
  };
  const scanInvoices = async () => {
    for await (const inv of deps.stripe.invoices.list({ created: { gte: horizon }, limit: 100 })) {
      if (invoiceSubMetadata(inv).test === '1') continue; // internal test subs
      if (inv.status === 'paid' && (inv.amount_paid ?? 0) > 0) {
        for (const k of keys) if (inWindow(inv.created, windows[k][0], windows[k][1])) w[k].revenueCents += inv.amount_paid!;
      }
      if ((inv.status === 'open' || inv.status === 'uncollectible') && (inv.attempt_count ?? 0) > 0 &&
        inWindow(inv.created, windows.d7[0], windows.d7[1])) {
        failed7.count++;
        failed7.amountCents += inv.amount_due ?? 0;
      }
    }
  };
  const scanRefunds = async () => {
    for await (const r of deps.stripe.refunds.list({ created: { gte: horizon }, limit: 100 })) {
      if (r.status !== 'succeeded') continue;
      for (const k of keys) {
        if (inWindow(r.created, windows[k][0], windows[k][1])) { w[k].refundCents += r.amount; w[k].refundCount++; }
      }
    }
  };
  const scanUpsells = async () => {
    // One-time upsell/guide purchases are ad-hoc PaymentIntents tagged with
    // metadata.upsell_id (funnel upsells + in-app buy-guides).
    for await (const pi of deps.stripe.paymentIntents.list({ created: { gte: horizon }, limit: 100 })) {
      if (pi.status !== 'succeeded' || !pi.metadata?.upsell_id || pi.metadata.test === '1') continue;
      for (const k of keys) if (inWindow(pi.created, windows[k][0], windows[k][1])) w[k].upsellCents += pi.amount_received ?? 0;
    }
  };
  const scanLeads = async () => {
    await Promise.all(keys.map(async (k) => { w[k].leads = await deps.countLeads(windows[k][0], windows[k][1]); }));
  };

  await Promise.all([scanSubs(), scanInvoices(), scanRefunds(), scanUpsells(), scanLeads()]);

  const denomChurn = active + trialing + w.d30.cancels;
  const churn30 = denomChurn === 0 ? 'n/a' : `${((w.d30.cancels / denomChurn) * 100).toFixed(1)}%`;
  const conversion30 = w.d30.leads === 0 ? 'n/a' : `${((w.d30.newSubs / w.d30.leads) * 100).toFixed(1)}%`;

  return { active, trialing, mrrCents: Math.round(mrrCents), planMix, ...w, failed7, conversion30, churn30 };
}

// ── Formatting (Slack mrkdwn) ────────────────────────────────────────────────

function windowBlock(title: string, cur: WindowCounts, prev: WindowCounts): string {
  const totalRev = cur.revenueCents + cur.upsellCents;
  const prevRev = prev.revenueCents + prev.upsellCents;
  return [
    `*${title}* (vs preceding window):`,
    `• New subscribers: ${cur.newSubs} (${pctChange(cur.newSubs, prev.newSubs)})`,
    `• Cancellations: ${cur.cancels} (${pctChange(cur.cancels, prev.cancels)})`,
    `• Revenue: ${fmtUsd(totalRev)} (${pctChange(totalRev, prevRev)}) — subs ${fmtUsd(cur.revenueCents)}, upsells ${fmtUsd(cur.upsellCents)}`,
    `• Refunds: ${fmtUsd(cur.refundCents)} (${cur.refundCount})`,
    `• Leads: ${cur.leads} (${pctChange(cur.leads, prev.leads)})`,
  ].join('\n');
}

export function formatStats(s: Stats): string {
  const mix = Object.entries(s.planMix).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}×${n}`).join(', ') || '—';
  return [
    ':bar_chart: *Tai Motion — business stats*',
    `*Right now:* ${s.active} active${s.trialing ? ` (+${s.trialing} trialing)` : ''} · MRR ${fmtUsd(s.mrrCents)} · plans: ${mix}`,
    '',
    windowBlock('Last 7 days', s.d7, s.prev7),
    `• Failed payments: ${s.failed7.count}${s.failed7.count ? ` (${fmtUsd(s.failed7.amountCents)})` : ''}`,
    '',
    windowBlock('Last 30 days', s.d30, s.prev30),
    `• Lead→paid conversion: ${s.conversion30}`,
    `• Churn: ${s.churn30}`,
  ].join('\n');
}
