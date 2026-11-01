import type { POLICY_PAGE_KEYS } from '../schema/core/activity';

/**
 * Microsoft 365 keeps residual copies of sent mail even when the Sending_Address mailbox requests no Sent Items
 * copy: a copy can remain in the hidden Recoverable Items folder for the deleted-item retention period while single
 * item recovery is on, and Microsoft 365 keeps its own delivery records, such as message traces, outside the
 * Research_CMS (R20.24). Design open question 2 is resolved: this residual retention is disclosed on the Privacy page
 * and staging verifies the tenant's effective behavior, and saveToSentItems is never presented as erasing all
 * provider copies. The flag is true, so the Privacy page states this plainly.
 */
export const STATE_MAILBOX_RESIDUAL_COPIES = true;

export type PolicyPageKey = typeof POLICY_PAGE_KEYS[number];
export interface SeedPolicySection {
  readonly pageKey: PolicyPageKey;
  readonly sectionKey: string;
  readonly title: string;
  readonly required: boolean;
  readonly text: string;
}

const servicesThatProcessData = [
  'The software runs on Cloudflare. Cloudflare Workers, D1, and R2 store and serve the archive and the workspace, Cloudflare Access handles Member sign-in, and Cloudflare Turnstile checks that the public form is used by a person.',
  'Email to Members and to people who use the public form is sent through Microsoft 365, which processes the recipient’s email address and the message.',
  'Members can ask Workers AI, Cloudflare’s hosted AI service, for a draft summary. Only the text being summarised is sent, and Cloudflare states that it does not keep that text or use it to train models.',
  ...(STATE_MAILBOX_RESIDUAL_COPIES
    ? ['Even though the sending mailbox is asked to keep no copy of a sent email, Microsoft 365 can keep a residual copy in a hidden recovery area for its deleted-item retention period while single-item recovery is on, and it keeps its own delivery records, such as message traces, outside this site. Asking the mailbox to save no copy does not remove those provider records.']
    : []),
].join('\n\n');

/**
 * The fixed list of Policy_Sections per page, in order, with initial text for each required one
 * (R46.1, R46.6, R46.11, R46.15, R46.18, R46.21, R46.32). The text is written for any installation of
 * the software; each installation’s Administrators replace it with their own group’s policies.
 */
export const SEED_POLICY_SECTIONS: readonly SeedPolicySection[] = Object.freeze([
  { pageKey: 'about', sectionKey: 'about_the_group', title: 'About the group', required: true,
    text: 'This archive is kept by the research group that runs this site. Its Administrators describe here who the group is, what it works on, and how it organises its work.' },
  { pageKey: 'people', sectionKey: 'introduction', title: 'Introduction', required: false, text: '' },
  { pageKey: 'methods', sectionKey: 'evidence_standards', title: 'Evidence standards', required: true,
    text: 'Each finding states its claim, the limits within which it holds, and the evidence linked to it. A finding is marked confirmed only when that evidence supports it.' },
  { pageKey: 'methods', sectionKey: 'provenance_labels', title: 'Provenance labels', required: true,
    text: 'Exact quotations, paraphrases, and claims reported by a source are labelled separately and name their source, so that a reader can tell them apart from the authors’ own words.' },
  { pageKey: 'methods', sectionKey: 'statuses_and_outcomes', title: 'Statuses and outcomes', required: true,
    text: 'Records carry a status or outcome from the lists below. Negative results, eliminated hypotheses, and dead ends stay in the archive as part of the historical record.' },
  { pageKey: 'methods', sectionKey: 'withheld_and_private_material', title: 'Withheld and private material', required: true,
    text: 'Some material is withheld: the archive records that it exists, with its kind, date, and parties, but does not publish its content. Other material is not published at all, for example because consent or reproduction rights are missing.' },
  { pageKey: 'methods', sectionKey: 'corrections_and_withdrawals', title: 'Corrections and withdrawals', required: true,
    text: 'Corrections are recorded with a reason and a date. Withdrawn material stays in the record, marked with the date and reason, so that nothing is silently removed.' },
  { pageKey: 'licence', sectionKey: 'further_notes', title: 'Further notes', required: true,
    text: 'The content licence named on this page is chosen and configured by the group that runs this site; no licence is assumed and the software licence is never used in its place. Before any public launch or team-archive use, the group must configure a content licence and the recovery and email-provider inputs the setup needs; the launch gates do not pass until those are in place.' },
  { pageKey: 'privacy', sectionKey: 'members', title: 'Members', required: true,
    text: 'For each Member the site keeps an email address for sign-in and notifications, the profile the Member enters, and a record of the Member’s contributions and their history, so that work stays attributed to its authors. Members reach a protected file through a short-lived download link. Such a link is a scoped exception to the usual sign-in check: it is valid for only a few minutes, is tied to the Member it was issued to, and grants access to that one file alone, not to the rest of the Workspace.' },
  { pageKey: 'privacy', sectionKey: 'submitters_and_requesters', title: 'Submitters and requesters', required: true,
    text: 'When someone uses the public form, the site keeps the name, email address, affiliation, message, and files they send, so that the group can review the submission, reply, and credit accepted material. The table below states how long each part is kept.' },
  { pageKey: 'privacy', sectionKey: 'people_named_in_records', title: 'People named in records', required: true,
    text: 'Research records can name people outside the group, such as correspondents and archive staff. Correspondence is published only with the consent of every outside party. An outside party is named in a published record only while recorded permission allows naming that person on that record and the person has not asked not to be named; otherwise the record shows a generic label or a neutral role description instead of the name, and never reveals the withheld name.' },
  { pageKey: 'privacy', sectionKey: 'visitors', title: 'Visitors', required: true,
    text: 'Reading the public archive needs no account, and the archive sets no cookies. The public form uses a bot check, and the site counts form use per network address for a short time to limit abuse.' },
  { pageKey: 'privacy', sectionKey: 'services_that_process_data', title: 'Services that process data', required: true, text: servicesThatProcessData },
  { pageKey: 'privacy', sectionKey: 'your_requests', title: 'Your requests', required: true,
    text: 'You can ask to see, correct, or remove personal data about you by sending a removal request through the public form. A removal request is never published.' },
  { pageKey: 'corrections', sectionKey: 'asking_for_a_correction', title: 'Asking for a correction', required: true,
    text: 'If you think something in the archive is wrong, send a correction through the public form. Say which page it concerns and what should change, and include any evidence you have.' },
  { pageKey: 'corrections', sectionKey: 'asking_for_a_removal_or_about_personal_data', title: 'Asking for a removal or about personal data', required: true,
    text: 'To ask for material to be removed, or about personal data the site holds about you, send a removal request through the public form.' },
  { pageKey: 'corrections', sectionKey: 'what_happens_next', title: 'What happens next', required: true,
    text: 'An Administrator reviews each request and replies by email with the outcome. Accepted corrections are recorded in the history of the page they change.' },
] satisfies SeedPolicySection[]);
