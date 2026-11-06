import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { policyPages, policySections, POLICY_PAGE_KEYS } from '@researchforce/db/schema/core';
import { POLICY_PAGES, SITE_PATHS } from '@researchforce/design/fixed-texts';
import { richTextSchema } from '@researchforce/domain/schemas/common';
import { editMarkSchema } from '@researchforce/domain/schemas/other';
import { isBlank } from '@researchforce/domain/text';
import type { RichText, Span } from '@researchforce/domain/richtext';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import { projectPolicyText } from '@researchforce/kernel/substitute';
import { canonicalJson } from '@researchforce/kernel/views';
import { buildPages } from '@researchforce/public-render/render-site';
import { renderPage } from '@researchforce/public-render/frame';
import type { PolicyPageInput, PolicyPageKey, SiteInput } from '@researchforce/public-render/site';
import { z } from 'zod';
import { recordTargetActivity } from '../activity/flags';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import type { FieldIssue } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import { loadSiteInput } from '../publisher/render';
import { publicCopyOf } from '../publisher/public-copy';
import { commitSave } from '../records/pipeline';
import type { FieldChange } from '../records/pipeline';

/** The maximum length of a Policy_Section's text in Unicode code points (R46.28, glossary Policy_Section). */
export const SECTION_LENGTH = 20_000;

/** The public path each Policy_Page is served at, so a preview renders exactly the right page. */
const PAGE_KEY_PATHS: Readonly<Record<PolicyPageKey, string>> = {
  about: SITE_PATHS.about, people: SITE_PATHS.people, methods: SITE_PATHS.methods,
  licence: SITE_PATHS.licence, privacy: SITE_PATHS.privacy, corrections: SITE_PATHS.corrections,
};
const pageTitle = (key: PolicyPageKey): string => POLICY_PAGES.find((page) => page.path === PAGE_KEY_PATHS[key])!.title;

/** A page key written in the URL, or undefined when it names no Policy_Page. */
export function policyPageKey(value: string | undefined): PolicyPageKey | undefined {
  return (POLICY_PAGE_KEYS as readonly string[]).includes(value ?? '') ? (value as PolicyPageKey) : undefined;
}

/** One Policy_Section as it stands in `policy_sections`, in its fixed position (R46.32). */
export interface PolicySectionRecord {
  readonly sectionKey: string;
  readonly position: number;
  readonly title: string;
  readonly required: boolean;
  readonly text: RichText;
}
/** A Policy_Page with its fixed, ordered sections and the `rev` an edit starts from. */
export interface PolicyPageRecord {
  readonly pageKey: PolicyPageKey;
  readonly title: string;
  readonly rev: number;
  readonly sectionsChangedAt: Timestamp | null;
  readonly sections: readonly PolicySectionRecord[];
}

interface PageRow { readonly rev: number; readonly sectionsChangedAt: Timestamp | null }
interface SectionRow { readonly sectionKey: string; readonly position: number; readonly title: string; readonly required: number; readonly text: string; readonly textSpans: string }

/** The Policy_Page named by `pageKey`, with its sections in their fixed order (R46.32). */
export async function loadPolicyPage(c: Context<ApiEnv>, pageKey: PolicyPageKey): Promise<PolicyPageRecord> {
  const db = c.env.RF_CORE;
  const [pageRows, sectionRows] = await c.get('accountant').track(db.batch([
    db.prepare('SELECT rev, sections_changed_at AS sectionsChangedAt FROM policy_pages WHERE page_key = ?1').bind(pageKey),
    db.prepare('SELECT section_key AS sectionKey, position, title, required, text, text_spans AS textSpans FROM policy_sections WHERE page_key = ?1 ORDER BY position').bind(pageKey),
  ]));
  const page = (pageRows as D1Result<PageRow>).results[0];
  if (!page) throw new ApiError('not_found');
  const sections = (sectionRows as D1Result<SectionRow>).results.map((row): PolicySectionRecord => ({
    sectionKey: row.sectionKey, position: row.position, title: row.title, required: row.required === 1,
    text: { text: row.text, spans: JSON.parse(row.textSpans) as Span[] },
  }));
  return { pageKey, title: pageTitle(pageKey), rev: page.rev, sectionsChangedAt: page.sectionsChangedAt, sections };
}

