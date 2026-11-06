import { partialDate } from '@researchforce/domain/dates';
import { retentionRows } from '@researchforce/domain/retention';
import type { RichText } from '@researchforce/domain/richtext';
import type {
  AttachmentView, DissentNoteView, ProjectRef, ProjectView, PublicView, ReplyView, ResearchItemView, UnitKey, ValueRef, WithheldView,
} from '@researchforce/kernel/views';
import { assertPublicCopy, type InstallationPublicCopy, type ValidatedInstallationPublicCopy } from '@researchforce/design/installation';
import { FIXED_TERM_KEYS, POLICY_PAGE_KEYS, type MethodsInput, type PolicyPageInput, type PolicyPageKey, type SiteInput } from '../src/site';

/**
 * A synthetic Installation_Public_Copy, visibly different from ResearchForce.org: a made-up collective, strapline,
 * Mission, About prose, and Principles. Nothing here is drawn from `docs/instance/researchforce-org-content.md`.
 */
export const SYNTHETIC_COPY: InstallationPublicCopy = {
  version: '2026-02-02',
  name: 'Synthetic Collective',
  strapline: 'A visibly different strapline',
  mission: {
    heading: 'Our mission',
    paragraphs: ['The Synthetic Collective studies entirely made-up questions for a test fixture and keeps a synthetic record of them.'],
  },
  about: [
    'The Synthetic Collective is a fixture group that exists only to exercise the renderers.',
    'It has one synthetic Project and a handful of synthetic members.',
  ],
  principles: [
    { name: 'Synthetic independence', text: 'The fixture answers to the test, not to any real funder.' },
    { name: 'Made-up provenance', text: 'Every synthetic claim points to a synthetic source.' },
    { name: 'Keep the fixture whole', text: 'Synthetic dead ends stay in the synthetic record.' },
  ],
};
export const PUBLIC_COPY: ValidatedInstallationPublicCopy = assertPublicCopy(SYNTHETIC_COPY);

/** Synthetic values only; nothing here comes from a real archive. */
export const rich = (text: string, spans: RichText['spans'] = []): RichText => ({ text, spans });
export const LINE = { kindOfMaterial: 'Letter', date: partialDate('1950-03'), parties: ['A Correspondent'] };

export const VALUES = {
  superseded: { id: '00000000000000000000000023', name: 'Superseded' },
  eliminated: { id: '00000000000000000000000002', name: 'Eliminated' },
  ownWork: { id: '0000000000000000000000P001', name: 'Own work' },
  licensed: { id: '01V00000000000000000000009', name: 'Licensed' },
  related: { id: '01V00000000000000000000008', name: 'Related' },
  addresses: { id: '00000000000000000000000006', name: 'Addresses' },
  retiredUnused: { id: '01V00000000000000000000010', name: 'Old status' },
} satisfies Record<string, ValueRef>;

export const PROJECT: ProjectView = { tag: 'project', key: 'p:1', path: '/p/alpha', name: 'Alpha Project', description: 'A synthetic project.', slug: 'alpha', accent: 'teal' };
export const OTHER: ProjectView = { tag: 'project', key: 'p:2', path: '/p/beta', name: 'Beta Project', description: 'Another synthetic project.', slug: 'beta' };
export const WITHHELD_PROJECT: WithheldView = { tag: 'withheld', key: 'p:3', path: '/p/hidden-slug', line: { kindOfMaterial: 'Project', date: partialDate('1960'), parties: [] } };
export const REF: ProjectRef = { key: PROJECT.key, name: PROJECT.name, slug: PROJECT.slug, path: PROJECT.path, accent: 'teal' };

