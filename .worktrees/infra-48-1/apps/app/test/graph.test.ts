import { beforeAll, describe, expect, it } from 'vitest';
import { BODY_MODE, GraphProvider } from '../src/mail/providers/graph';
import type { EmailMessage } from '../src/mail/provider';

const message: EmailMessage = { to: 'recipient@example.test', subject: 'ResearchForce: Test', html: '<p>Test</p>', text: 'Test' };
const THUMBPRINT = '0123456789abcdef0123456789abcdef01234567';
let pem = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const body = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
  pem = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/gu)!.join('\n')}\n-----END PRIVATE KEY-----`;
});

interface Seen { url: string; init: RequestInit }
function graph(answers: { token?: () => Response; send?: () => Response }, clock = () => 1_000_000) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('login.microsoftonline.com')) return answers.token?.() ?? Response.json({ access_token: 'synthetic-token', expires_in: 3600 });
    return answers.send?.() ?? new Response(null, { status: 202 });
  }) as typeof fetch;
  const provider = new GraphProvider({ tenantId: 'tenant-1', clientId: 'client-1', privateKeyPem: pem, thumbprint: THUMBPRINT, sendingAddress: 'sender@example.test' }, fetcher, clock);
  return { provider, seen };
}
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.codePointAt(0)!);

describe('the Microsoft Graph provider', () => {
  it('sends one recipient, an HTML body, and no copy in Sent Items (R20.11, R20.24)', async () => {
    const { provider, seen } = graph({});
    expect(await provider.send(message)).toEqual({ ok: true });
    const send = seen.find((entry) => entry.url.includes('/sendMail'))!;
    expect(send.url).toBe('https://graph.microsoft.com/v1.0/users/sender%40example.test/sendMail');
    expect(new Headers(send.init.headers).get('Authorization')).toBe('Bearer synthetic-token');
    const body = JSON.parse(String(send.init.body)) as { message: { subject: string; body: { contentType: string; content: string }; toRecipients: unknown[]; from: { emailAddress: { name: string } } }; saveToSentItems: boolean };
    expect(body.saveToSentItems).toBe(false);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'recipient@example.test' } }]);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: '<p>Test</p>' });
    expect(body.message.from.emailAddress.name).toBe('ResearchForce');
    expect(BODY_MODE).toBe('html-with-exchange-conversion');
  });

  it('asks for a token with a certificate assertion signed by the key, and keeps the token until it expires (R20.19, R20.20)', async () => {
    let now = 1_000_000;
    const { provider, seen } = graph({}, () => now);
    await provider.send(message);
    await provider.send(message);
    const tokens = seen.filter((entry) => entry.url.includes('login.microsoftonline.com'));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
    const form = new URLSearchParams(String(tokens[0]!.init.body));
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(form.get('client_secret')).toBeNull();
    const [header, claims, signature] = form.get('client_assertion')!.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(header)))).toMatchObject({ alg: 'RS256', x5t: btoa(String.fromCharCode(...Uint8Array.from(THUMBPRINT.match(/../gu)!, (pair) => Number.parseInt(pair, 16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') });
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims)))).toMatchObject({ iss: 'client-1', sub: 'client-1', aud: tokens[0]!.url });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, fromBase64url(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
    now += 3_700_000;
    await provider.send(message);
    expect(seen.filter((entry) => entry.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });

  it('reports a 429 with its Retry-After and a 5xx without it, keeping nothing of the response (R20.9)', async () => {
    const limited = graph({ send: () => new Response('{"error":{"message":"to recipient@example.test"}}', { status: 429, headers: { 'Retry-After': '120' } }) });
    expect(await limited.provider.send(message)).toEqual({ ok: false, status: 429, retryAfterMs: 120_000 });
    const broken = graph({ send: () => new Response('boom', { status: 503, headers: { 'Retry-After': '5' } }) });
    expect(await broken.provider.send(message)).toEqual({ ok: false, status: 503, retryAfterMs: null });
  });

  it('fails the attempt when the token is refused or the network breaks', async () => {
    const refused = graph({ token: () => new Response('no', { status: 401 }) });
    expect(await refused.provider.send(message)).toEqual({ ok: false, status: null, retryAfterMs: null });
    const failing = new GraphProvider({ tenantId: 't', clientId: 'c', privateKeyPem: pem, thumbprint: THUMBPRINT, sendingAddress: 's@example.test' }, (() => { throw new TypeError('offline'); }) as typeof fetch);
    expect(await failing.send(message)).toEqual({ ok: false, status: null, retryAfterMs: null });
  });

  it('marks a send whose answer was lost after sendMail was requested as uncertain, unlike a refusal before it', async () => {
    const lost = graph({ send: () => { throw new TypeError('connection reset'); } });
    expect(await lost.provider.send(message)).toEqual({ ok: false, status: null, retryAfterMs: null, uncertain: true });
    const refused = graph({ send: () => new Response(null, { status: 500 }) });
    expect(await refused.provider.send(message)).toEqual({ ok: false, status: 500, retryAfterMs: null });
  });

  it('renews the token after a 401 from sendMail', async () => {
    let calls = 0;
    const { provider, seen } = graph({ send: () => (++calls === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 202 })) });
    expect((await provider.send(message)).ok).toBe(false);
    expect(await provider.send(message)).toEqual({ ok: true });
    expect(seen.filter((entry) => entry.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });
});
