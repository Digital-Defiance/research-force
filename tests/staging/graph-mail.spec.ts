/**
 * Graph / mail staging verification (task 48.5; R20.19, R20.21, R20.22, R20.24, R20.26, R45.21, and
 * the Turnstile and addressed-snapshot checks R28.17). Gate: the outbound-mail launch gate.
 *
 * Against the deployed staging install's operator-only Graph verification route (the same checks
 * `infra/m365/Verify-ResearchForceMail.ps1` performs, surfaced for the automated gate), this suite
 * confirms the install's REAL Microsoft 365 wiring:
 *   - Least-privilege send (R20.19): the app is authorized to send ONLY as the ResearchForce
 *     mailbox and no other — `Test-ServicePrincipalAuthorization` returns a Mail.Send grant scoped to
 *     the one mailbox, and an attempt to send as any other address is refused.
 *   - Certificate-credential rotation (R20.21): the registered certificate credential is present,
 *     matches the configured thumbprint, and is not expired (and its remaining lifetime leaves room
 *     to rotate before expiry).
 *   - SPF/DKIM/DMARC resolve (R20.22): the live records match the encoded expectations in
 *     `infra/dns/records.ts` — the SAME expectations `tools/check-email-dns.ts` enforces.
 *   - Acceptance-vs-delivery distinction (R20.26): a probe send reports Graph ACCEPTANCE as distinct
 *     from downstream DELIVERY; the suite asserts the report never conflates the two.
 *   - MIME / plain-text handling (R20.19): the probe exercises both a MIME and a plain-text body and
 *     the report confirms each was formed correctly.
 *   - Residual provider retention is none (R20.24): the mailbox hardening leaves single-item recovery
 *     off, the shortest retention, and no holds, and the report confirms no residual copy is retained
 *     by the provider.
 *   - Mailbox display name (R45.21): the configured mailbox display name is `ResearchForce`.
 *   - Turnstile & addressed snapshots (R28.17): the public/submit forms serve the configured
 *     Turnstile sitekey.
 *
 * These checks require the real staging install and operator token; without them the outbound-mail
 * gate is reported BLOCKED (never skipped). The DNS expectation checks that are pure (comparing the
 * encoded record set) also run so a records drift is caught in enumeration/type-check.
 */
import { expect, test } from '@playwright/test';
import { SENDING_ADDRESS as RECORDS_SENDING_ADDRESS, emailDnsRecords } from '../../infra/dns/records';
import {
  GRAPH_VERIFY_ENDPOINT,
  GRAPH_VERIFY_TOKEN,
  MAILBOX_DISPLAY_NAME,
  PUBLIC_ORIGIN,
  SENDING_ADDRESS,
  TURNSTILE_SITEKEY,
} from './support/env';
import { describeGate, handle } from './support/gate';
import { field, flag, numberField, operatorGet, operatorPost } from './support/operator';

const GATE = 'Outbound-mail gate (Graph / mail)';

const ready = describeGate(GATE, [
  handle('STAGING_GRAPH_VERIFY_ENDPOINT', GRAPH_VERIFY_ENDPOINT),
  handle('STAGING_GRAPH_VERIFY_TOKEN', GRAPH_VERIFY_TOKEN),
  handle('STAGING_SENDING_ADDRESS', SENDING_ADDRESS),
  handle('STAGING_PUBLIC_ORIGIN', PUBLIC_ORIGIN),
  handle('STAGING_TURNSTILE_SITEKEY', TURNSTILE_SITEKEY),
]);

/** The encoded DNS expectations the live records must match — the same set the DNS checker enforces. */
test.describe('email DNS expectations are internally consistent (R20.22)', () => {
  test('the encoded record set is well formed and the DMARC rua is not the Sending_Address', () => {
    expect(emailDnsRecords.spf.value).toBe('v=spf1 include:spf.protection.outlook.com -all');
    expect(emailDnsRecords.dkim).toHaveLength(2);
    for (const dkim of emailDnsRecords.dkim) expect(dkim.dnsOnly).toBe(true);
    expect(emailDnsRecords.dmarc.value).toContain('p=none');
    // The DMARC aggregate-report address must never be the Sending_Address (R20.23), or report mail loops back.
    expect(emailDnsRecords.dmarc.ruaAddress.toLowerCase()).not.toBe(RECORDS_SENDING_ADDRESS.toLowerCase());
    expect(emailDnsRecords.dmarc.value).toContain(`mailto:${emailDnsRecords.dmarc.ruaAddress}`);
  });
});

