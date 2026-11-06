import { describe, expect, it } from 'vitest';
import type { PublicView } from '@researchforce/kernel/views';
import {
  CONSENT_CONFIRMATION_SUBJECT, CONSENT_SUBJECT, composeConsentConfirmationEmail, composeConsentEmail,
} from '../src/email/consent';
import type { ConsentSnapshot } from '../src/email/consent';

/** A minimal Correspondence Public_View for a publication snapshot. */
const correspondenceView: PublicView = { tag: 'research_item', key: 'u:C1', kind: 'correspondence', title: 'A letter' } as unknown as PublicView;
const publicationSnapshot: ConsentSnapshot = { kind: 'publication', key: 'u:C1', view: correspondenceView, partyName: 'Ada Example' };

describe('composeConsentEmail (R51.4)', () => {
  it('states who asks, the Consent_Link, and the expiry, composed only from its facts', () => {
    const email = composeConsentEmail({
      kind: 'publication', requesterName: 'An administrator', message: 'Please consider this.',
      consentUrl: 'https://submit.example.test/consent#token', expiresOn: '26 Nov 2026 UTC', snapshots: [publicationSnapshot],
    });
    expect(email.subject).toContain(CONSENT_SUBJECT);
    expect(email.text).toContain('https://submit.example.test/consent#token');
    expect(email.text).toContain('26 Nov 2026 UTC');
    expect(email.text).toContain('Ada Example');
  });
});

describe('composeConsentConfirmationEmail (R51.8, R51.10)', () => {
  it('states each recorded answer against its snapshot and carries the Change_Link', () => {
    const email = composeConsentConfirmationEmail({
      action: 'answer', items: [{ snapshot: publicationSnapshot, choice: 'named' }],
      changeUrl: 'https://submit.example.test/consent/change#change', changeExpiresOn: '26 Nov 2027 UTC',
    });
    expect(email.subject).toContain(CONSENT_CONFIRMATION_SUBJECT);
    expect(email.text).toContain('You answered: Yes, publish with my name.');
    expect(email.text).toContain('https://submit.example.test/consent/change#change');
    expect(email.text).toContain('26 Nov 2027 UTC');
  });

  it('reads as a withdrawal and names the withdrawn material when the action is a withdrawal', () => {
    const email = composeConsentConfirmationEmail({
      action: 'withdrawal', items: [{ snapshot: publicationSnapshot, choice: 'withdrawn' }],
      changeUrl: 'https://submit.example.test/consent/change#change', changeExpiresOn: '26 Nov 2027 UTC',
    });
    expect(email.text).toContain('Your withdrawal has been recorded.');
    expect(email.text).toContain('no longer published with your permission');
  });

  it('reveals nothing beyond the snapshot it is given', () => {
    const email = composeConsentConfirmationEmail({
      action: 'answer', items: [{ snapshot: publicationSnapshot, choice: 'refused' }],
      changeUrl: 'https://submit.example.test/consent/change#change', changeExpiresOn: '26 Nov 2027 UTC',
    });
    // Only the snapshot's own fields appear; no other correspondence content leaks.
    expect(email.text).toContain('A letter');
    expect(email.text).not.toContain('secret');
  });
});
