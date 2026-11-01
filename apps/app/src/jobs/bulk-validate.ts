import { KIND_REQUIRED_COLUMNS, parseManifestCsv, parseManifestXlsx } from '@researchforce/manifest/parse';
import type { ManifestColumn, ManifestContext, ManifestError, ManifestRow } from '@researchforce/manifest/parse';
import { researchItemSchema } from '@researchforce/domain/schemas/items';
import type { ResearchItemInput } from '@researchforce/domain/schemas/items';
import { validate } from '@researchforce/domain/schemas/common';
import type { ValidationContext } from '@researchforce/domain/schemas/common';
import { SETTINGS } from '@researchforce/domain/settings';
import { cpLength, isBlank } from '@researchforce/domain/text';
import { ACCESS_LEVELS } from '@researchforce/domain/types';
import type { AccessLevel, ItemKind, MemberStatus, Timestamp, ULID } from '@researchforce/domain/types';
import type { ConfigValue, ValueSetKind } from '@researchforce/domain/value-sets';
import type { RichText } from '@researchforce/domain/richtext';

/**
 * Bulk_Import validation (R37.2, R37.3, R37.8, R37.16, R33.9, R33.10, R47.13, R50.8).
 *
 * This is the SERVER-SIDE semantic validator. The browser runs the pure
 * Manifest_Parser and the parser's row rules first (task 37.7); the server
 * re-runs the parser here and ADDS the checks that need server catalog data:
 * Party and contact name matching, file existence and size, Version_Chain
 * branch and cycle detection, kind-specific column fill and emptiness, the
 * per-kind field schema, Origin length, and the Access_Level and
 * Access_List columns. It creates NO Items; the Bulk_Import job (task 37.6)
 * consumes the {@link ValidatedRow} set this returns and creates the records.
 *
 * The core {@link validateBulkImport} is PURE: it takes the manifest bytes and
 * the server catalog as arguments and reads no database or bucket. A thin async
 * loader that reads the catalog and folder listing from D1 and R2 and calls it
 * belongs in the job and the pre-flight route.
 *
 * Every failure is a located {@link BulkError} with the spreadsheet row, the
 * column, the file name where a file is concerned, and a human-facing reason.
 * ANY error on a row means that row creates no Item; the report collects ALL
 * errors and never stops at the first. Folder files that no row names are not
 * errors: they are listed in {@link BulkValidation.notImported}.
 */

/** One located Bulk_Import validation error (R37.3). `column` is a column name, a 1-based position, or null. */
export interface BulkError {
  /** The spreadsheet row number (header is row 1), or null for errors not tied to a row. */
  readonly row: number | null;
  /** The column name, its 1-based position for an unnamed column, or null. */
  readonly column: ManifestColumn | number | null;
  /** The file name when the error concerns a named file (R37.3). */
  readonly fileName?: string;
  /** A human-facing reason. */
  readonly reason: string;
}

/** A Party reference a row's name resolved to, or an unmatched name the job creates as a new External_Party (R37.12). */
export type PartyRef =
  | { readonly kind: 'member'; readonly id: ULID }
  | { readonly kind: 'external'; readonly id: ULID }
  | { readonly kind: 'new_external'; readonly name: string };

/** The access the row carries: either its own filled `access_level`/`access_members`, or the import default (R47.13). */
export interface ResolvedAccess {
  readonly level: AccessLevel;
  /** Member ids on the Access_List, resolved from `access_members`; empty for a Whole_Team row or one that sets no members. */
  readonly memberIds: readonly ULID[];
  /** Whether the row set its own access columns, so the job uses these rather than the import default. */
  readonly fromRow: boolean;
}

/**
 * One validated row the Bulk_Import job (task 37.6) creates without re-validating.
 * Carries the row number, Row_Key, kind, the schema-valid mapped values, the
 * resolved file list in manifest order, the Version_Chains, the resolved Party
 * references per party-like column, and the resolved access.
 */