export const FINDING: ResearchItemView = {
  tag: 'research_item', key: 'u:finding', path: '/r/AAAA-1111-BBBB', kind: 'finding', title: 'A synthetic finding',
  publicSummary: rich('The **public** summary.'), itemDate: partialDate('1951-04-02'), logDate: partialDate('1951-04-02'),
  credit: [{ name: 'Ada Example', profiled: true }, { name: 'Bob Outside', affiliation: 'Example University' }],
  identifier: 'AAAA-1111-BBBB',
  status: {
    kind: 'finding', status: VALUES.superseded, scopeCaveat: rich('Holds for the tested batch only.', [{ k: 'quote', s: 0, e: 5, source: 'Lab notes' }]),
    supersededBy: { tag: 'link', key: 'u:hypothesis', path: '/r/CCCC-2222-DDDD', type: 'research_item', title: 'A synthetic hypothesis', kind: 'hypothesis' },
  },
  withdrawal: { date: '2026-02-03', reason: 'Replaced by later work.' },
  project: REF, firstPublicOn: '2026-01-05',
  attachments: [{ key: 'u:file-old' }, { key: 'u:file-withheld' }],
  links: [
    { direction: 'outgoing', relation: VALUES.related, target: { tag: 'link', key: 'u:hypothesis', path: '/r/CCCC-2222-DDDD', type: 'research_item', title: 'A synthetic hypothesis', kind: 'hypothesis', status: { kind: 'hypothesis', status: VALUES.eliminated } } },
    { direction: 'incoming', target: { tag: 'withheld', key: 'u:withheld-item', path: '/r/WWWW-0000-WWWW', line: LINE } },
  ],
  full: {
    fields: [{ key: 'claim', value: { t: 'rich', value: rich('The claim text.') } }],
    logSummary: rich('The log summary.'), sections: [], replies: [{ key: 'u:reply' }], dissent: [{ key: 'u:dissent' }, { key: 'u:dissent-withheld' }],
  },
};
export const HYPOTHESIS: ResearchItemView = {
  tag: 'research_item', key: 'u:hypothesis', path: '/r/CCCC-2222-DDDD', kind: 'hypothesis', title: 'A synthetic hypothesis',
  itemDate: partialDate('1952'), logDate: partialDate('1953-01-01'), credit: [{ name: 'Carla Imported' }], identifier: 'CCCC-2222-DDDD',
  status: { kind: 'hypothesis', status: VALUES.eliminated, eliminationScope: rich('Rules out the night route.') },
  project: REF, firstPublicOn: '2026-01-06', attachments: [], links: [],
};
export const FILE_OLD: AttachmentView = {
  tag: 'attachment', key: 'u:file-old', path: '/a/EEEE-3333-FFFF', title: 'Scan, first version', fileKind: 'pdf', size: 2_500_000, caption: 'Page one',
  credit: [{ name: 'Ada Example', profiled: true }], origin: 'Scanned by a member', identifier: 'EEEE-3333-FFFF',
  rights: { status: VALUES.licensed, holder: 'An Archive', terms: 'Reproduced by permission.', licenceCovers: false },
  download: '/f/EEEE-3333-FFFF', supersededBy: { key: 'u:file-new', path: '/a/GGGG-4444-HHHH', uploadedOn: '2026-03-04' },
  parent: { key: FINDING.key, path: FINDING.path }, project: REF, links: [], replies: [],
};
export const FILE_NEW: AttachmentView = {
  tag: 'attachment', key: 'u:file-new', path: '/a/GGGG-4444-HHHH', title: 'Scan, second version', fileKind: 'image', size: 900,
  credit: [], origin: 'Photographed by a member', identifier: 'GGGG-4444-HHHH', rights: { status: VALUES.ownWork, licenceCovers: true },
  download: '/f/GGGG-4444-HHHH', parent: { key: FINDING.key, path: FINDING.path }, project: REF, links: [], replies: [],
};

export const REPLY: ReplyView = {
  tag: 'reply', key: 'u:reply', text: rich('A reply in the thread.'), author: 'Dana Member', postedOn: '2026-01-07', attachments: [], replies: [{ key: 'u:reply-withheld' }], links: [],
};
export const DISSENT: DissentNoteView = {
  tag: 'dissent_note', key: 'u:dissent', text: rich('I read the result differently.'), author: 'Ada Example', savedOn: '2026-01-08', earlierWording: true, authorProfiled: true,
};
/** A Full_Content Research_Question whose entries are Addresses Cross_Links to a Public Finding and a Withheld item (R50.4). */
export const QUESTION: ResearchItemView = {
  tag: 'research_item', key: 'u:question', path: '/r/QQQQ-6666-RRRR', kind: 'research_question', title: 'A synthetic question',
  itemDate: partialDate('1954'), logDate: partialDate('1954'), credit: [{ name: 'Dana Member' }], identifier: 'QQQQ-6666-RRRR',
  project: REF, firstPublicOn: '2026-01-09', attachments: [],
  question: 'What really happened on the night route?',
  links: [
    { direction: 'outgoing', relation: VALUES.addresses, target: { tag: 'link', key: FINDING.key, path: FINDING.path, type: 'research_item', title: FINDING.title, kind: 'finding' } },
    { direction: 'outgoing', relation: VALUES.addresses, target: { tag: 'withheld', key: 'u:withheld-item', path: '/r/WWWW-0000-WWWW', line: LINE } },
  ],
  full: { fields: [{ key: 'introduction', value: { t: 'rich', value: rich('The **introduction** to the question.') } }], sections: [], replies: [], dissent: [] },
};
/** A Summary_Only Research_Question of the same Project, created earlier, so the two order newest first by default. */
export const QUESTION_SUMMARY: ResearchItemView = {
  tag: 'research_item', key: 'u:question-2', path: '/r/SSSS-7777-TTTT', kind: 'research_question', title: 'An earlier synthetic question',
  itemDate: partialDate('1953'), logDate: partialDate('1953'), credit: [], identifier: 'SSSS-7777-TTTT',
  project: REF, firstPublicOn: '2026-01-04', attachments: [], question: 'Why was the route chosen at all?', links: [],
};

