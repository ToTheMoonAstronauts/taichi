// Meta Conversions API sender for server-side Purchase and Lead events.
// Fire-and-log: this module must never throw into the payment path.

export interface LeadInput {
  eventId: string;
  emailHash?: string | null;      // already normalized + hashed
  fbc?: string | null;
  clientIp?: string | null;
  clientUserAgent?: string | null;
  eventSourceUrl?: string | null;
  eventTime?: number;             // unix seconds
}

export interface PurchaseInput extends LeadInput {
  value: number;
  currency: string;
}

// Hex SHA-256 of a string (used for email hashing).
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Build the _fbc value from an ad-click id. Null when fbclid is absent.
export function buildFbc(
  fbclid?: string | null,
  clickTimeSec?: number | string | null,
): string | null {
  if (!fbclid) return null;
  const n = typeof clickTimeSec === 'string' ? Number(clickTimeSec) : clickTimeSec;
  const t = (typeof n === 'number' && Number.isFinite(n)) ? Math.floor(n) : Math.floor(Date.now() / 1000);
  return `fb.1.${t}.${fbclid}`;
}

// Pure builders for the Graph API request body. No env, no I/O — fully testable.
function buildEventPayload(
  eventName: string,
  input: LeadInput,
  customData: Record<string, unknown> | null,
  testEventCode?: string | null,
): Record<string, unknown> {
  const user_data: Record<string, unknown> = {};
  if (input.emailHash) user_data.em = [input.emailHash];
  if (input.clientIp) user_data.client_ip_address = input.clientIp;
  if (input.clientUserAgent) user_data.client_user_agent = input.clientUserAgent;
  if (input.fbc) user_data.fbc = input.fbc;
  const event: Record<string, unknown> = {
    event_name: eventName,
    event_id: input.eventId,
    event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
    action_source: 'website',
    event_source_url: input.eventSourceUrl || 'https://taimotion.com/',
    user_data,
  };
  if (customData) event.custom_data = customData;
  const body: Record<string, unknown> = { data: [event] };
  if (testEventCode) body.test_event_code = testEventCode;
  return body;
}

export function buildPurchasePayload(
  input: PurchaseInput,
  testEventCode?: string | null,
): Record<string, unknown> {
  return buildEventPayload('Purchase', input,
    { value: input.value, currency: input.currency }, testEventCode);
}

export function buildLeadPayload(
  input: LeadInput,
  testEventCode?: string | null,
): Record<string, unknown> {
  return buildEventPayload('Lead', input, null, testEventCode);
}

interface SendArgs {
  eventId: string; email?: string | null;
  fbc?: string | null; clientIp?: string | null; clientUserAgent?: string | null;
  eventSourceUrl?: string | null; eventTime?: number;
}

// Send an event to Meta. Reads env for credentials; no-ops when unconfigured.
async function sendEvent(
  build: (input: LeadInput, testCode: string | null) => Record<string, unknown>,
  args: SendArgs,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    const pixelId = Deno.env.get('META_PIXEL_ID');
    const token = Deno.env.get('META_CAPI_TOKEN');
    if (!pixelId || !token) {
      console.log('[capi] skipped: META_PIXEL_ID/META_CAPI_TOKEN not set');
      return;
    }
    const ver = Deno.env.get('META_API_VERSION') || 'v21.0';
    const testCode = Deno.env.get('META_TEST_EVENT_CODE') || null;
    const emailHash = args.email ? await sha256Hex(args.email.trim().toLowerCase()) : null;
    const { email: _email, ...rest } = args;
    const body = build({ ...rest, emailHash }, testCode);
    const url = `https://graph.facebook.com/${ver}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) console.log(`[capi] non-2xx ${r.status} for ${args.eventId}: ${txt}`);
    else console.log(`[capi] sent ${args.eventId}: ${txt}`);
  } catch (e) {
    console.log(`[capi] error for ${args.eventId}: ${String((e as Error)?.message || e)}`);
  }
}

export function sendPurchase(
  args: SendArgs & { value: number; currency: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendEvent(
    (input, testCode) => buildPurchasePayload(
      { ...input, value: args.value, currency: args.currency }, testCode),
    args, fetchImpl,
  );
}

export function sendLead(
  args: SendArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return sendEvent(buildLeadPayload, args, fetchImpl);
}
