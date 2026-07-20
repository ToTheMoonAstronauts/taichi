// /stats Slack slash command — live business numbers in the sales channel.
// Thin route: verify Slack signature → ack ephemerally → gather + post to
// response_url in the background. Deployed with --no-verify-jwt (Slack sends
// no JWT); the Slack signature IS the auth — this endpoint returns revenue
// data, never skip it.
//
// Slack kills slash commands after 3 seconds; cold start + live Stripe queries
// WILL exceed it. So: ack immediately, do the real work in
// EdgeRuntime.waitUntil (keeps the isolate alive post-response), then POST the
// result to response_url (Slack accepts it for up to 30 min). On failure POST
// an ephemeral error — a non-200 makes Slack show an ugly generic error.
import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifySlackSignature } from '../_shared/slack-verify.ts';
import { formatStats, gatherStats } from '../_shared/slack-stats.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

async function postToSlack(responseUrl: string, body: Record<string, unknown>) {
  await fetch(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function runStats(responseUrl: string) {
  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const stats = await gatherStats({
      stripe,
      // Leads = quiz sessions that captured an email, bucketed by created_at.
      countLeads: async (fromSec, toSec) => {
        const { count, error } = await db.from('quiz_sessions')
          .select('id', { count: 'exact', head: true })
          .not('email', 'is', null)
          .gte('created_at', new Date(fromSec * 1000).toISOString())
          .lt('created_at', new Date(toSec * 1000).toISOString());
        if (error) throw new Error(`lead count failed: ${error.message}`);
        return count ?? 0;
      },
      now: new Date(),
    });
    await postToSlack(responseUrl, { response_type: 'in_channel', text: formatStats(stats) });
  } catch (e) {
    try {
      await postToSlack(responseUrl, { response_type: 'ephemeral', text: `:warning: /stats failed: ${String((e as Error)?.message || e)}` });
    } catch (_) { /* nothing left to report to */ }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = Deno.env.get('SLACK_SIGNING_SECRET');
  if (!secret) return new Response('SLACK_SIGNING_SECRET not configured', { status: 503 });

  const rawBody = await req.text();
  const ok = await verifySlackSignature({
    signingSecret: secret,
    timestamp: req.headers.get('x-slack-request-timestamp'),
    signature: req.headers.get('x-slack-signature'),
    rawBody,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!ok) return new Response('bad signature', { status: 401 });

  const responseUrl = new URLSearchParams(rawBody).get('response_url');
  if (!responseUrl) return new Response('missing response_url', { status: 400 });

  const work = runStats(responseUrl);
  if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
  else work.catch(() => {/* local dev without EdgeRuntime: fire-and-forget */});

  return json({ response_type: 'ephemeral', text: ':hourglass_flowing_sand: Crunching the numbers…' });
});