const withheld = (key: UnitKey, path: string | undefined, kindOfMaterial: string, date = '1950-03'): WithheldView =>
  ({ tag: 'withheld', key, ...(path === undefined ? {} : { path }), line: { ...LINE, kindOfMaterial, date: partialDate(date) }, project: REF });

export const VIEWS: readonly PublicView[] = [
  PROJECT, OTHER, WITHHELD_PROJECT, FINDING, HYPOTHESIS, FILE_OLD, FILE_NEW, REPLY, DISSENT,
  withheld('u:file-withheld', '/a/IIII-5555-JJJJ', 'Photograph', '1949'),
  withheld('u:reply-withheld', undefined, 'Reply', '1955'),
  withheld('u:dissent-withheld', undefined, 'Dissent note', '1954'),
  withheld('u:withheld-item', '/r/WWWW-0000-WWWW', 'Letter', '1950-03'),
];

export const METHODS: MethodsInput = {
  values: {
    campaign_status: [], finding_status: [{ ...VALUES.superseded, description: 'Replaced by a later finding.', retired: false }],
    run_outcome: [{ ...VALUES.retiredUnused, description: 'No longer used.', retired: true }],
    hypothesis_status: [{ ...VALUES.eliminated, description: 'Ruled out.', retired: true }],
    archival_request_status: [], reliability: [],
    rights_status: [{ ...VALUES.ownWork, description: 'Made by the authors.', retired: false }, { ...VALUES.licensed, description: 'Under a licence.', retired: false }],
    relation: [{ ...VALUES.related, description: 'Related material.', retired: false }],
  },
  terms: FIXED_TERM_KEYS.map((key) => ({ key, name: `Term ${key}`, description: `Description of ${key}.` })),
};

const SECTIONS: Readonly<Record<PolicyPageKey, PolicyPageInput['sections']>> = {
  about: [{ key: 'about_the_group', title: 'About the group', required: true, text: rich('We study synthetic things.') }],
  people: [{ key: 'introduction', title: 'Introduction', required: false, text: rich('  \n ') }],
  methods: [{ key: 'evidence_standards', title: 'Evidence standards', required: true, text: rich('Evidence first.') }],
  licence: [{ key: 'further_notes', title: 'Further notes', required: false, text: rich('Some notes.') }],
  privacy: [
    { key: 'members', title: 'Members', required: true, text: rich('Member data.') },
    { key: 'your_requests', title: 'Your requests', required: true, text: rich('Ask us.') },
  ],
  corrections: [{ key: 'asking_for_a_correction', title: 'Asking for a correction', required: true, text: rich('Write to us.') }],
};

/** A site input that also carries the two Research_Questions, with their creation times for newest-first ordering (R50.4, R50.5). */
export function questionSite(overrides: Partial<SiteInput> = {}): SiteInput {
  const base = site();
  return site({
    views: new Map([...base.views, [QUESTION.key, QUESTION], [QUESTION_SUMMARY.key, QUESTION_SUMMARY]]),
    createdAt: new Map([...base.createdAt, [QUESTION.key, '2026-01-09T00:00:00.000Z'], [QUESTION_SUMMARY.key, '2026-01-04T00:00:00.000Z']]),
    ...overrides,
  });
}

export function site(overrides: Partial<SiteInput> = {}): SiteInput {
  return {
    views: new Map(VIEWS.map((view) => [view.key, view])),
    projectOrder: [WITHHELD_PROJECT.key, PROJECT.key, 'p:private', OTHER.key],
    featured: new Set([WITHHELD_PROJECT.key, PROJECT.key, 'p:private']),
    createdAt: new Map([[FINDING.key, '2026-01-01T00:00:00.000Z'], [HYPOTHESIS.key, '2026-01-02T00:00:00.000Z']]),
    licence: { name: 'Synthetic Licence 1.0', url: 'https://licence.example.test/1.0' },
    publicCopy: PUBLIC_COPY,
    profiles: [
      { displayName: 'Émile Example', specialties: ['Optics'], affiliations: ['Own Lab'], biography: 'First paragraph.\n\nSecond paragraph.' },
      { displayName: 'Ada Example', specialties: [], affiliations: [], biography: 'Short.' },
    ],
    responsiblePerson: 'Rita Responsible',
    methods: METHODS,
    policy: Object.fromEntries(POLICY_PAGE_KEYS.map((key) => [key, { sections: SECTIONS[key], changedOn: '2026-01-01' }])) as Record<PolicyPageKey, PolicyPageInput>,
    retention: retentionRows(),
    ...overrides,
  };
}
