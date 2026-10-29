import type { Env } from '../../env';
import type { EmailMessage, EmailProvider, SendResult } from '../provider';

/** The one place that chooses how the plain-text part is produced: Exchange Online converts the HTML body (R20.19). */
export const BODY_MODE = 'html-with-exchange-conversion' as const;
const SCOPE = 'https://graph.microsoft.com/.default';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const ASSERTION_LIFETIME_S = 600;
/** Tokens are renewed this long before they expire. */
const TOKEN_MARGIN_MS = 60_000;

export interface GraphCredentials {
  readonly tenantId: string;
  readonly clientId: string;
  /** The certificate's private key as PKCS#8 PEM, and its SHA-1 thumbprint in hexadecimal. */
  readonly privateKeyPem: string;
  readonly thumbprint: string;
  /** The mailbox the emails are sent from (the Sending_Address). */
  readonly sendingAddress: string;
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.replaceAll(/[^0-9a-f]/giu, '').match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const pemBody = (pem: string): Uint8Array => Uint8Array.from(atob(pem.replaceAll(/-----[^-]+-----|\s/gu, '')), (char) => char.codePointAt(0)!);

/**
 * Microsoft Graph through the client-credentials flow with a certificate assertion signed by WebCrypto. The token lives only
 * in this object's memory, and nothing the provider receives is logged or stored (R20.20, R20.22).
 */
export class GraphProvider implements EmailProvider {
  #token: { readonly value: string; readonly expiresAt: number } | null = null;
  #key: CryptoKey | null = null;

  constructor(readonly credentials: GraphCredentials, readonly fetcher: typeof fetch = fetch, readonly clock: () => number = Date.now) {}

  static fromEnv(env: Env, fetcher: typeof fetch = fetch): GraphProvider | null {
    const { GRAPH_TENANT_ID: tenantId, GRAPH_CLIENT_ID: clientId, GRAPH_CERT_KEY: privateKeyPem, GRAPH_CERT_THUMBPRINT: thumbprint, SENDING_ADDRESS: sendingAddress } = env;
    if (!tenantId || !clientId || !privateKeyPem || !thumbprint || !sendingAddress) return null;
    return new GraphProvider({ tenantId, clientId, privateKeyPem, thumbprint, sendingAddress }, fetcher);
  }

  async #assertion(): Promise<string> {
    const { credentials } = this;
    this.#key ??= await crypto.subtle.importKey('pkcs8', pemBody(credentials.privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const now = Math.floor(this.clock() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', x5t: base64url(fromHex(credentials.thumbprint)) };
    const claims = {
      aud: `https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`, iss: credentials.clientId, sub: credentials.clientId,
      jti: crypto.randomUUID(), nbf: now, exp: now + ASSERTION_LIFETIME_S,
    };
    const signing = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.#key, encoder.encode(signing)));
    return `${signing}.${base64url(signature)}`;
  }

  async #accessToken(): Promise<string | null> {
    if (this.#token && this.#token.expiresAt - TOKEN_MARGIN_MS > this.clock()) return this.#token.value;
    const body = new URLSearchParams({
      client_id: this.credentials.clientId, scope: SCOPE, grant_type: 'client_credentials',
      client_assertion_type: ASSERTION_TYPE, client_assertion: await this.#assertion(),
    });
    const response = await this.fetcher(`https://login.microsoftonline.com/${this.credentials.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!response.ok) return null;
    const parsed = await response.json<{ access_token?: string; expires_in?: number }>().catch(() => ({}) as { access_token?: string; expires_in?: number });
    if (typeof parsed.access_token !== 'string') return null;
    this.#token = { value: parsed.access_token, expiresAt: this.clock() + (parsed.expires_in ?? 3600) * 1000 };
    return parsed.access_token;
  }

  /** `sendMail` with one recipient, an HTML body, and no copy in Sent Items: the MIME form always saves one (R20.24). */
  async send(message: EmailMessage): Promise<SendResult> {
    let requested = false;
    try {
      const token = await this.#accessToken();
      if (token === null) return { ok: false, status: null, retryAfterMs: null };
      requested = true;
      const response = await this.fetcher(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.credentials.sendingAddress)}/sendMail`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: message.subject, body: { contentType: 'HTML', content: message.html },
            from: { emailAddress: { name: 'ResearchForce', address: this.credentials.sendingAddress } },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
          saveToSentItems: false,
        }),
      });
      if (response.status === 401) this.#token = null;
      if (response.ok) return { ok: true };
      const seconds = Number(response.headers.get('Retry-After'));
      return { ok: false, status: response.status, retryAfterMs: response.status === 429 && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
    } catch {
      // Once sendMail was requested, a lost answer leaves open whether Exchange accepted the message.
      return requested ? { ok: false, status: null, retryAfterMs: null, uncertain: true } : { ok: false, status: null, retryAfterMs: null };
    }
  }
}
