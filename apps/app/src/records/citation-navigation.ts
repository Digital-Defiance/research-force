import type { Context } from 'hono';
import { z } from 'zod';
import type { Bibliography } from '@researchforce/domain/bibliography';
import { cslItem, exportDocument } from '@researchforce/domain/citation-export';
import type { CslItem } from '@researchforce/domain/citation-export';
import { idSchema } from '@researchforce/domain/schemas/common';
import type { DocumentDate, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { textsOf } from '../discussion/mentions';
import { loadItem } from './items';
import { readableCitations } from './citations';
import type { CitationView } from './citations';
import { rowsOf } from './kinds/kind';

/** One page of a listing: enough to show a screen and never the whole Project in one request. */
export const CITATION_PAGE = 100;

const flag = z.enum(['1', 'true']).optional().transform((value) => value !== undefined);
const listQuerySchema = z.strictObject({
  citingRootId: idSchema.optional(), targetUnitId: idSchema.optional(), targetRootId: idSchema.optional(), projectId: idSchema.optional(),
  unresolved: flag, includeRetired: flag, after: idSchema.optional(), limit: z.coerce.number().int().min(1).max(CITATION_PAGE).optional(),
}).refine((query) => query.citingRootId !== undefined || query.targetUnitId !== undefined || query.targetRootId !== undefined || query.projectId !== undefined, {
  message: 'Name a record, a cited target or a Project.', path: ['citingRootId'],
});

/** The record that holds one end of a citation, as the Member sees it. */
export interface RecordRef { readonly rootId: ULID; readonly identifier: string; readonly title: string; readonly kind: string }
export interface CitationDetail extends CitationView {
  readonly citing: RecordRef;
  readonly targetRecord: RecordRef;
  /** What the cited passage is part of: the Source, the file name, or the record's text field. */
  readonly targetLabel: string;
}
export interface CitationPage { readonly citations: readonly CitationDetail[]; readonly next: string | null }

async function describe(c: Context<ApiEnv>, citations: readonly CitationView[]): Promise<CitationDetail[]> {
  if (citations.length === 0) return [];
  const db = c.env.RF_CORE;
  const roots = JSON.stringify([...new Set(citations.flatMap((citation) => [citation.citingRootId, citation.targetRootId]))]);
  const attachments = JSON.stringify([...new Set(citations.filter((citation) => citation.target.type === 'attachment').map((citation) => citation.target.unitId))]);
  const [records, files] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT unit_id AS rootId, item_identifier AS identifier, title, kind FROM research_items WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(roots),
    db.prepare('SELECT unit_id AS id, original_name AS name FROM attachments WHERE unit_id IN (SELECT value FROM json_each(?1))').bind(attachments),
  ]));
  const byRoot = new Map(rowsOf<RecordRef>(records).map((record) => [record.rootId, record]));
  const names = new Map(rowsOf<{ id: string; name: string }>(files).map((file) => [file.id, file.name]));
  return citations.flatMap((citation) => {
    const citing = byRoot.get(citation.citingRootId);
    const targetRecord = byRoot.get(citation.targetRootId);
    if (!citing || !targetRecord) return [];
    const targetLabel = citation.target.type === 'attachment' ? names.get(citation.target.unitId) ?? targetRecord.title
      : citation.target.type === 'text' ? `${targetRecord.title} · ${citation.target.field ?? ''}` : targetRecord.title;
    return [{ ...citation, citing, targetRecord, targetLabel }];
  });
}

/**
 * The citations of a record, to a target, or of a Project, with both ends' titles, for the readable navigation of R54.6. A citation with an
 * end the Member cannot read is absent, and nothing says that one is, so no total or count is given (R54.5).
 */
