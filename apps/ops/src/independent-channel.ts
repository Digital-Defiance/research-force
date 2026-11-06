/**
 * The INDEPENDENT operator alert channel shared by every rf-ops alert class (task 59.2's confidentiality
 * incident and backup-age alert, and task 67.2's health and spend alerts). The channel is a single webhook
 * endpoint plus a bearer token held in a credential store SEPARATE from the primary account token
 * (`CF_ACCESS_API_TOKEN`), so an alert reaches the operator even when the primary account is locked and the
 * application D1 and its Graph email queue are unavailable (R28.6, R60.6; design `infra/ops/` provider-native
 * or independent external checks whose delivery does not need `rf-core` or the Graph queue).
 *
 * Trusted credential custody (R60.6): the webhook bearer (`alertToken`) is the ONLY secret this channel
 * needs and it is vaulted independently of every Cloudflare API token. It is write-only — it can post an
 * alert but cannot read research, issue a Download_Link, or recover a backup — so a payload that carried a
 * research body, a bearer link, or a recovery secret would both leak content AND be pointless. Every payload
 * is therefore content-free by construction: identities, levels, ages, counts, and percentages only.
 */

/** The write-only coordinates of the independent alert channel. Both fields are required for any post. */
export interface IndependentChannel {
  /** The independent alert channel endpoint (a provider distinct from the app and its email queue, R28.6). */
  readonly alertWebhookUrl: string;
  /** Secret. The write-only bearer credential for the independent alert channel, vaulted separately (R60.6). */
  readonly alertToken: string;
}

/**
 * POST a content-free alert `payload` (which MUST already carry only identities/levels/ages/counts, never a
 * research body, bearer link, or recovery secret) to the independent channel. Throws `description` when the
 * channel is not configured, and `rejection` when it refuses or cannot be reached — never asserting success
 * on a lost response (R60.6). The bearer token is sent in the `authorization` header only; it never appears
 * in the body.
 */
export async function postIndependentAlert(
  fetcher: typeof fetch,
  channel: IndependentChannel,
  payload: Record<string, unknown>,
  messages: { readonly description: string; readonly rejection: string },
): Promise<void> {
  if (!channel.alertWebhookUrl || !channel.alertToken) throw new Error(messages.description);
  const response = await fetcher(channel.alertWebhookUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${channel.alertToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response || !response.ok) throw new Error(messages.rejection);
}