export interface ValidatedRow {
  readonly row: number;
  readonly rowKey: string;
  readonly kind: ItemKind;
  /** The kind-schema output the job writes to the Research_Item (R37.12, R37.15). */
  readonly values: ResearchItemInput;
  /** The row's files in manifest order, each resolved to the folder file's size. */
  readonly files: readonly { readonly fileName: string; readonly sizeBytes: number }[];
  /** Each Version_Chain as the ordered file names the version marks declare (R37.7). */
  readonly versionChains: readonly (readonly string[])[];
  /** The resolved Party references, keyed by the manifest column the name came from. */
  readonly parties: Readonly<Partial<Record<ManifestColumn, readonly PartyRef[]>>>;
  /** The Origin text for the row's Attachments, present only when the row names files (R33.9). */
  readonly origin?: string;
  readonly access: ResolvedAccess;
}

/** The validation result: every error, the folder files no row names, and the mapped valid rows (R37.3, R37.4). */
export interface BulkValidation {
  readonly errors: readonly BulkError[];
  /** Folder files that no Manifest_Row names, listed as not imported without being errors (R37.4). */
  readonly notImported: readonly string[];
  /** The mapped values for every row with no error, for the job to create (R37.12). */
  readonly rows: readonly ValidatedRow[];
}

/** One Member of the catalog, with the display name Party and access-member names match against (R37.8, R47.13). */
export interface CatalogMember {
  readonly id: ULID;
  readonly displayName: string;
  readonly status: MemberStatus;
}
/** One External_Party of the catalog; a Party name matches its name or its Generic_Label (R34.5, R37.8). */
export interface CatalogExternalParty {
  readonly id: ULID;
  readonly name: string;
  readonly genericLabel?: string;
}
/** One file in the uploaded folder listing, with its byte size (R37.16). */
export interface FolderFile {
  readonly fileName: string;
  readonly sizeBytes: number;
}
/** The server catalog the pure validator reads; no database or bucket (R33.10). */
export interface BulkCatalog {
  readonly now: Timestamp;
  readonly timeZone?: string;
  readonly projectId: ULID;
  /** The chosen import Access_Level for rows that set no access columns (Restricted preselected on the screen, R47.13). */
  readonly importAccessLevel: AccessLevel;
  /** The current (non-retired) Rights_Status value names, for the parser's re-run (R38.6). */
  readonly currentRightsStatuses: ReadonlySet<string>;
  readonly members: readonly CatalogMember[];
  readonly externalParties: readonly CatalogExternalParty[];
  /** The configurable value sets, for mapping Rights_Status, reliability, and status names to ids (R37.12). */
  readonly valueSets: Readonly<Partial<Record<ValueSetKind, readonly ConfigValue[]>>>;
  /** The uploaded folder's files with their sizes (R37.16). */
  readonly folder: readonly FolderFile[];
  /** The Attachment_Size_Limit in bytes; defaults to the configured setting (R37.16). */
  readonly attachmentSizeLimit?: number;
}

/** The manifest bytes and their format (R38.1). */
export type ManifestInput =
  | { readonly format: 'csv'; readonly bytes: Uint8Array }
  | { readonly format: 'xlsx'; readonly bytes: Uint8Array };

const asError = (
  row: number | null,
  column: ManifestColumn | number | null,
  reason: string,
  fileName?: string,
): BulkError => (fileName === undefined ? { row, column, reason } : { row, column, reason, fileName });

/** The parser's own located errors, as Bulk_Import errors (R37.3). */
const fromManifestError = (error: ManifestError): BulkError => ({ row: error.row, column: error.column, reason: error.reason });

/** A plain string cell as a RichText value for a schema field; the schema checks its length (R37.16). */
const rich = (text: string): RichText => ({ text, spans: [] });

/** A manifest value, trimmed of nothing: the parser keeps cells exactly. An absent or whitespace-only cell is "empty". */
const filled = (value: string | undefined): value is string => value !== undefined && !isBlank(value);

// --- Name matching (R37.8, R47.13) ----------------------------------------------

