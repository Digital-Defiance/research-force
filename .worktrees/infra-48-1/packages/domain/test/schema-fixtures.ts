import { asTimestamp, asULID } from '../src/types';
import type { ItemKind } from '../src/types';
import { ROLE_IDS } from '../src/permissions';
import { BUILT_IN_VALUE_IDS as builtIn } from '../src/value-sets';
import type { ValidationContext } from '../src/schemas/common';

export const schemaId = (value: number) => asULID(String(value).padStart(26, '0'));
export const schemaText = (text = 'Synthetic text') => ({ text, spans: [] });
export const SCHEMA_IDS = Object.freeze({ member: schemaId(100), revoked: schemaId(101), project: schemaId(200), external: schemaId(300), specialty: schemaId(400), retiredSpecialty: schemaId(401), campaign: schemaId(402), retiredCampaign: schemaId(403), reliability: schemaId(405), retiredReliability: schemaId(406), rights: schemaId(407), retiredRights: schemaId(408), outcome: schemaId(409), retiredOutcome: schemaId(410), planned: schemaId(411) });
const value = (id: ReturnType<typeof schemaId>, name: string, retired = false) => ({ id, name, retired, publicDescription: 'Synthetic explanation' });
export const SCHEMA_CONTEXT: ValidationContext = {
  now: asTimestamp('2026-03-08T04:30:00.000Z'), timeZone: 'America/New_York',
  members: [{ id: SCHEMA_IDS.member, status: 'active', email: 'owner@example.test', displayName: 'Researcher' }, { id: SCHEMA_IDS.revoked, status: 'revoked', email: 'revoked@example.test', displayName: 'Other person' }],
  roleIds: Object.values(ROLE_IDS), projects: [{ id: SCHEMA_IDS.project, name: 'P1030680', slug: 'p1030680' }], externalPartyIds: [SCHEMA_IDS.external],
  valueSets: {
    specialty: [value(SCHEMA_IDS.specialty, 'History'), value(SCHEMA_IDS.retiredSpecialty, 'Retired', true)],
    campaign_status: [value(SCHEMA_IDS.campaign, 'OPEN'), value(SCHEMA_IDS.retiredCampaign, 'Retired', true)],
    finding_status: [value(builtIn.findingOpen, 'Open'), value(builtIn.findingConfirmed, 'Confirmed'), value(builtIn.findingWithdrawn, 'Withdrawn'), value(builtIn.findingSuperseded, 'Superseded')],
    reliability: [value(SCHEMA_IDS.reliability, 'High'), value(SCHEMA_IDS.retiredReliability, 'Retired', true)],
    rights_status: [value(builtIn.rightsUnknown, 'Unknown'), value(SCHEMA_IDS.rights, 'Licensed'), value(SCHEMA_IDS.retiredRights, 'Retired', true)],
    run_outcome: [value(SCHEMA_IDS.outcome, 'Complete'), value(SCHEMA_IDS.retiredOutcome, 'Retired', true)],
    hypothesis_status: [value(builtIn.hypothesisOpen, 'Open'), value(builtIn.hypothesisEliminated, 'Eliminated')],
    archival_request_status: [value(SCHEMA_IDS.planned, 'Planned'), value(builtIn.archivalSent, 'Sent'), value(builtIn.archivalReplied, 'Replied')],
  },
};

export function itemFixture(kind: ItemKind): Record<string, unknown> {
  const common = { kind, projectId: SCHEMA_IDS.project, title: 'Synthetic research', logSummary: schemaText('Summary') };
  switch (kind) {
    case 'journal_entry': return { ...common, sections: [{ content: schemaText() }] };
    case 'finding': return { ...common, claim: schemaText(), scopeCaveat: schemaText() };
    case 'source': return { ...common, sourceKind: 'primary', reliabilityId: SCHEMA_IDS.reliability };
    case 'run': return { ...common, scope: schemaText(), parameters: schemaText(), toolName: 'Tool', toolVersion: '1', computeResource: 'Synthetic rig', startTime: '2026-03-07T12:00:00+05:45', outcomeId: SCHEMA_IDS.outcome };
    case 'hypothesis': return { ...common, statement: schemaText() };
    case 'correspondence': return { ...common, date: { value: '2026-03-07', approx: false }, direction: 'received', parties: [{ kind: 'member', id: SCHEMA_IDS.member }, { kind: 'external', id: SCHEMA_IDS.external }], content: schemaText(), channel: 'Letter' };
    case 'archival_request': return { ...common, archiveOrDesk: { kind: 'external', id: SCHEMA_IDS.external }, requestText: schemaText(), statusValueId: SCHEMA_IDS.planned };
    case 'topic': return { ...common, body: schemaText() };
  }
}
export function outsideFixture(type = 'material'): Record<string, unknown> {
  return { type, destination: { kind: 'general' }, message: 'Synthetic message', name: 'A researcher', email: 'visitor@example.test', licenceAgreement: { agreed: true, contentLicence: 'synthetic-licence-v1' }, files: [] };
}