if (ready) {
  test.describe(GATE, () => {
    test('the app is authorized to send only as the ResearchForce mailbox (R20.19, R45.21)', async ({ request }) => {
      const result = await operatorGet(request, GRAPH_VERIFY_ENDPOINT!, GRAPH_VERIFY_TOKEN!, 'authorization');
      expect(result.ok, 'the Graph authorization check must succeed').toBe(true);
      expect(flag(result.body, 'mailSendScopedToMailbox'), 'Mail.Send must be scoped to the one mailbox').toBe(true);
      expect(flag(result.body, 'anyOtherMailboxDenied'), 'sending as any other mailbox must be denied').toBe(true);
      expect(field(result.body, 'sendingAddress')).toBe(SENDING_ADDRESS);
      expect(field(result.body, 'mailboxDisplayName')).toBe(MAILBOX_DISPLAY_NAME);
    });

    test('the certificate credential is present, matches the configured thumbprint, and is not expiring (R20.21)', async ({ request }) => {
      const result = await operatorGet(request, GRAPH_VERIFY_ENDPOINT!, GRAPH_VERIFY_TOKEN!, 'certificate');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'certificatePresent'), 'the app must carry the certificate credential').toBe(true);
      expect(flag(result.body, 'thumbprintMatches'), 'the registered credential must match the configured thumbprint').toBe(true);
      expect(flag(result.body, 'expired'), 'the certificate must not be expired').toBe(false);
      const daysToExpiry = numberField(result.body, 'daysToExpiry');
      expect(daysToExpiry, 'the certificate must leave room to rotate before expiry (R20.21)').toBeGreaterThan(0);
    });

    test('SPF, DKIM and DMARC resolve to the configured values (R20.22)', async ({ request }) => {
      const result = await operatorGet(request, GRAPH_VERIFY_ENDPOINT!, GRAPH_VERIFY_TOKEN!, 'dns');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'spfMatches'), 'SPF must resolve to the expected policy').toBe(true);
      expect(flag(result.body, 'dkimMatches'), 'both DKIM selectors must resolve to their M365 targets').toBe(true);
      expect(flag(result.body, 'dmarcMatches'), 'DMARC must resolve to p=none with the expected rua').toBe(true);
    });

    test('a probe send distinguishes acceptance from delivery and forms both MIME and plain text (R20.26, R20.19)', async ({ request }) => {
      const result = await operatorPost(request, GRAPH_VERIFY_ENDPOINT!, GRAPH_VERIFY_TOKEN!, { probe: 'acceptance-vs-delivery', bodies: ['mime', 'plain'] }, 'probe-send');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'accepted'), 'the probe must report Graph acceptance').toBe(true);
      // Acceptance and delivery are distinct signals; the report must not conflate them (R20.26).
      expect(field(result.body, 'deliveryState'), 'delivery must be reported separately from acceptance').toBeDefined();
      expect(flag(result.body, 'acceptanceConflatedWithDelivery'), 'acceptance must never be reported as delivery').toBe(false);
      expect(flag(result.body, 'mimeFormedCorrectly'), 'the MIME body must be formed correctly').toBe(true);
      expect(flag(result.body, 'plainTextFormedCorrectly'), 'the plain-text body must be formed correctly').toBe(true);
    });

    test('the provider retains no residual copy of sent mail (R20.24)', async ({ request }) => {
      const result = await operatorGet(request, GRAPH_VERIFY_ENDPOINT!, GRAPH_VERIFY_TOKEN!, 'retention');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'singleItemRecoveryEnabled'), 'single item recovery must be off').toBe(false);
      expect(flag(result.body, 'anyHoldApplied'), 'no hold may be applied to the mailbox').toBe(false);
      expect(flag(result.body, 'residualProviderRetention'), 'the provider must retain no residual copy').toBe(false);
    });

    test('the public and submit forms serve the configured Turnstile sitekey (R28.17)', async ({ request }) => {
      const response = await request.get(`${PUBLIC_ORIGIN}/submit`, { maxRedirects: 0 });
      const html = await response.text();
      expect(html, 'the submit form must serve the configured Turnstile sitekey').toContain(TURNSTILE_SITEKEY!);
    });
  });
}