/**
 * Match a human name against the catalog, comparing ignoring letter case and
 * surrounding whitespace, the same convention value-set names use. A Party name
 * matches a Member display name, an External_Party name, or an External_Party
 * Generic_Label; access-member names match Member display names only.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

interface NameMatch {
  readonly members: readonly ULID[];
  readonly externals: readonly ULID[];
}
function matchParty(name: string, catalog: BulkCatalog): NameMatch {
  const key = normalizeName(name);
  const members = catalog.members.filter((member) => normalizeName(member.displayName) === key).map((member) => member.id);
  const externals = catalog.externalParties
    .filter((party) => normalizeName(party.name) === key || (party.genericLabel !== undefined && normalizeName(party.genericLabel) === key))
    .map((party) => party.id);
  return { members, externals };
}

/** The Members an access-member name matches, restricted to Pending or Active (R47.13). */
function matchAccessMember(name: string, catalog: BulkCatalog): readonly ULID[] {
  const key = normalizeName(name);
  return catalog.members
    .filter((member) => (member.status === 'pending' || member.status === 'active') && normalizeName(member.displayName) === key)
    .map((member) => member.id);
}

/** Split a multi-name cell on the manifest's list separator; empty entries are dropped. */
function splitNames(value: string | undefined): readonly string[] {
  if (!filled(value)) return [];
  return value.split(/[;\n]/u).map((entry) => entry.trim()).filter((entry) => entry !== '');
}

// --- Version marks (R37.7, R37.8) -----------------------------------------------

/** One version chain's ordered file names, parsed from a line like `a.pdf > a-v2.pdf > a-v3.pdf`. */
function parseVersionChains(value: string | undefined): readonly (readonly string[])[] {
  if (!filled(value)) return [];
  return value
    .split(/\r\n|\n|\r/u)
    .map((line) => line.split('>').map((name) => name.trim()).filter((name) => name !== ''))
    .filter((chain) => chain.length > 0);
}

/**
 * Check the row's version marks: every chain is linear (no branch, no cycle) and
 * names only the row's own files (R37.7, R37.8). A file appearing twice in one
 * chain, or in two chains, branches or cycles the supersession order. Returns
 * the located errors; an empty array means the chains are valid.
 */
function checkVersions(row: ManifestRow, chains: readonly (readonly string[])[], rowFiles: ReadonlySet<string>): BulkError[] {
  const errors: BulkError[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    const local = new Set<string>();
    for (const name of chain) {
      if (!rowFiles.has(name)) {
        errors.push(asError(row.row, 'versions', `The version mark names “${name}”, which the row’s files do not include.`, name));
        continue;
      }
      if (local.has(name)) {
        errors.push(asError(row.row, 'versions', `The version mark lists “${name}” more than once, forming a cycle.`, name));
        continue;
      }
      local.add(name);
      if (seen.has(name)) {
        errors.push(asError(row.row, 'versions', `The file “${name}” appears in more than one version chain, forming a branch.`, name));
        continue;
      }
      seen.add(name);
    }
  }
  return errors;
}

// --- Kind-specific column fill and emptiness (R37.15, R38.9) ---------------------

/** Every kind-specific column, the union across kinds; used to check out-of-place fills. */
const ALL_KIND_COLUMNS: ReadonlySet<ManifestColumn> = new Set<ManifestColumn>(
  (Object.values(KIND_REQUIRED_COLUMNS) as readonly (readonly ManifestColumn[])[]).flat(),
);
/** Kinds whose `date` column must be empty (R37.15). */
const DATELESS_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['finding', 'hypothesis', 'topic']);

/**
 * Check that the row fills every kind-specific column its kind requires and
 * leaves empty each kind-specific column of the other kinds, and that the date
 * column is empty for Findings, Hypotheses, and Topics (R37.15, R38.9).
 */
function checkKindColumns(row: ManifestRow, kind: ItemKind): BulkError[] {
  const errors: BulkError[] = [];
  const required = new Set<ManifestColumn>(KIND_REQUIRED_COLUMNS[kind]);
  for (const column of required) {
    if (!filled(row.values[column])) errors.push(asError(row.row, column, `The column “${column}” is required for the kind “${kind}”.`));
  }
  for (const column of ALL_KIND_COLUMNS) {
    if (!required.has(column) && filled(row.values[column])) {
      errors.push(asError(row.row, column, `The column “${column}” does not belong to the kind “${kind}” and must be empty.`));
    }
  }
  if (DATELESS_KINDS.has(kind) && filled(row.values.date)) {
    errors.push(asError(row.row, 'date', `A ${kind} row leaves the date column empty.`));
  }
  return errors;
}