export async function listCitations(c: Context<ApiEnv>, raw: unknown): Promise<CitationPage> {
  const query = parse(listQuerySchema, raw);
  const limit = query.limit ?? CITATION_PAGE;
  const found = await readableCitations(c, {
    ...(query.citingRootId === undefined ? {} : { citingRootId: query.citingRootId }), ...(query.targetUnitId === undefined ? {} : { targetUnitId: query.targetUnitId }),
    ...(query.targetRootId === undefined ? {} : { targetRootId: query.targetRootId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }), ...(query.after === undefined ? {} : { after: query.after }),
    unresolved: query.unresolved, includeRetired: query.includeRetired, limit: limit + 1,
  });
  const page = found.slice(0, limit);
  return { citations: await describe(c, page), next: found.length > limit ? page.at(-1)!.id : null };
}

export type Warning = { readonly citationId: ULID; readonly kind: 'unresolved' | 'earlier_version' | 'rights_not_covered'; readonly message: string };
/**
 * What a publication preview should tell the Member about the evidence a record cites: locators that were never resolved, citations to an
 * earlier version of what they cite, and cited Sources or files whose rights status does not permit publication. A link is never treated as
 * permission, so a citation to a covered Source says nothing either way (R54.5).
 */
export async function evidenceWarnings(c: Context<ApiEnv>, rootId: string): Promise<Warning[]> {
  await loadItem(c, rootId);
  const citations = await readableCitations(c, { citingRootId: rootId });
  if (citations.length === 0) return [];
  const db = c.env.RF_CORE;
  const ids = JSON.stringify(citations.map((citation) => citation.target.unitId));
  const rows = rowsOf<{ id: string; permits: number | null }>(await c.get('accountant').track(db.prepare(
    `SELECT u.id, cv.permits_publication AS permits FROM units u
      LEFT JOIN sources s ON s.unit_id = u.id LEFT JOIN attachments a ON a.unit_id = u.id
      LEFT JOIN config_values cv ON cv.id = COALESCE(s.rights_status_id, a.rights_status_id)
      WHERE u.id IN (SELECT value FROM json_each(?1))`,
  ).bind(ids).all()));
  const permits = new Map(rows.map((row) => [row.id, row.permits]));
  const warnings: Warning[] = [];
  for (const citation of citations) {
    if (citation.locator.type === 'unresolved') warnings.push({ citationId: citation.id, kind: 'unresolved', message: 'The locator is not resolved: it says where the passage is only in words.' });
    if (citation.state === 'earlier_version') warnings.push({ citationId: citation.id, kind: 'earlier_version', message: 'What this cites has changed since it was cited; it still refers to the earlier version.' });
    if (citation.target.type !== 'text' && permits.get(citation.target.unitId) === 0) {
      warnings.push({ citationId: citation.id, kind: 'rights_not_covered', message: 'The cited record has a rights status that does not permit publication. A citation is not permission.' });
    }
  }
  return warnings;
}

export interface LegacyReference { readonly field: string; readonly kind: string; readonly source: string; readonly text: string }
const EXCERPT = 80;
/**
 * The labels of a record that name a source only in words, with no citation behind them (R54.4, R54.6). They are listed for curation and
 * stay exactly as written; nothing is mapped to a Source until a Member does so.
 */
export async function legacyReferences(c: Context<ApiEnv>, rootId: string): Promise<LegacyReference[]> {
  const item = await loadItem(c, rootId);
  const placed = [...textsOf(item.fields), ...(item.base.logSummary ? [{ path: 'logSummary', text: item.base.logSummary }] : [])];
  return placed.flatMap(({ path, text }) => text.spans.flatMap((span, index) => {
    if (!('source' in span) || span.source === undefined || span.source.trim() === '' || ('citation' in span && span.citation !== undefined)) return [];
    const characters = Array.from(text.text.slice(span.s, span.e));
    const excerpt = characters.length > EXCERPT ? `${characters.slice(0, EXCERPT).join('')}…` : characters.join('');
    return [{ field: `${path === '' ? '' : `${path}.`}spans.${index}`, kind: span.k, source: span.source, text: excerpt }];
  }));
}