/**
 * The HTML of one Policy_Page exactly as the Public_Site presents it, built from the current site input with
 * `sections` overlaid onto the target page (R46.27). The page's sections run through the same public renderer the
 * Publisher uses, so the preview and the published page are produced the same way. Registered Member addresses are
 * replaced as they are on the Public_Site, since the loaded site input already scrubs policy text (R46.9).
 */
async function renderPolicyPreview(c: Context<ApiEnv>, pageKey: PolicyPageKey, sections: readonly PolicySectionRecord[]): Promise<string> {
  const site = await loadSiteInput({ core: c.env.RF_CORE, public: c.env.RF_PUBLIC, licence: licenceOf(c), publicCopy: publicCopyOf(c.env) });
  const current = site.policy[pageKey];
  const emails = await registeredEmails(c);
  // Scrub the edited text the same way `buildPolicy` scrubs the stored text, so the preview replaces the same
  // addresses the published page would, while keeping the loaded site's already-scrubbed values for every other field.
  const overlaid: PolicyPageInput = {
    changedOn: current.changedOn,
    sections: sections.map((section) => ({
      key: section.sectionKey, title: section.title, required: section.required,
      text: projectPolicyText(section.text, emails).text,
    })),
  };
  const overlay: SiteInput = { ...site, policy: { ...site.policy, [pageKey]: overlaid } };
  const spec = buildPages(overlay).find((page) => page.path === PAGE_KEY_PATHS[pageKey]);
  if (!spec) throw new ApiError('not_found');
  return renderPage(overlay, spec);
}

/** Every registered Member address, matched to be scrubbed from the preview exactly as on the Public_Site (R46.9). */
async function registeredEmails(c: Context<ApiEnv>): Promise<string[]> {
  const result = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT email FROM members').all<{ email: string }>());
  return result.results.map((row) => row.email);
}

/** The Policy_Page's data to edit and a preview rendered exactly as the Public_Site shows it (R46.27). */
export async function policyResponse(c: Context<ApiEnv>, page: PolicyPageRecord): Promise<Record<string, unknown>> {
  return {
    page: page.pageKey,
    title: page.title,
    rev: page.rev,
    sectionsChangedAt: page.sectionsChangedAt,
    sections: page.sections.map((section) => ({
      key: section.sectionKey, position: section.position, title: section.title, required: section.required, text: section.text,
    })),
    preview: await renderPolicyPreview(c, page.pageKey, page.sections),
  };
}

const sectionEditSchema = z.strictObject({ key: z.string(), text: richTextSchema(SECTION_LENGTH) });
const editSchema = z.strictObject({
  rev: z.int().min(1),
  mark: editMarkSchema,
  sections: z.array(sectionEditSchema).max(POLICY_PAGE_KEYS.length * 20),
});
export type PolicyEdit = z.output<typeof editSchema>;

/**
 * Save an Administrator's edit to the text of a Policy_Page's sections as one guarded batch (R46.27, R46.28).
 *
 * The route never adds, removes, renames, or reorders a section: the submitted keys must be exactly the page's fixed
 * section keys, and each section keeps its stored position, title, and required flag; only the text (and its labels)
 * change. The save is refused — keeping the Administrator's input and listing the Revisions since the base `rev` — when
 * the Minor_Edit/Correction mark is missing or its reason is invalid, a required section is left blank, any section
 * exceeds 20,000 code points, an unknown or missing section key is sent, or the base `rev` is stale (another Revision
 * came first). On success it records one Minor_Edit or Correction Revision of the Policy_Page holding the previous text
 * of each changed section, updates the sections and the page's `rev`/`sections_changed_at`, writes one Activity_Feed
 * entry linking to the page's history, and one publish outbox row so the Public_Site re-renders.
 *
 * Returns the saved page and the preview that was confirmed; a no-op edit returns the unchanged page.
 */
