import { ACCESS_STATEMENT } from '@researchforce/domain/permissions';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS } from '@researchforce/domain/value-sets';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import type { FormData } from '../src/items/forms/inputs';
import type { ItemView, MemberRow, PartyRecord, ValueRecord, ValueSets } from '../src/types';
import { MEMBER_ID, OTHER_ID } from './helpers';

/** Synthetic records for the web tests. */

let position = 0;
const value = (set: ValueSetKind, id: string, name: string, retired = false): ValueRecord => ({ id, set, name, retired, locked: false, position: position++, publicDescription: null, rev: 1 });

export const RELIABILITY_HIGH = '0000000000000000000000Q001';
export const RUN_COMPLETE = '0000000000000000000000R002';
export const RUN_PARTIAL = '0000000000000000000000R004';
export const RETIRED_RELIABILITY = '0000000000000000000000Q099';

export const VALUE_SETS: ValueSets = {
  finding_status: [
    value('finding_status', BUILT_IN_VALUE_IDS.findingOpen, 'Open'), value('finding_status', BUILT_IN_VALUE_IDS.findingConfirmed, 'Confirmed'),
    value('finding_status', BUILT_IN_VALUE_IDS.findingWithdrawn, 'Withdrawn'), value('finding_status', BUILT_IN_VALUE_IDS.findingSuperseded, 'Superseded'),
  ],
  hypothesis_status: [value('hypothesis_status', LOCKED_VALUE_IDS.hypothesisOpen, 'Open'), value('hypothesis_status', LOCKED_VALUE_IDS.hypothesisEliminated, 'Eliminated')],
  run_outcome: [value('run_outcome', RUN_COMPLETE, 'Complete'), value('run_outcome', RUN_PARTIAL, 'Partial')],
  reliability: [value('reliability', RELIABILITY_HIGH, 'High'), value('reliability', RETIRED_RELIABILITY, 'Doubtful', true)],
  rights_status: [value('rights_status', LOCKED_VALUE_IDS.rightsUnknown, 'Unknown')],
  campaign_status: [value('campaign_status', '0000000000000000000000C001', 'COMPLETE')],
  archival_request_status: [value('archival_request_status', LOCKED_VALUE_IDS.archivalSent, 'Sent')],
  relation: [value('relation', BUILT_IN_VALUE_IDS.relationEvidenceFor, 'Evidence for')],
};

export const PARTY: PartyRecord = { id: '01J000000000000000000000P1', name: 'County Archive', doNotName: false, genericLabel: null, rev: 1 };
export const HIDDEN_PARTY: PartyRecord = { id: '01J000000000000000000000P2', name: 'Private person', doNotName: true, genericLabel: 'A private correspondent', rev: 1 };

const member = (id: string, displayName: string | null, status = 'active'): MemberRow => ({
  id, email: `${id.toLowerCase()}@example.test`, roleId: '00000000000000000000000006', status, createdAt: '2026-10-01T00:00:00.000Z', activatedAt: null, revokedAt: null, displayName,
});
export const MEMBERS: MemberRow[] = [member(MEMBER_ID, 'Ada Example'), member(OTHER_ID, 'Ben Sample'), member('01J00000000000000000000003', 'Cy Gone', 'revoked'), member('01J00000000000000000000004', null, 'pending')];

export const FORM_DATA: FormData = {
  valueSets: VALUE_SETS, parties: [PARTY, HIDDEN_PARTY], members: MEMBERS,
  mentions: { members: [{ id: MEMBER_ID, displayName: 'Ada Example' }], specialties: [{ id: 'S1', name: 'Historian' }] },
};

export const PROJECT = { id: '01J0000000000000000000PR01', name: 'Synthetic project' };
export const rich = (text: string) => ({ text, spans: [] });

export function makeItem(overrides: Partial<ItemView> & Pick<ItemView, 'kind'>): ItemView {
  return {
    id: '01J0000000000000000000IT01', identifier: 'RF-0001', rev: 3, createdAt: '2026-10-20T10:00:00.000Z', project: PROJECT, title: 'A synthetic record',
    owner: { id: MEMBER_ID, displayName: 'Ada Example', specialties: [{ id: 'S1', name: 'Historian' }] },
    credit: [{ member: { id: MEMBER_ID, displayName: 'Ada Example' } }],
    disclosure: { level: 'not_published', effective: 'not_published' },
    withdrawal: null, groupNote: null, reviews: [], pendingReview: false, access: { level: 'whole_team', members: [], statement: ACCESS_STATEMENT },
    ...overrides,
  };
}