// --- Per-kind schema mapping (R37.3, R37.16) ------------------------------------

/** Resolve a value-set name to its id, matching the parser's current-value convention (R37.12). */
function valueId(catalog: BulkCatalog, set: ValueSetKind, name: string | undefined): ULID | undefined {
  if (!filled(name)) return undefined;
  const key = normalizeName(name);
  return (catalog.valueSets[set] ?? []).find((value) => normalizeName(value.name) === key)?.id;
}

/** The Party references a party-like column resolved to, or the ambiguity errors (>1 match, R37.8). */
function resolvePartyColumn(row: ManifestRow, column: ManifestColumn, catalog: BulkCatalog): { refs: PartyRef[]; errors: BulkError[] } {
  const refs: PartyRef[] = [];
  const errors: BulkError[] = [];
  for (const name of splitNames(row.values[column])) {
    const match = matchParty(name, catalog);
    const total = match.members.length + match.externals.length;
    if (total > 1) {
      errors.push(asError(row.row, column, `The name “${name}” matches more than one Member or External Party.`));
      continue;
    }
    if (match.members.length === 1) refs.push({ kind: 'member', id: match.members[0]! });
    else if (match.externals.length === 1) refs.push({ kind: 'external', id: match.externals[0]! });
    else refs.push({ kind: 'new_external', name });
  }
  return { refs, errors };
}

/** A resolved Party reference as a schema party value; a yet-to-be-created External_Party has no id to validate against here. */
const partyValue = (ref: PartyRef): { kind: 'member' | 'external'; id: ULID } | undefined =>
  ref.kind === 'new_external' ? undefined : { kind: ref.kind, id: ref.id };

/**
 * Map one row's cells to its kind's schema input shape, carrying the resolved
 * Party ids where the schema needs them. Unmatched Party names are left out of
 * the schema input (the job creates them as External_Parties, R37.12); the
 * schema input uses only matched Member and External_Party ids.
 */
function mapSchemaInput(
  row: ManifestRow,
  kind: ItemKind,
  catalog: BulkCatalog,
  parties: Readonly<Partial<Record<ManifestColumn, readonly PartyRef[]>>>,
): Record<string, unknown> {
  const v = row.values;
  const base: Record<string, unknown> = { kind, projectId: catalog.projectId, title: v.title ?? '' };
  if (filled(v.log_summary)) base['logSummary'] = rich(v.log_summary);
  const date = filled(v.date) ? { value: v.date, approx: false } : undefined;
  const matched = (column: ManifestColumn): { kind: 'member' | 'external'; id: ULID }[] =>
    (parties[column] ?? []).flatMap((ref) => { const value = partyValue(ref); return value ? [value] : []; });
  switch (kind) {
    case 'finding':
      return { ...base, claim: rich(v.claim ?? ''), scopeCaveat: rich(v.scope_caveat ?? '') };
    case 'hypothesis':
      return { ...base, statement: rich(v.statement ?? '') };
    case 'topic':
      return { ...base, body: rich(v.body ?? '') };
    case 'source':
      return {
        ...base, sourceKind: v.source_kind ?? '',
        reliabilityId: valueId(catalog, 'reliability', v.reliability),
        rightsStatusId: valueId(catalog, 'rights_status', v.rights_status),
        ...(filled(v.rights_holder) ? { rightsHolder: v.rights_holder } : {}),
        ...(filled(v.rights_terms) ? { rightsTerms: v.rights_terms } : {}),
        ...(date ? { documentDate: date } : {}),
        ...(filled(v.archive) ? { archiveOrCollection: v.archive } : {}),
        ...(filled(v.archival_reference) ? { archivalReference: v.archival_reference } : {}),
        ...(filled(v.reliability_note) ? { reliabilityNote: rich(v.reliability_note) } : {}),
        ...(matched('recovered_by')[0] ? { recoverer: matched('recovered_by')[0] } : {}),
      };
    case 'run':
      return {
        ...base, scope: rich(v.scope ?? ''), parameters: rich(v.parameters ?? ''), toolName: v.tool_name ?? '', toolVersion: v.tool_version ?? '',
        computeResource: v.compute_resource ?? '', outcomeId: valueId(catalog, 'run_outcome', v.run_outcome),
        startTime: v.date ?? '',
        ...(filled(v.end_time) ? { endTime: v.end_time } : {}),
        ...(filled(v.resume_point) ? { resumePoint: v.resume_point } : {}),
        ...(filled(v.notes) ? { notes: rich(v.notes) } : {}),
      };
    case 'correspondence':
      return {
        ...base, direction: v.direction ?? '', ...(date ? { date } : {}),
        ...(v.channel !== undefined ? { channel: v.channel } : {}),
        ...(v.content !== undefined ? { content: rich(v.content) } : {}),
        parties: matched('parties'),
      };
    case 'archival_request':
      return {
        ...base, requestText: rich(v.request_text ?? ''), statusValueId: valueId(catalog, 'archival_request_status', v.archival_request_status),
        archiveOrDesk: matched('archive_or_desk')[0],
        ...(matched('contact')[0] ? { contact: matched('contact')[0] } : {}),
        ...(v.channel !== undefined ? { channel: v.channel } : {}),
        ...(date ? { dateSent: date } : {}),
        ...(filled(v.reply_date) ? { replyDate: { value: v.reply_date, approx: false } } : {}),
        ...(filled(v.reply_content) ? { replyContent: rich(v.reply_content) } : {}),
      };
    default:
      // research_question, decision_record, work_item, journal_entry are not Bulk_Import kinds (R37.1, R50.8); handled before mapping.
      return base;
  }
}