export async function editPolicyPage(c: Context<ApiEnv>, current: PolicyPageRecord, body: unknown): Promise<PolicyPageRecord> {
  await authorize(c, [{ permission: 'policy.edit', target: { type: 'policy_section' } }]);
  const edit = parse(editSchema, body);
  const now = c.get('now');

  const byKey = new Map(current.sections.map((section) => [section.sectionKey, section]));
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  const next = new Map<string, RichText>();
  for (const [index, submitted] of edit.sections.entries()) {
    const section = byKey.get(submitted.key);
    if (!section) { issues.push({ field: `sections.${index}.key`, rule: 'This Policy Section is not part of this page; sections cannot be added, removed, renamed, or reordered.' }); continue; }
    if (seen.has(submitted.key)) { issues.push({ field: `sections.${index}.key`, rule: 'Each Policy Section appears at most once.' }); continue; }
    seen.add(submitted.key);
    if (section.required && isBlank(submitted.text.text)) issues.push({ field: `sections.${index}.text`, rule: 'A required Policy Section needs at least one non-whitespace character.' });
    // The schema validated the spans; its output types optional span fields more loosely than RichText, so narrow here.
    next.set(submitted.key, { text: submitted.text.text, spans: submitted.text.spans as Span[] });
  }
  // Every fixed section must be present: the Workspace offers no way to drop one, so a missing key is refused (R46.32).
  for (const section of current.sections) {
    if (!next.has(section.sectionKey)) issues.push({ field: 'sections', rule: `The Policy Section “${section.title}” is missing; every section of the page must be sent.` });
  }
  if (issues.length > 0) throw new ApiError('validation', { fields: issues });

  const changes: FieldChange[] = [];
  const changedSections: { readonly key: string; readonly text: RichText }[] = [];
  for (const section of current.sections) {
    const after = next.get(section.sectionKey)!;
    if (canonicalJson(section.text) === canonicalJson(after)) continue;
    changes.push({ field: section.sectionKey, before: section.text, after, fieldClass: 'content' });
    changedSections.push({ key: section.sectionKey, text: after });
  }
  if (changes.length === 0) return current;

  await commitSave(c, {
    target: { type: 'policy_page', id: current.pageKey },
    startedFrom: edit.rev,
    change: { fields: changes, mark: { mark: edit.mark.mark, ...(edit.mark.reason === undefined ? {} : { reason: edit.mark.reason }) } },
    write: (batch) => {
      for (const section of changedSections) {
        batch.update(policySections, { text: section.text.text, textSpans: [...section.text.spans], changedAt: now }, sql`${policySections.pageKey} = ${current.pageKey} AND ${policySections.sectionKey} = ${section.key}`);
      }
      batch.update(policyPages, { sectionsChangedAt: now }, eq(policyPages.pageKey, current.pageKey));
      // One Activity_Feed entry for the change, in place of the Items concerned showing the page with a link to its
      // history (R46.31). `commitSave`'s `announceRevisions` records nothing for a `policy_page` target, so it is here.
      recordTargetActivity(batch, { kind: 'policy_change', targetType: 'policy_page', targetId: current.pageKey });
    },
    outbox: [['publish', `policy:${current.pageKey}`]],
  });
  return loadPolicyPage(c, current.pageKey);
}

/** A stable identifier for a point in the history: a Revision's id, or `creation`. */
export const CREATION = 'creation';

export interface PolicyHistoryEntry {
  /** The point's stable id (a Revision id, or `creation`), used by the comparison. */
  readonly point: string;
  readonly kind: 'creation' | string;
  readonly memberId: ULID | null;
  readonly displayName: string | null;
  readonly at: Timestamp;
  readonly reason?: string | null;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly changes?: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
}

