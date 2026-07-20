// Slack request signature verification (the v0 HMAC scheme).
// Pure: the clock is injected (nowSeconds) so tests are deterministic.
// https://api.slack.com/authentication/verifying-requests-from-slack

const REPLAY_WINDOW_SEC = 60 * 5;

export async function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | null; // X-Slack-Request-Timestamp header
  signature: string | null; // X-Slack-Signature header ('v0=<hex>')
  rawBody: string;
  nowSeconds: number;
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody, nowSeconds } = opts;
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SEC) return false; // replay guard
  if (!signature.startsWith('v0=')) return false;
  const hex = signature.slice(3).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const claimed = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  // crypto.subtle.verify is the Web Crypto timing-safe comparison — never
  // compare HMAC hex strings with ===.
  return await crypto.subtle.verify('HMAC', key, claimed, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
}
