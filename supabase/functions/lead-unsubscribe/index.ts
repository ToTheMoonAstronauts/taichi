// One-click unsubscribe for lead-recovery emails. GET ?e=<b64url email>&t=<hmac token>.
// Verifies the signature, adds the email to email_suppressions, shows a tiny confirmation page.
import { createClient } from 'jsr:@supabase/supabase-js@2';
const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const UNSUB_SECRET = Deno.env.get('UNSUB_SECRET') || 'dev';

async function sign(msg: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(UNSUB_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg.toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
const page = (msg: string) => new Response(
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
   <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:460px;margin:12vh auto;padding:0 24px;text-align:center;color:#2c2417">
   <div style="font-size:22px;font-weight:700;color:#3f7a52;margin-bottom:10px">Tai Motion</div>
   <p style="font-size:17px;line-height:1.6">${msg}</p></div>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const e = u.searchParams.get('e') || '', t = u.searchParams.get('t') || '';
    let email = '';
    try { email = atob(e.replace(/-/g, '+').replace(/_/g, '/')); } catch (_) {}
    if (!email || !email.includes('@')) return page('This unsubscribe link looks invalid.');
    if (t !== await sign(email)) return page('This unsubscribe link looks invalid or expired.');
    await svc.from('email_suppressions').upsert({ email: email.toLowerCase(), reason: 'unsubscribe' }, { onConflict: 'email' });
    return page('You’re unsubscribed. You won’t receive any more reminder emails from us. Take care! 🌿');
  } catch (_) {
    return page('Something went wrong, but you can reply to any email and we’ll remove you.');
  }
});