/** The manifest column each top-level schema field maps from, so a schema issue names the column it came from. */
const FIELD_COLUMN: Readonly<Record<string, ManifestColumn>> = {
  title: 'title', claim: 'claim', scopeCaveat: 'scope_caveat', statement: 'statement', body: 'body', logSummary: 'log_summary',
  sourceKind: 'source_kind', reliabilityId: 'reliability', reliabilityNote: 'reliability_note', rightsStatusId: 'rights_status',
  rightsHolder: 'rights_holder', rightsTerms: 'rights_terms', documentDate: 'date', archiveOrCollection: 'archive', archivalReference: 'archival_reference',
  recoverer: 'recovered_by', scope: 'scope', parameters: 'parameters', toolName: 'tool_name', toolVersion: 'tool_version', computeResource: 'compute_resource',
  outcomeId: 'run_outcome', startTime: 'date', endTime: 'end_time', resumePoint: 'resume_point', notes: 'notes', direction: 'direction', channel: 'channel',
  content: 'content', parties: 'parties', requestText: 'request_text', statusValueId: 'archival_request_status', archiveOrDesk: 'archive_or_desk', contact: 'contact',
  dateSent: 'date', replyDate: 'reply_date', replyContent: 'reply_content', date: 'date',
};

/** The manifest column a schema issue path maps to, from its first path segment. */
function columnForField(field: string): ManifestColumn | null {
  const first = field.split('.')[0] ?? '';
  return FIELD_COLUMN[first] ?? null;
}

// --- Row validation --------------------------------------------------------------

/** The kinds a Bulk_Import manifest v1 accepts: every Research_Item kind the parser allows, except the interactive-only kinds (R37.1, R50.8). */
const UNSUPPORTED_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(['work_item', 'decision_record', 'journal_entry', 'research_question']);

/** Resolve the row's access from its own columns or the import default (R47.13). */
function resolveAccess(row: ManifestRow, catalog: BulkCatalog): { access: ResolvedAccess; errors: BulkError[] } {
  const errors: BulkError[] = [];
  const level = row.values.access_level;
  const memberNames = splitNames(row.values.access_members);
  const hasLevel = filled(level);
  const hasMembers = memberNames.length > 0;
  if (!hasLevel && !hasMembers) {
    return { access: { level: catalog.importAccessLevel, memberIds: [], fromRow: false }, errors };
  }
  let resolvedLevel: AccessLevel = catalog.importAccessLevel;
  if (hasLevel) {
    if ((ACCESS_LEVELS as readonly string[]).includes(level)) resolvedLevel = level as AccessLevel;
    else errors.push(asError(row.row, 'access_level', `“${level}” is not a valid access level; use “whole_team” or “restricted”.`));
  }
  const memberIds: ULID[] = [];
  if (hasMembers) {
    if (hasLevel && resolvedLevel !== 'restricted') {
      errors.push(asError(row.row, 'access_members', 'Access members apply only when the access level is “restricted”.'));
    }
    for (const name of memberNames) {
      const matches = matchAccessMember(name, catalog);
      if (matches.length === 1) memberIds.push(matches[0]!);
      else if (matches.length === 0) errors.push(asError(row.row, 'access_members', `The access member “${name}” matches no Pending or Active Member.`));
      else errors.push(asError(row.row, 'access_members', `The access member “${name}” matches more than one Member.`));
    }
  }
  return { access: { level: resolvedLevel, memberIds, fromRow: true }, errors };
}

