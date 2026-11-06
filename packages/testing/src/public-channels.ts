import { canonicalJson } from '@researchforce/kernel/views';
import { project } from '@researchforce/kernel/project';
import { projectProfile } from '@researchforce/kernel/substitute';
import { composeConsentConfirmationEmail, composeConsentEmail } from '@researchforce/public-render/email/consent';
import type { ConsentSnapshot } from '@researchforce/public-render/email/consent';
import { composeEmail } from '@researchforce/public-render/email/compose';
import { emailEntryFor } from '@researchforce/public-render/email/views';
import { renderExport } from '@researchforce/public-render/export/render-export';
import { renderSite } from '@researchforce/public-render/render-site';
import { buildSearchIndex } from '@researchforce/search-public/build';
import { siteInputFor } from './site';
import type { WorkspaceState } from './workspace';

/** One piece of output a public reader or crawler can obtain. */
export interface PublicArtifact { readonly name: string; readonly content: string; }

/** A route by which data reaches the public. Every channel that produces public output registers here so Property 5 checks it. */
export interface PublicChannel { readonly name: string; artifacts(state: WorkspaceState): Iterable<PublicArtifact>; }

const kernelViews: PublicChannel = {
  name: 'kernel public views',
  *artifacts(state) {
    for (const [key, view] of project(state.input)) yield { name: key, content: canonicalJson(view) };
  },
};

const kernelProfiles: PublicChannel = {
  name: 'kernel public profiles',
  *artifacts(state) {
    const emails = state.input.members.map((member) => member.email);
    for (const [id, profile] of state.profiles) {
      const projected = projectProfile(profile, emails);
      if (projected) yield { name: `profile:${id}`, content: canonicalJson(projected.view) };
    }
  },
};

/** Every page template, the sitemap, and robots.txt, as one Public_Site build writes them. */
const publicSite: PublicChannel = {
  name: 'public site pages',
  *artifacts(state) {
    for (const file of renderSite(siteInputFor(state))) yield { name: file.file, content: file.content };
  },
};

/** The manifest, term buckets, and document shards of the static public search index. */
const publicSearchIndex: PublicChannel = {
  name: 'public search index',
  *artifacts(state) {
    for (const file of buildSearchIndex(project(state.input))) yield { name: file.file, content: file.content };
  },
};

/** The address emails link to in tests. */
export const EMAIL_ORIGIN = 'https://app.example.test';

/** Notification emails describe Items by their Public_View alone: one email per Research_Item view, text and HTML (R20.6). */
const notificationEmails: PublicChannel = {
  name: 'notification emails',
  *artifacts(state) {
    for (const [key, view] of project(state.input)) {
      const entry = emailEntryFor(view, EMAIL_ORIGIN);
      if (entry === null) continue;
      const email = composeEmail({ subject: 'New Submission', entries: [entry], preferencesUrl: `${EMAIL_ORIGIN}/me/preferences` });
      yield { name: `email:${key}:text`, content: `${email.subject}\n${email.text}` };
      yield { name: `email:${key}:html`, content: email.html };
    }
  },
};

/**
 * Emailed Consent_Requests (R51.4, R51.16). The Consent_Request email is the one channel that shows a proposed
 * rather than a current Public_View, and only to the holder of its addressed token; it is composed from fixed
 * text, the requesting Administrator's name, the message, the Consent_Link, and the stored Consent_Page
 * snapshot, so it reveals nothing beyond that snapshot. Here each Public_View stands in for a snapshot proposing
 * exactly the current values, with a neutral Party label, so Property 5 confirms the email adds nothing of its
 * own; the full addressed-snapshot checks of Property 107 build real request snapshots.
 */
const consentEmails: PublicChannel = {
  name: 'consent request emails',
  *artifacts(state) {
    for (const [key, view] of project(state.input)) {
      const snapshot: ConsentSnapshot = view.tag === 'attachment'
        ? { kind: 'rights', key, view, document: { identifier: view.identifier, title: view.title, fileName: '', sizeBytes: view.size, sha256: '' } }
        : { kind: 'publication', key, view, partyName: 'a correspondent' };
      const email = composeConsentEmail({
        kind: snapshot.kind, requesterName: 'An administrator', consentUrl: `${EMAIL_ORIGIN}/consent#token`,
        expiresOn: '26 Nov 2026 UTC', snapshots: [snapshot],
      });
      yield { name: `consent:${key}:text`, content: `${email.subject}\n${email.text}` };
      yield { name: `consent:${key}:html`, content: email.html };
    }
  },
};

/**
 * The rf-submit consent responses (R51.5, R51.8, R51.10, R51.14). Opening a Consent_Link or Change_Link returns
 * the stored Consent_Page snapshot the person was shown, and the confirmation email after an answer or
 * withdrawal states that same snapshot with the recorded choice. Both are addressed — shown only to the holder
 * of the token — and composed from fixed text plus the stored snapshot, so they reveal nothing beyond it. Here
 * each Public_View stands in for a snapshot proposing exactly the current values, with a neutral Party label,
 * so Property 5 confirms the confirmation adds nothing of its own; the full addressed-snapshot checks live in
 * the consent property tests.
 */
const consentConfirmationEmails: PublicChannel = {
  name: 'consent confirmation emails',
  *artifacts(state) {
    for (const [key, view] of project(state.input)) {
      const snapshot: ConsentSnapshot = view.tag === 'attachment'
        ? { kind: 'rights', key, view, document: { identifier: view.identifier, title: view.title, fileName: '', sizeBytes: view.size, sha256: '' } }
        : { kind: 'publication', key, view, partyName: 'a correspondent' };
      const choice = snapshot.kind === 'rights' ? 'granted' : 'named';
      const email = composeConsentConfirmationEmail({
        action: 'answer', items: [{ snapshot, choice }], changeUrl: `${EMAIL_ORIGIN}/consent/change#token`, changeExpiresOn: '26 Nov 2027 UTC',
      });
      yield { name: `consent-confirmation:${key}:text`, content: `${email.subject}\n${email.text}` };
      yield { name: `consent-confirmation:${key}:html`, content: email.html };
    }
  },
};

/** Every file of a whole-archive Public_Archive_Export, which must reveal nothing beyond the Public_Views it is built from (R35.2, R35.4). */
const publicExport: PublicChannel = {
  name: 'public archive export',
  *artifacts(state) {
    for (const file of renderExport(siteInputFor(state), { startedAt: '2026-01-01T00:00:00.000Z', scope: 'Whole public archive' })) {
      yield { name: file.path, content: file.content };
    }
  },
};

export const PUBLIC_CHANNELS: readonly PublicChannel[] = [kernelViews, kernelProfiles, publicSite, publicSearchIndex, notificationEmails, consentEmails, consentConfirmationEmails, publicExport];
// Channels that need a running Worker, such as rf-dl and rf-submit, are registered in live-channels.ts
// (REQUIRED_LIVE_CHANNELS) and exercised by that Worker's workerd tests. rf-submit's confirmations and
// refusals are composed only from fixed text, the Submission_Reference, the time, and the Visitor's own
// validation results, so they reveal nothing about any Item (R31.6, R31.7).
