import type { Env } from '../env';
import { GraphProvider } from './providers/graph';

/** One email to one recipient (R20.8). */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}
/**
 * What a send attempt came to. A refusal never carries the provider's response, which can name the recipient or hold
 * credentials (R20.20); `status` and `retryAfterMs` are all that is kept.
 */
export type SendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number | null; readonly retryAfterMs: number | null; /** The request may have reached the provider and been accepted: no response arrived. */ readonly uncertain?: true };

/** The Email_Provider interface; Microsoft Graph is the one implementation (R20.11). */
export interface EmailProvider { send(message: EmailMessage): Promise<SendResult> }

/**
 * The configured provider, read at each attempt so that a retry after a change goes through the new one (R20.11, R20.21).
 * Returns `null` when the provider's secrets are not set, which counts as a failed attempt.
 */
export function providerFor(env: Env, fetcher: typeof fetch = fetch): EmailProvider | null {
  if (env.RF_LOCAL_SERVICES !== undefined || env.LOCAL_SERVICES !== undefined || env.RF_DEV_AUTH !== undefined || env.RF_DEV_AUTH_PRIVATE_KEY !== undefined) throw new Error('Local mail capture requires the local Mailer entrypoint.');
  return GraphProvider.fromEnv(env, fetcher);
}