const exportQuerySchema = z.strictObject({
  format: z.enum(['json', 'csl-json']).default('json'), projectId: idSchema.optional(), citingRootId: idSchema.optional(), after: idSchema.optional(),
}).refine((query) => query.projectId !== undefined || query.citingRootId !== undefined, { message: 'Name a Project or a record to export.', path: ['projectId'] });

/** The most citations one page of an export holds; the page names where the next begins. */
export const EXPORT_PAGE = 100;

/**
 * Structured citations in JSON, or the cited records as CSL-JSON, for the citations the Member can read now. Identifiers, locators and
 * content hashes come through unchanged, so a restore or another tool reads back what was cited (R54.6).
 */
export async function exportCitations(c: Context<ApiEnv>, raw: unknown): Promise<{ readonly format: 'json' | 'csl-json'; readonly body: unknown; readonly next: string | null }> {
  const query = parse(exportQuerySchema, raw);
  const found = await readableCitations(c, {
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }), ...(query.citingRootId === undefined ? {} : { citingRootId: query.citingRootId }),
    ...(query.after === undefined ? {} : { after: query.after }), limit: EXPORT_PAGE + 1,
  });
  const page = found.slice(0, EXPORT_PAGE);
  const next = found.length > EXPORT_PAGE ? page.at(-1)!.id : null;
  const details = await describe(c, page);
  const items = new Map<string, CslItem>();
  for (const detail of details) {
    if (items.has(detail.targetRootId)) continue;
    let loaded;
    try { loaded = await loadItem(c, detail.targetRootId); } catch (error) { if (error instanceof ApiError && error.status === 404) continue; throw error; }
    const bibliography = loaded.fields['bibliography'] as Bibliography | undefined;
    const csl = cslItem({
      id: detail.targetRecord.identifier, title: loaded.base.title, ...(bibliography === undefined ? {} : { bibliography }),
      documentDate: loaded.fields['documentDate'] as DocumentDate | undefined, archiveOrCollection: loaded.fields['archiveOrCollection'] as string | undefined,
      archivalReference: loaded.fields['archivalReference'] as string | undefined,
    });
    items.set(detail.targetRootId, csl);
  }
  if (query.format === 'csl-json') return { format: 'csl-json', body: [...items.values()], next };
  return {
    format: 'json',
    body: exportDocument({
      exportedAt: c.get('now'),
      citations: details.map((detail) => ({
        id: detail.id, citingRecord: detail.citing.identifier, citingTitle: detail.citing.title, citingField: detail.citingField,
        target: { ...detail.target, record: detail.targetRecord.identifier, title: detail.targetLabel }, role: detail.role, locator: detail.locator, locatorLabel: detail.locatorLabel,
        contentHash: detail.contentHash, state: detail.state, ...(detail.earlierVersionAt === null ? {} : { earlierVersionAt: detail.earlierVersionAt }),
        createdAt: detail.createdAt, ...(detail.retiredAt === null ? {} : { retiredAt: detail.retiredAt }), ...(detail.replacedBy === null ? {} : { replacedBy: detail.replacedBy }),
        csl: cslCitation(detail, items.get(detail.targetRootId)?.id),
      })),
      sources: [...items.values()],
    }),
    next,
  };
}

function cslCitation(detail: CitationDetail, id: string | undefined): { readonly id: string; readonly label?: string; readonly locator?: string } | null {
  if (id === undefined) return null;
  const { locator } = detail;
  switch (locator.type) {
    case 'page': return { id, label: 'page', locator: locator.to === undefined ? String(locator.from) : `${locator.from}-${locator.to}` };
    case 'folio': {
      const folio = (value: { number: number; side?: 'r' | 'v' | undefined }) => `${value.number}${value.side ?? ''}`;
      return { id, label: 'folio', locator: locator.to === undefined ? folio(locator.from) : `${folio(locator.from)}-${folio(locator.to)}` };
    }
    case 'section': return { id, label: 'section', locator: locator.section };
    case 'text_range': case 'image_region': case 'unresolved': return { id };
  }
}
