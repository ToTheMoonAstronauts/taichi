import { assertEquals } from 'jsr:@std/assert@1';
import { verifySlackSignature } from './slack-verify.ts';

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const NOW = 1_700_000_000;

// Compute a valid v0 signature the same way Slack does, for test fixtures.
async function sign(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return 'v0=' + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('accepts a correctly signed, fresh request', async () => {
  const body = 'command=%2Fstats&response_url=https%3A%2F%2Fhooks.slack.com%2Fx';
  const sig = await sign(SECRET, NOW - 10, body);
  assertEquals(await verifySlackSignature({
    signingSecret: SECRET, timestamp: String(NOW - 10), signature: sig, rawBody: body, nowSeconds: NOW,
  }), true);
});

Deno.test('rejects a signature made with the wrong secret', async () => {
  const body = 'command=%2Fstats';
  const sig = await sign('wrong-secret', NOW, body);
  assertEquals(await verifySlackSignature({
    signingSecret: SECRET, timestamp: String(NOW), signature: sig, rawBody: body, nowSeconds: NOW,
  }), false);
});

Deno.test('rejects a tampered body', async () => {
  const sig = await sign(SECRET, NOW, 'command=%2Fstats');
  assertEquals(await verifySlackSignature({
    signingSecret: SECRET, timestamp: String(NOW), signature: sig, rawBody: 'command=%2Fevil', nowSeconds: NOW,
  }), false);
});

Deno.test('rejects a stale timestamp (replay, >5 min)', async () => {
  const body = 'command=%2Fstats';
  const ts = NOW - 301;
  const sig = await sign(SECRET, ts, body);
  assertEquals(await verifySlackSignature({
    signingSecret: SECRET, timestamp: String(ts), signature: sig, rawBody: body, nowSeconds: NOW,
  }), false);
});

Deno.test('accepts exactly at the 5-minute boundary', async () => {
  const body = 'command=%2Fstats';
  const ts = NOW - 300;
  const sig = await sign(SECRET, ts, body);
  assertEquals(await verifySlackSignature({
    signingSecret: SECRET, timestamp: String(ts), signature: sig, rawBody: body, nowSeconds: NOW,
  }), true);
});

Deno.test('rejects missing headers and malformed signatures', async () => {
  const body = 'command=%2Fstats';
  const good = await sign(SECRET, NOW, body);
  const base = { signingSecret: SECRET, rawBody: body, nowSeconds: NOW };
  assertEquals(await verifySlackSignature({ ...base, timestamp: null, signature: good }), false);
  assertEquals(await verifySlackSignature({ ...base, timestamp: String(NOW), signature: null }), false);
  assertEquals(await verifySlackSignature({ ...base, timestamp: 'not-a-number', signature: good }), false);
  assertEquals(await verifySlackSignature({ ...base, timestamp: String(NOW), signature: 'v1=' + good.slice(3) }), false);
  assertEquals(await verifySlackSignature({ ...base, timestamp: String(NOW), signature: 'v0=zzzz' }), false);
});