/** The party-like columns to resolve per kind (R37.8). */
const PARTY_COLUMNS: Readonly<Record<ItemKind, readonly ManifestColumn[]>> = Object.freeze({
  journal_entry: [],
  finding: ['parties', 'credit'],
  source: ['parties', 'recovered_by', 'credit'],
  run: ['parties', 'credit'],
  hypothesis: ['parties', 'credit'],
  correspondence: ['parties', 'credit'],
  archival_request: ['parties', 'archive_or_desk', 'contact', 'credit'],
  topic: ['parties', 'credit'],
  research_question: [],
  decision_record: [],
  work_item: [],
});

/** Validate one parsed row, collecting every error and, when it has none, the mapped {@link ValidatedRow}. */
function validateRow(
  row: ManifestRow,
  catalog: BulkCatalog,
  sizeLimit: number,
  fileOwners: ReadonlyMap<string, readonly number[]>,
  folderSizes: ReadonlyMap<string, number>,
): { errors: BulkError[]; validated?: ValidatedRow } {
  const errors: BulkError[] = [];
  const rowKey = row.values.row_key ?? '';
  const kind = row.values.kind as ItemKind;

  // The parser already rejects an invalid kind and a missing Row_Key; an unsupported kind fails preflight here (R37.1, R50.8).
  if (UNSUPPORTED_KINDS.has(kind)) {
    errors.push(asError(row.row, 'kind', `The kind “${kind}” cannot be created by a Bulk_Import.`));
    return { errors };
  }

  // Kind-specific column fill and emptiness, and the dateless-kind date rule (R37.15, R38.9).
  errors.push(...checkKindColumns(row, kind));

  // Files: existence, single-owner, and size (R37.16).
  const fileNames = splitNames(row.values.files);
  const files: { fileName: string; sizeBytes: number }[] = [];
  for (const name of fileNames) {
    const size = folderSizes.get(name);
    if (size === undefined) {
      errors.push(asError(row.row, 'files', `The file “${name}” is not in the uploaded folder.`, name));
      continue;
    }
    const owners = fileOwners.get(name) ?? [];
    if (owners.length > 1) errors.push(asError(row.row, 'files', `The file “${name}” is named by more than one row.`, name));
    if (size > sizeLimit) errors.push(asError(row.row, 'files', `The file “${name}” is larger than the Attachment Size Limit of ${sizeLimit} bytes.`, name));
    files.push({ fileName: name, sizeBytes: size });
  }
  const rowFileSet = new Set(fileNames);

  // Version marks: linear chains naming only the row's own files (R37.7, R37.8).
  const versionChains = parseVersionChains(row.values.versions);
  errors.push(...checkVersions(row, versionChains, rowFileSet));

  // Party-like name matching: ambiguous (>1) is the error; an unmatched name is created later (R37.8, R37.12).
  const parties: Partial<Record<ManifestColumn, readonly PartyRef[]>> = {};
  for (const column of PARTY_COLUMNS[kind]) {
    const { refs, errors: partyErrors } = resolvePartyColumn(row, column, catalog);
    errors.push(...partyErrors);
    if (refs.length > 0) parties[column] = refs;
  }

  // Access columns (R47.13); a research_question row is already rejected as unsupported above (R50.8).
  const { access, errors: accessErrors } = resolveAccess(row, catalog);
  errors.push(...accessErrors);

  // Per-kind schema: map the cells and validate with the import mode; the Log_Summary is length-only (R37.3, R37.16).
  const context = buildContext(catalog);
  const input = mapSchemaInput(row, kind, catalog, parties);
  const schema = researchItemSchema(kind, context, { mode: 'import' });
  const result = validate(schema, input);
  let values: ResearchItemInput | undefined;
  if (!result.ok) {
    for (const issue of result.issues) errors.push(asError(row.row, columnForField(issue.field), issue.message));
  } else {
    values = result.value;
  }

  // Origin: a row with files needs an Origin of 1 to 5,000 characters (R33.9, R33.10).
  const origin = row.values.origin;
  if (fileNames.length > 0) {
    if (!filled(origin) || cpLength(origin) < 1 || cpLength(origin) > 5000) {
      errors.push(asError(row.row, 'origin', 'A row that names files needs an Origin of 1 to 5,000 Unicode code points.'));
    }
  }

  if (errors.length > 0 || values === undefined) return { errors };
  const validated: ValidatedRow = {
    row: row.row, rowKey, kind, values, files, versionChains, parties, access,
    ...(filled(origin) ? { origin } : {}),
  };
  return { errors, validated };
}