interface RevisionRow { readonly id: string; readonly kind: string; readonly memberId: ULID; readonly displayName: string | null; readonly at: Timestamp; readonly reason: string | null; readonly prev: string }

/**
 * The creation and every Revision of a Policy_Page, newest first, each with the editing Member, the time, the
 * Revision_Kind and reason, and each changed section's text before and after, as Requirement 22.3 and 22.4 show an
 * Item's history and comparisons (R46.27). Each entry carries a stable `point` id (the Revision id, or `creation`) so a
 * comparison names the same two points regardless of their timestamps.
 */
export async function policyHistory(c: Context<ApiEnv>, page: PolicyPageRecord): Promise<PolicyHistoryEntry[]> {
  const db = c.env.RF_CORE;
  const revisions = (await c.get('accountant').track(db.prepare(
    `SELECT r.id, r.kind, r.member_id AS memberId, p.display_name AS displayName, r.at, r.reason, r.prev FROM revisions r
      LEFT JOIN profiles p ON p.member_id = r.member_id WHERE r.target_type = 'policy_page' AND r.target_id = ?1 ORDER BY r.seq DESC, r.id DESC`,
  ).bind(page.pageKey).all<RevisionRow>())).results;
  // The current text of each section; walking the Revisions back (newest first) fills in the state after each one.
  let state: Record<string, unknown> = Object.fromEntries(page.sections.map((section) => [section.sectionKey, section.text]));
  const entries: PolicyHistoryEntry[] = [];
  for (const revision of revisions) {
    const prev = JSON.parse(revision.prev) as Record<string, unknown>;
    entries.push({
      point: revision.id, kind: revision.kind, memberId: revision.memberId, displayName: revision.displayName, at: revision.at, reason: revision.reason,
      changes: Object.entries(prev).map(([field, before]) => ({ field, before, after: state[field] ?? null })),
    });
    state = { ...state, ...prev };
  }
  // The Policy_Page's initial text is written in design and seeded, not by a Member; the creation shows that state.
  entries.push({ point: CREATION, kind: CREATION, memberId: null, displayName: null, at: page.sectionsChangedAt ?? (revisions.at(-1)?.at ?? ('1970-01-01T00:00:00.000Z' as Timestamp)), values: state });
  return entries;
}

/** The full section state as it stood immediately after the chosen point (a Revision id, or `creation`). */
function stateAtPoint(history: readonly PolicyHistoryEntry[], point: string): Record<string, unknown> {
  const creation = history.find((entry) => entry.kind === CREATION);
  const state: Record<string, unknown> = { ...creation?.values };
  if (point === CREATION) return state;
  // Apply Revisions oldest-first up to and including the chosen point.
  const ordered = [...history].filter((entry) => entry.kind !== CREATION).reverse();
  for (const entry of ordered) {
    for (const change of entry.changes ?? []) state[change.field] = change.after;
    if (entry.point === point) return state;
  }
  throw new ApiError('validation', { fields: [{ field: 'point', rule: 'Choose the creation or a Revision of this page.' }] });
}

/** Each section whose text differs between two points in the Policy_Page's history, with both values (R22.4, R46.27). */
export function policyCompare(history: readonly PolicyHistoryEntry[], from: string, to: string): { readonly from: string; readonly to: string; readonly changes: { readonly field: string; readonly before: unknown; readonly after: unknown }[] } {
  const before = stateAtPoint(history, from);
  const after = stateAtPoint(history, to);
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [...fields].sort().flatMap((field) => canonicalJson(before[field] ?? null) === canonicalJson(after[field] ?? null)
    ? [] : [{ field, before: before[field] ?? null, after: after[field] ?? null }]);
  return { from, to, changes };
}

/** The installation's Content_Licence for the preview's footer and licence page link (R29.10, R46.15). */
function licenceOf(c: Context<ApiEnv>): { readonly name: string; readonly url: string } {
  return { name: c.get('contentLicence'), url: c.env.CONTENT_LICENCE_URL ?? '' };
}
