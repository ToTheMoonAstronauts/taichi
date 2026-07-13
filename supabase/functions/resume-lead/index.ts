// Returns a lead's checkout-relevant fields for a quiz_session id, so the emailed
// resume link can re-seed the funnel on any device. Read-only, no auth (id is an
// unguessable UUID and it's the person's own data). SEPARATE service.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { id } = await req.json().catch(() => ({}));
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'bad id' }, 400);
    const { data } = await svc.from('quiz_sessions').select('email,selected_plan,name,bmi').eq('id', id).maybeSingle();
    if (!data || !data.email) return json({ error: 'not found' }, 404);
    return json({ id, email: data.email, selected_plan: data.selected_plan, name: data.name, bmi: data.bmi });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
