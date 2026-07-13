// Lead-recovery emails (abandoned checkout). SEPARATE, additive service — only reads
// quiz_sessions/users and writes email_sends/email_suppressions. Never touches checkout/subs.
// Cron-triggered hourly. Safety-gated: sends nothing unless LEAD_EMAILS_ENABLED=1 AND a
// BUSINESS_ADDRESS is set (CAN-SPAM). ?dry=1 returns due counts without sending.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, x-cron-key', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const svc = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const RESEND = Deno.env.get('RESEND_API_KEY') || '';
const ENABLED = Deno.env.get('LEAD_EMAILS_ENABLED') === '1';
const ADDRESS = (Deno.env.get('BUSINESS_ADDRESS') || '').trim();
const UNSUB_SECRET = Deno.env.get('UNSUB_SECRET') || 'dev';
const CRON_KEY = Deno.env.get('CRON_KEY') || '';
const FUNNEL = 'https://taimotion.com';
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(UNSUB_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg.toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function shell(inner: string, unsubUrl: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f2ea;padding:24px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fffdf9;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(60,50,30,.08)">
    <tr><td style="background:#3f7a52;padding:22px 28px"><span style="color:#fff;font-size:20px;font-weight:700">Tai&nbsp;Motion</span></td></tr>
    <tr><td style="padding:26px 28px 8px;font-size:16px;color:#2c2417;line-height:1.6">${inner}</td></tr>
  </table>
  <div style="color:#b3ab98;font-size:12px;margin-top:14px;line-height:1.6;max-width:520px;text-align:center">
    Tai&nbsp;Motion · ${esc(ADDRESS)}<br>
    You're receiving this because you started a plan at taimotion.com. <a href="${unsubUrl}" style="color:#8a8172">Unsubscribe</a></div>
  </td></tr></table></body></html>`;
}
function cta(url: string, label: string) {
  return `<div style="margin:22px 0"><a href="${url}" style="display:inline-block;background:#3f7a52;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 26px;border-radius:12px">${label}</a></div>`;
}
function buildEmail(step: number, resumeUrl: string, unsubUrl: string) {
  if (step === 1) {
    return {
      subject: 'Your gentle plan is saved 🌿',
      html: shell(
        `<p>Hi there,</p>
         <p>Your personalized Chair Tai Chi plan is ready — built from the answers you gave us. Gentle, seated movement for balance, mobility and a calmer mind, just a few minutes a day.</p>
         <p>Good news: <b>your introductory price is still held</b> — a real saving on your first plan — but we can only keep it reserved for a little while.</p>
         ${cta(resumeUrl, 'Finish setting up my plan')}
         <p style="color:#6b6250">You can cancel anytime, in a couple of clicks.</p>
         <p style="color:#6b6250">Warmly,<br>The Tai Motion team</p>`, unsubUrl),
    };
  }
  return {
    subject: 'Still yours — here\'s everything waiting inside',
    html: shell(
      `<p>Hi there,</p>
       <p>Your plan is still saved at your <b>introductory price</b>. And it's more than a few exercises — here's what's waiting when you join:</p>
       <ul style="padding-left:20px;color:#2c2417">
         <li><b>Personalized chair Tai Chi</b> — easy follow-along sessions at your level</li>
         <li><b>A personalized nutrition plan</b> — simple, gentle meals built around you</li>
         <li><b>Academy lessons and guided challenges</b> — a little something each day to keep you going</li>
         <li><b>Simple trackers</b> — water, balance, mood and more, to watch how you feel improve</li>
       </ul>
       <p>All designed for real bodies and real days, entirely at your own pace — plus a few free bonus guides to keep.</p>
       ${cta(resumeUrl, 'Start my plan')}
       <p style="color:#6b6250">Cancel anytime. And if it's not for you in the first 30 days, our refund policy has you covered.</p>
       <p style="color:#6b6250">Warmly,<br>The Tai Motion team</p>`, unsubUrl),
  };
}

async function sendOne(to: string, subject: string, html: string) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Tai Motion <hello@taimotion.com>', to: [to], subject, html }),
  });
  if (!r.ok) console.log('[lead-email] resend ' + r.status + ' ' + (await r.text()));
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';
  // cron auth (skip for dry-run introspection which is harmless)
  if (!dry && CRON_KEY && req.headers.get('x-cron-key') !== CRON_KEY) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!dry && !ENABLED) return json({ ok: true, skipped: 'disabled' });
  if (!dry && !ADDRESS) return json({ ok: false, error: 'BUSINESS_ADDRESS not set — refusing to send (CAN-SPAM).' }, 400);

  const out: Record<string, unknown> = { dry, enabled: ENABLED, hasAddress: !!ADDRESS };
  let sent = 0; const sample: string[] = [];
  for (const step of [1, 2]) {
    const { data, error } = await svc.rpc('due_lead_emails', { p_step: step });
    if (error) { out['step' + step] = 'error: ' + error.message; continue; }
    const rows = (data || []) as { quiz_session_id: string; email: string }[];
    out['step' + step + '_due'] = rows.length;
    if (dry) { rows.slice(0, 5).forEach((r) => sample.push(step + ':' + r.email.replace(/(.).*(@.*)/, '$1***$2'))); continue; }
    for (const row of rows.slice(0, 100)) {
      const { data: ins, error: iErr } = await svc.from('email_sends').insert({ email: row.email, quiz_session_id: row.quiz_session_id, step }).select('id');
      if (iErr || !ins || !ins.length) continue;                 // already sent (unique index) or error → skip
      const resumeUrl = `${FUNNEL}/checkout?resume=${row.quiz_session_id}`;
      const tok = await sign(row.email);
      const unsubUrl = `${SB_URL}/functions/v1/lead-unsubscribe?e=${b64url(row.email)}&t=${tok}`;
      const { subject, html } = buildEmail(step, resumeUrl, unsubUrl);
      const ok = await sendOne(row.email, subject, html);
      if (ok) sent++; else await svc.from('email_sends').delete().eq('id', ins[0].id);   // let it retry next run
    }
  }
  out.sent = sent; if (dry) out.sample = sample;
  return json(out);
});
