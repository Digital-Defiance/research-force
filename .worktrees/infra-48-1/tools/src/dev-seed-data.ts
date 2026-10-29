import { createHash } from 'node:crypto';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { DEV_MEMBERS, devId } from '@researchforce/testing/dev-members';
export { DEV_MEMBERS, devId } from '@researchforce/testing/dev-members';
import { BUILT_IN_VALUE_IDS as V } from '@researchforce/domain/value-sets';

export const DEV_AT = '2026-01-01T12:00:00.000Z';
type Row = Record<string, string | number | null>;
const literal = (value: string | number | null): string => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
/** Conflict handling is restricted to the declared identity, never a blanket INSERT OR IGNORE. */
const insert = (table: string, row: Row, key: string): string => `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(literal).join(', ')}) ON CONFLICT (${key}) DO NOTHING;`;

/** Synthetic fixtures only. All current kinds are explicit so a new enum member requires seed design. */
export function buildDevSeed() {
  const core: string[] = [];
  const search: string[] = [];
  const owner = DEV_MEMBERS[1].id;
  const project = devId(10);
  for (const member of DEV_MEMBERS) {
    core.push(insert('members', { id: member.id, email: member.email, email_lc: member.email, role_id: member.role, status: member.status,
      created_at: DEV_AT, activated_at: member.status === 'pending' ? null : DEV_AT, revoked_at: member.status === 'revoked' ? DEV_AT : null, updated_seq: 0 }, 'id'));
    core.push(insert('profiles', { member_id: member.id, display_name: member.name, display_name_key: member.name.toLowerCase(), bio: 'Synthetic local development profile.', time_zone: 'America/Los_Angeles', updated_seq: 0 }, 'member_id'));
    core.push(`INSERT INTO profile_specialties (member_id, value_id) SELECT ${literal(member.id)}, '0000000000000000000000S003' WHERE NOT EXISTS (SELECT 1 FROM profile_specialties WHERE member_id = ${literal(member.id)});`);
  }
  for (const [i, name] of ['Synthetic cipher research', 'Synthetic archive research'].entries()) core.push(insert('projects', {
    id: devId(10 + i), name, name_key: name.toLowerCase(), short_description: 'Synthetic development examples only.', slug: `synthetic-${i + 1}`,
    position: 1000 + i, disclosure_level: 'not_published', created_by: DEV_MEMBERS[0].id, created_at: DEV_AT, updated_seq: 0,
  }, 'id'));
  const details: Record<ItemKind, { table: string; fields: Row; status: string | null }> = {
    journal_entry: { table: 'journal_entries', fields: { heading_text: 'Synthetic journal', phase_id: 'DEV-PHASE' }, status: '0000000000000000000000C005' },
    finding: { table: 'findings', fields: { claim: 'A synthetic pattern appears in the sample.', scope_caveat: 'Synthetic data only.' }, status: V.findingOpen },
    source: { table: 'sources', fields: { source_kind: 'primary', reliability_id: '0000000000000000000000Q001', rights_status_id: V.rightsUnknown, archival_reference: 'SYNTHETIC/BOX/1' }, status: null },
    run: { table: 'runs', fields: { scope: 'Synthetic keys 0 through 99.', parameters: 'seed=42', tool_name: 'synthetic-search', tool_version: '1.0', compute_resource: 'Local fixture', start_time: DEV_AT, start_key: DEV_AT, outcome_id: '0000000000000000000000R004', resume_point: 'Continue at key 50.' }, status: '0000000000000000000000R004' },
    hypothesis: { table: 'hypotheses', fields: { statement: 'The synthetic key is in the first half.' }, status: V.hypothesisOpen },
    correspondence: { table: 'correspondences', fields: { date: '2026-01-01', direction: 'received', content: 'Synthetic correspondence. No real contact details.' }, status: null },
    archival_request: { table: 'archival_requests', fields: { archive_kind: 'member', archive_id: DEV_MEMBERS[0].id, request_text: 'Locate synthetic box 1.', date_sent: '2026-01-01' }, status: V.archivalSent },
    topic: { table: 'topics', fields: { body: 'A restricted synthetic discussion.' }, status: null },
  };
  const unit = (id: string, root: string, type: string, submission: string, parent: string | null) => insert('units', {
    id, root_id: root, project_id: project, unit_type: type, parent_id: parent, owner_id: owner, credit: JSON.stringify([{ member: owner }]),
    submission_id: submission, created_at: DEV_AT, disclosure_level: 'not_published', classification_state: type === 'reply' ? null : 'unclassified', updated_seq: 0,
  }, 'id');
  for (const [i, kind] of ITEM_KINDS.entries()) {
    const id = devId(100 + i); const submission = devId(200 + i); const identifier = `DEV0-0000-${String(i).padStart(4, '0')}`;
    core.push(insert('submissions', { id: submission, member_id: owner, kind: 'member', started_at: DEV_AT, completed_at: DEV_AT, counts: JSON.stringify({ [kind]: 1 }) }, 'id'));
    core.push(unit(id, id, 'research_item', submission, null));
    core.push(insert('research_items', { unit_id: id, kind, item_identifier: identifier, project_id: project, title: `Synthetic ${kind.replaceAll('_', ' ')}`,
      status_value_id: details[kind].status, item_date_key: '2026-01-01', log_date_key: '2026-01-01', log_summary: `Synthetic summary for ${kind}.`,
      access_level: kind === 'topic' || kind === 'correspondence' ? 'restricted' : 'whole_team' }, 'unit_id'));
    core.push(insert(details[kind].table, { unit_id: id, ...details[kind].fields }, 'unit_id'));
    core.push(insert('identifiers', { identifier_lc: identifier.toLowerCase(), identifier, unit_id: id, issued_at: DEV_AT }, 'identifier_lc'));
    search.push(insert('search_docs', { doc_key: 10000 + i, unit_id: id, result_unit_id: id, root_id: id, root_kind: kind, project_id: project,
      unit_type: 'research_item', disclosure_level: 'not_published', created_at: DEV_AT, completed: 1, title: `Synthetic ${kind}`, body: 'Synthetic evidence α é ß. Searchable fixture.' }, 'doc_key'));
  }
  const journal = devId(100); const submission = devId(200); const attachment = devId(500);
  core.push(unit(devId(400), journal, 'entry_section', submission, journal));
  core.push(insert('entry_sections', { unit_id: devId(400), text: 'Synthetic paragraph with Unicode: α, é, ß.\n'.repeat(500) }, 'unit_id'));
  core.push(unit(devId(401), journal, 'reply', submission, journal));
  core.push(insert('replies', { unit_id: devId(401), text: 'A synthetic follow-up discussion.' }, 'unit_id'));
  const csv = 'key,result\n0,negative\n1,candidate\n';
  const sha256 = createHash('sha256').update(csv).digest('hex');
  core.push(unit(attachment, journal, 'attachment', submission, journal));
  core.push(insert('attachments', { unit_id: attachment, item_identifier: 'DEV0-F11E-0001', title: 'Synthetic results', file_kind: 'csv', original_name: 'synthetic-results.csv', size_bytes: Buffer.byteLength(csv), sha256,
    r2_key: 'dev-seed/v1/results.csv', origin: 'Synthetic generator, seed 42.', uploaded_at: DEV_AT, rights_status_id: V.rightsUnknown, chain_id: attachment }, 'unit_id'));
  core.push(insert('identifiers', { identifier_lc: 'dev0-f11e-0001', identifier: 'DEV0-F11E-0001', unit_id: attachment, issued_at: DEV_AT }, 'identifier_lc'));
  core.push(insert('access_grants', { root_id: devId(107), member_id: DEV_MEMBERS[2].id, granted_by: owner, granted_at: DEV_AT }, 'root_id, member_id'));
  return { core: core.join('\n'), search: search.join('\n'), public: '-- No public research views are seeded.\nSELECT 1;',
    objects: [{ bucket: 'rf-private-dev', key: 'dev-seed/v1/results.csv', content: csv, type: 'text/csv' },
      { bucket: 'rf-public-dev', key: 'dev-seed/v1/synthetic.txt', content: 'Synthetic local bucket fixture.\n', type: 'text/plain' }] };
}