/** Build the schema's {@link ValidationContext} from the catalog. The project is the chosen import Project (R37.17). */
function buildContext(catalog: BulkCatalog): ValidationContext {
  return {
    now: catalog.now,
    ...(catalog.timeZone !== undefined ? { timeZone: catalog.timeZone } : {}),
    valueSets: catalog.valueSets,
    members: catalog.members.map((member) => ({ id: member.id, status: member.status, displayName: member.displayName })),
    roleIds: [],
    projects: [{ id: catalog.projectId, name: '', slug: '' }],
    externalPartyIds: catalog.externalParties.map((party) => party.id),
    previousSelections: {},
  };
}

/**
 * Validate a Bulk_Import manifest and folder against the server catalog, PURELY
 * (R37.2, R37.3, R37.16, R33.10). Re-runs the Manifest_Parser; if it returns no
 * rows, the result is exactly the parser's errors. Otherwise it adds the
 * server-only checks row by row, collecting every error, and returns the mapped
 * {@link ValidatedRow} set for the rows with no error. Folder files that no row
 * names are listed in {@link BulkValidation.notImported}, never as errors (R37.4).
 */
export function validateBulkImport(manifest: ManifestInput, catalog: BulkCatalog): BulkValidation {
  const sizeLimit = catalog.attachmentSizeLimit ?? SETTINGS.attachmentSizeLimit.default;
  // Guard: the size limit informs both the folder check and the readiness schema; a bad limit is a programming error.
  if (!Number.isSafeInteger(sizeLimit) || sizeLimit < 0) throw new RangeError('The Attachment Size Limit must be a non-negative safe integer.');

  const ctx: ManifestContext = { currentRightsStatuses: catalog.currentRightsStatuses };
  const parsed = manifest.format === 'csv' ? parseManifestCsv(manifest.bytes, ctx) : parseManifestXlsx(manifest.bytes, ctx);
  if (!parsed.ok) {
    // The parser returned no rows: the report is exactly the parser errors, with no not-imported list (R37.3).
    return { errors: parsed.errors.map(fromManifestError), notImported: [], rows: [] };
  }

  const folderSizes = new Map(catalog.folder.map((file) => [file.fileName, file.sizeBytes]));
  // Which rows name each file, across the whole manifest, so a file two rows name is an error on both (R37.16).
  const fileOwners = new Map<string, number[]>();
  for (const row of parsed.rows) {
    for (const name of splitNames(row.values.files)) {
      const owners = fileOwners.get(name) ?? [];
      owners.push(row.row);
      fileOwners.set(name, owners);
    }
  }

  const errors: BulkError[] = [];
  const rows: ValidatedRow[] = [];
  for (const row of parsed.rows) {
    const result = validateRow(row, catalog, sizeLimit, fileOwners, folderSizes);
    errors.push(...result.errors);
    if (result.validated) rows.push(result.validated);
  }

  // Folder files that no row names are not imported, never errors (R37.4).
  const named = new Set(fileOwners.keys());
  const notImported = catalog.folder.map((file) => file.fileName).filter((name) => !named.has(name));

  return { errors, notImported, rows };
}
