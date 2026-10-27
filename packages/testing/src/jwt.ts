import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { fc } from './fc';

export const TEST_TEAM_DOMAIN = 'https://synthetic-team.cloudflareaccess.com';
export const TEST_AUDIENCE = 'synthetic-access-aud-0000000000000000000000000000000000000000000000000000000000000000';
const DAY = 86_400;

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
export interface SigningKey { readonly kid: string; readonly privateKey: PrivateKey; readonly jwk: JWK }

export async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

/** A synthetic Access team: the current and previous published keys, and one key Access never published. */
export interface TestAccess {
  readonly teamDomain: string;
  readonly audience: string;
  readonly published: readonly [SigningKey, SigningKey];
  readonly unpublished: SigningKey;
}
export async function testAccess(): Promise<TestAccess> {
  return { teamDomain: TEST_TEAM_DOMAIN, audience: TEST_AUDIENCE, published: [await signingKey('synthetic-current'), await signingKey('synthetic-previous')], unpublished: await signingKey('synthetic-unpublished') };
}
/** The body Access serves at `/cdn-cgi/access/certs`. */
export function certsBody(keys: readonly SigningKey[]): { keys: JWK[] } {
  return { keys: keys.map((key) => key.jwk) };
}

/** Every way an assertion can fail verification; `null` is a valid assertion (Property 21). */
export const ASSERTION_FLAWS = [
  'missing', 'malformed', 'tampered', 'wrong_signature', 'wrong_aud', 'wrong_iss', 'expired', 'too_old', 'future_iat',
  'unknown_key', 'alg_none', 'hs256', 'no_email',
] as const;
export type AssertionFlaw = typeof ASSERTION_FLAWS[number];

export interface AssertionSpec {
  readonly flaw: AssertionFlaw | null;
  readonly email: string;
  /** Seconds between `iat` and the request; within 24 hours unless the flaw says otherwise. */
  readonly age: number;
  /** Seconds from the request until `exp`. */
  readonly remaining: number;
  readonly keyIndex: 0 | 1;
  readonly malformed: string;
  readonly wrongValue: string;
  readonly tamperAt: number;
  readonly excess: number;
}

/** Assertions for `emails`, valid or with one flaw each. */
export function jwtArb(emails: fc.Arbitrary<string>, flaws: fc.Arbitrary<AssertionFlaw | null> = fc.oneof(fc.constant(null), fc.constantFrom(...ASSERTION_FLAWS))): fc.Arbitrary<AssertionSpec> {
  return fc.record({
    flaw: flaws,
    email: emails,
    age: fc.integer({ min: 0, max: DAY }),
    remaining: fc.integer({ min: 1, max: DAY }),
    keyIndex: fc.constantFrom(0 as const, 1 as const),
    malformed: fc.oneof(fc.string(), fc.constantFrom('', '.', '..', 'eyJ.eyJ.', 'Bearer x'), fc.array(fc.base64String(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join('.'))),
    wrongValue: fc.string({ minLength: 0, maxLength: 12 }),
    tamperAt: fc.nat(),
    excess: fc.integer({ min: 1, max: 30 * DAY }),
  });
}

/** A valid assertion for `email`, issued at the request time and good for an hour, unless overridden. */
export function assertionSpec(email: string, overrides: Partial<AssertionSpec> = {}): AssertionSpec {
  return { flaw: null, email, age: 0, remaining: 3600, keyIndex: 0, malformed: '', wrongValue: '', tamperAt: 0, excess: 1, ...overrides };
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The `Cf-Access-Jwt-Assertion` value for `spec` at `now`, or undefined when the header is missing. */
export async function signAssertion(access: TestAccess, spec: AssertionSpec, now: Date): Promise<string | undefined> {
  const at = Math.floor(now.getTime() / 1000);
  const claims: JWTPayload & { email?: string } = {
    aud: [access.audience], iss: access.teamDomain, sub: `synthetic-${spec.email.length}`, email: spec.email, type: 'app',
    iat: at - spec.age, exp: at + spec.remaining,
  };
  let key = access.published[spec.keyIndex];
  let kid = key.kid;
  switch (spec.flaw) {
    case 'missing': return undefined;
    case 'malformed': return spec.malformed;
    case 'wrong_aud': claims.aud = [`${access.audience}${spec.wrongValue}x`]; break;
    case 'wrong_iss': claims.iss = `${access.teamDomain}${spec.wrongValue}x`; break;
    case 'expired': claims.exp = at - spec.excess + 1; claims.iat = Math.min(claims.iat!, claims.exp - 1); break;
    case 'too_old': claims.iat = at - DAY - spec.excess; break;
    case 'future_iat': claims.iat = at + spec.excess; break;
    case 'wrong_signature': key = access.unpublished; break;
    case 'unknown_key': key = access.unpublished; kid = key.kid; break;
    case 'no_email': delete claims.email; break;
    case 'alg_none': return `${encode({ alg: 'none', kid, typ: 'JWT' })}.${encode(claims)}.`;
    case 'hs256': {
      const secret = base64url.decode(access.published[spec.keyIndex].jwk.n!);
      return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid, typ: 'JWT' }).sign(secret);
    }
    default: break;
  }
  const token = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' }).sign(key.privateKey);
  if (spec.flaw !== 'tampered') return token;
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const index = spec.tamperAt % payload.length;
  const replacement = B64URL[(B64URL.indexOf(payload[index]!) + 1 + (spec.tamperAt % 63)) % 64]!;
  return `${header}.${payload.slice(0, index)}${replacement}${payload.slice(index + 1)}.${signature}`;
}

function encode(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}

/** The same address in a random letter case. */
export function caseVariant(email: string): fc.Arbitrary<string> {
  return fc.array(fc.boolean(), { minLength: email.length, maxLength: email.length })
    .map((upper) => [...email].map((character, index) => (upper[index] ? character.toUpperCase() : character.toLowerCase())).join(''));
}
