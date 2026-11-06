import type { ValidatedInstallationPublicCopy } from '@researchforce/design/installation';
import { retentionRows } from '@researchforce/domain/retention';
import { OPERATIONS } from '@researchforce/domain/settings';
import type { Timestamp } from '@researchforce/domain/types';
import { GuardedBatch } from '@researchforce/db/batch';
import { projectPolicyText, projectProfile, responsiblePersonLabel } from '@researchforce/kernel/substitute';
import type { ProfileRecord, PublicProfileView } from '@researchforce/kernel/substitute';
import type { PublicView, UnitKey } from '@researchforce/kernel/views';
import { buildSearchIndex } from '@researchforce/search-public/build';
// The Public_Site `_headers` file lives in `public-render` (`src/headers.ts`, task 45.2), the single source of truth
// for the CSP and security-header strings (R45.17 to R45.19). Re-exported below so the Publisher and its render test
// reach it through the render module as before.
import { headersFile } from '@researchforce/public-render/headers';
import { renderSite, type SiteFile } from '@researchforce/public-render/render-site';

export { headersFile };
import {
  METHODS_SET_KINDS, POLICY_PAGE_KEYS,
  type MethodsInput, type MethodsSetKind, type MethodsValue, type PolicyPageInput, type PolicyPageKey, type SiteInput,
} from '@researchforce/public-render/site';
import { notifySystemAlert } from '../notifications/fanout';
import { directUploadHash, extensionOf, manifestPath, planSite, reachesFileAlert } from './plan';
import type { ManifestEntry, PlannedFile, SitePlan } from './plan';
import { advancedGeneratedRows, policyLastUpdated } from './policy-pages';
import type { GeneratedContent, GeneratedRow, PolicyPageState } from './policy-pages';

/**
 * The Publisher's render step (task 32.3, design "Publisher" step 5). It loads one Public_Site build input from the
 * current `rf-public.public_views` joined with the `rf-core` data the non-view fields need, renders the full file
 * set with `public-render` and `search-public`, adds `_headers` and the built `site-shell` static assets, hashes
 * each file as the Direct Upload API specifies, stores new content at `rf-private/build/{hash}`, and keeps the
 * `rf-public.site_files` manifest in step (R24.1, R24.2, R24.4, R24.5, R28.16, R29.1, R30.7, R30.8, R40.4, R45.4).
 *
 * The Not_Published/Withheld-Project rule is already enforced inside `renderSite`: a Not_Published unit has no
 * current `public_views` row so it is not in `views`, a Withheld Project renders only its own page and `renderSite`
 * routes every other `/p/{slug}/…` address to the shared `404.html`, and so those addresses serve the same
 * not-found page as unknown ones (R24.7, R40.10). Policy pages, metadata, print styles, fonts, scripts, and images
 * ship only as static assets — the site-shell build and the fixed Design_System assets — never as per-view renders.
 */

export interface RenderDeps {
  readonly core: D1Database;
  readonly public: D1Database;
  /** The `rf-private` bucket; rendered content waits at `build/{hash}` for 32.5's upload (design R2 inventory). */
  readonly privateBucket: R2Bucket;
  /** The installation's Content_Licence; the footer and licence page link the name to the URL (R29.10, R46.15). */
  readonly licence: { readonly name: string; readonly url: string };
  /**
   * The installation's validated `Installation_Public_Copy` (masthead, Mission, About prose, Principles). A caller
   * obtains it through `assertPublicCopy`, which refuses an unconfigured or partial bundle; there is no
   * ResearchForce.org fallback (R46.41, R46.42).
   */
  readonly publicCopy: ValidatedInstallationPublicCopy;
  /**
   * The compiled `site-shell` assets and fixed Design_System files (scripts, styles, print CSS, fonts, images, the
   * 404 metadata) to ship as static files. These are produced by `apps/site-shell`'s Vite build with content-hashed
   * names; how that build output is wired into this Durable Object at runtime is a packaging concern outside 32.3,
   * so the caller injects the resolved set here. An empty set renders every page against the fixed `DEFAULT_ASSETS`
   * addresses (`public-render/site`), which is what the render tests exercise.
   */
  readonly shellAssets: readonly ShellAsset[];
}

/** One static asset shipped verbatim with every deploy: its site-absolute path, content type, and bytes. */
export interface ShellAsset { readonly path: string; readonly contentType: string; readonly content: Uint8Array }

/** The outcome of one full render + manifest reconciliation. */
export interface RenderResult {
  /** The adds/changes/deletes against the prior manifest. */
  readonly plan: SitePlan;
  /** The complete produced file count, for the deploy manifest and the alert check. */
  readonly fileCount: number;
  /** True when the produced set reached the 16,000-file alert threshold and a System_Alert was raised (R28.16). */
  readonly alerted: boolean;
}

/** A produced file with its bytes and content type, before it is hashed and stored. */
interface RenderedFile { readonly path: string; readonly contentType: string; readonly content: Uint8Array }

const encoder = new TextEncoder();

/**
 * Render the current Public_Site and reconcile `rf-private/build/{hash}` content and the `rf-public.site_files`
 * manifest with it. Returns the plan and file count for 32.5 to deploy. New or changed content is stored under its
 * hash, manifest rows for files no longer produced are removed, and the manifest ends holding exactly the produced
 * set (path, hash, size, updatedAt).
 */
export async function renderSiteBuild(deps: RenderDeps, now: Timestamp): Promise<RenderResult> {
  const input = await loadSiteInput(deps, now);
  // Persist the per-page generated-content hash/date for any page whose generated content changed this build, so the
  // same last-updated date the render shows is the date later builds keep while the content is unchanged (R46.29).
  await persistGeneratedDates(deps.core, input, now);
  const rendered = toRenderedFiles(renderSite(input), input, deps.shellAssets);

  // Hash every produced file with the Direct Upload algorithm so the manifest agrees with 32.1's upload (R24.7).
  const files = new Map<string, { file: RenderedFile; planned: PlannedFile }>();
  const planned: PlannedFile[] = [];
  for (const file of rendered) {
    const hash = await directUploadHash(file.content, extensionOf(file.path));
    const entry: PlannedFile = { path: file.path, hash, size: file.content.length };
    files.set(file.path, { file, planned: entry });
    planned.push(entry);
  }

  const manifest = await readManifest(deps.public);
  const plan = planSite(planned, manifest);

  // Store the bytes of every added or changed file under `rf-private/build/{hash}`; unchanged content is already
  // there. Content is addressed by hash, so two files with identical bytes share one object and one put.
  const storedHashes = new Set<string>();
  for (const entry of [...plan.added, ...plan.changed]) {
    if (storedHashes.has(entry.hash)) continue;
    storedHashes.add(entry.hash);
    const held = files.get(entry.path)!;
    await deps.privateBucket.put(`build/${entry.hash}`, held.file.content, { httpMetadata: { contentType: held.file.contentType } });
  }

  // Bring the manifest to exactly the produced set: upsert every produced row, delete rows for files no longer made.
  await writeManifest(deps.public, plan, now);

  const alerted = reachesFileAlert(plan.all.length);
  if (alerted) await raiseFileCountAlert(deps.core, plan.all.length, now);
  return { plan, fileCount: plan.all.length, alerted };
}

/** The complete produced file set as the hasher reads it: one entry per rendered page/index/asset, each with its bytes. */
function toRenderedFiles(siteFiles: readonly SiteFile[], input: SiteInput, shellAssets: readonly ShellAsset[]): RenderedFile[] {
  const files: RenderedFile[] = [];
  const seen = new Set<string>();
  const add = (file: RenderedFile): void => {
    if (seen.has(file.path)) throw new Error(`Two files share the address ${file.path}.`);
    seen.add(file.path);
    files.push(file);
  };
  // Pages, sitemap.xml, and robots.txt from the string renderer (R24.5).
  for (const file of siteFiles) add({ path: manifestPath(file), contentType: file.contentType, content: encoder.encode(file.content) });
  // The static search index: manifest, term buckets, and 64 content-hashed shards (R30.1).
  for (const file of buildSearchIndex(input.views)) add({ path: manifestPath(file), contentType: file.contentType, content: encoder.encode(file.content) });
  // `_headers` (CSP and other response headers for the assets-only rf-site, design "Headers").
  add({ path: '/_headers', contentType: 'text/plain; charset=utf-8', content: encoder.encode(headersFile()) });
  // The compiled site-shell scripts/styles and the fixed Design_System assets, shipped verbatim as static files.
  for (const asset of shellAssets) add({ path: asset.path.startsWith('/') ? asset.path : `/${asset.path}`, contentType: asset.contentType, content: asset.content });
  return files;
}

// ---------------------------------------------------------------------------
// The loader: one SiteInput from the current `rf-public` views and the `rf-core` non-view fields.
// ---------------------------------------------------------------------------

/**
 * Build one `SiteInput` from the current open Public_Views (`valid_to_at IS NULL`) and the `rf-core` data the
 * non-view fields read: the Project_Order/featured/accent/createdAt from `projects`, the active Public_Profiles
 * from `profiles`, the Methods value sets and fixed terms from `config_values`/`methods_terms`, the Policy_Sections
 * from `policy_sections`/`policy_pages`, the Responsible_Person display name from `settings`, and the Content_Licence
 * from the injected configuration. Registered Member addresses are scrubbed from profiles and policy text, exactly
 * as the projection does (R46.5, R46.9).
 */
export async function loadSiteInput(deps: Pick<RenderDeps, 'core' | 'public' | 'licence' | 'publicCopy'>, now?: Timestamp): Promise<SiteInput> {
  return buildSiteInput(deps, await loadViews(deps.public), now);
}

/**
 * The views current at the start time T, filtered to one Project's units when a scope Project is given (task 38.2,
 * R35.2). A version is in force at T when `valid_from_at <= T` and it is still open (`valid_to_at IS NULL`) or closed
 * after T (`valid_to_at > T`). With a scope Project, only that Project's key (`p:<id>`) and the units of that Project
 * (`project_id`) are kept; the whole archive otherwise. Each row's level is either Public or Withheld, as the table
 * only holds those (R35.2).
 */
export async function loadViewsAsOf(pub: D1Database, startedAt: string, scopeProjectId: string | null): Promise<ReadonlyMap<UnitKey, PublicView>> {
  const where = 'valid_from_at <= ?1 AND (valid_to_at IS NULL OR valid_to_at > ?1)';
  const scope = scopeProjectId === null ? '' : ' AND (unit_key = ?2 OR project_id = ?2)';
  const result = scopeProjectId === null
    ? await pub.prepare(`SELECT unit_key AS unitKey, view_json AS viewJson FROM public_views WHERE ${where}`).bind(startedAt).all<{ unitKey: string; viewJson: string }>()
    : await pub.prepare(`SELECT unit_key AS unitKey, view_json AS viewJson FROM public_views WHERE ${where}${scope}`).bind(startedAt, `p:${scopeProjectId}`).all<{ unitKey: string; viewJson: string }>();
  return new Map(result.results.map((row) => [row.unitKey as UnitKey, JSON.parse(row.viewJson) as PublicView]));
}

/**
 * Build a `SiteInput` from a given views map and the current `rf-core` non-view data, for both the Publisher and the
 * export. Pass the build's `now` in the Publisher so a change to a Policy_Page's generated content advances its
 * last-updated date to today (R46.29); omit it for the preview and the export, which show the date the last published
 * build recorded without advancing it.
 */
export async function buildSiteInput(deps: Pick<RenderDeps, 'core' | 'public' | 'licence' | 'publicCopy'>, views: ReadonlyMap<UnitKey, PublicView>, now?: Timestamp): Promise<SiteInput> {
  const [projectRows, memberRows, specialtyRows, affiliationRows, valueRows, termRows, policyPageRows, policySectionRows, settingRows]
    = await deps.core.batch([
      deps.core.prepare('SELECT id, accent, featured, position, created_at AS createdAt, question_order AS questionOrder FROM projects ORDER BY position'),
      // Every Member joined to its Profile, as the projection reads them: all addresses are scrubbed, and
      // `projectProfile` keeps only the Active Members with the setting On (R46.5, R46.9, R46.34).
      deps.core.prepare('SELECT m.id, m.email, m.status, p.display_name AS displayName, p.bio, p.public_profile AS publicProfile FROM members m LEFT JOIN profiles p ON p.member_id = m.id'),
      deps.core.prepare('SELECT ps.member_id AS memberId, cv.name FROM profile_specialties ps JOIN config_values cv ON cv.id = ps.value_id'),
      deps.core.prepare('SELECT member_id AS memberId, position, text FROM profile_affiliations ORDER BY member_id, position'),
      deps.core.prepare('SELECT id, set_key AS setKey, name, retired, public_description AS publicDescription, position FROM config_values WHERE set_key <> \'specialty\' ORDER BY set_key, position'),
      deps.core.prepare('SELECT key, name, public_description AS publicDescription, position FROM methods_terms ORDER BY group_key, position'),
      deps.core.prepare('SELECT page_key AS pageKey, sections_changed_at AS sectionsChangedAt, generated_hash AS generatedHash, generated_changed_at AS generatedChangedAt FROM policy_pages'),
      deps.core.prepare('SELECT page_key AS pageKey, section_key AS sectionKey, title, required, text, position FROM policy_sections ORDER BY page_key, position'),
      deps.core.prepare("SELECT key, value FROM settings WHERE key = 'responsiblePerson'"),
    ]);

  const projects = (projectRows as D1Result<ProjectRow>).results;
  const members = (memberRows as D1Result<MemberRow>).results;
  const emails = members.map((row) => row.email);
  const responsibleId = parseSetting((settingRows as D1Result<{ key: string; value: string }>).results[0]?.value);

  // The generated content each Policy_Page presents (R46.29). These same values are the SiteInput fields below and
  // the inputs to each page's generated-content last-updated date, so they are built once here.
  const profiles = buildProfiles(members, specialtyRows as D1Result<NamedRow>, affiliationRows as D1Result<AffiliationRow>, emails);
  const methods = buildMethods((valueRows as D1Result<ValueRow>).results, (termRows as D1Result<TermRow>).results);
  // The Responsible_Person is named on the Privacy page whatever the Member_Status, so its name comes from the
  // Member's Profile row regardless of whether that Member is Active (R46.35), with any registered address scrubbed
  // from the name as from every other Public_Site output (R46.9).
  const responsiblePerson = responsiblePersonLabel(members, responsibleId, emails);
  const retention = retentionRows();

  return {
    views,
    projectOrder: projects.map((project) => `p:${project.id}` as UnitKey),
    featured: new Set(projects.filter((project) => project.featured === 1).map((project) => `p:${project.id}` as UnitKey)),
    createdAt: new Map(projects.map((project) => [`p:${project.id}` as UnitKey, project.createdAt])),
    // Each Project's Administrator-set Research_Question order, as view keys, for the Project page part (R50.5).
    questionOrder: new Map(projects.map((project) => [`p:${project.id}` as UnitKey, questionOrderKeys(project.questionOrder)])),
    licence: deps.licence,
    publicCopy: deps.publicCopy,
    profiles,
    responsiblePerson,
    methods,
    policy: buildPolicy(
      (policySectionRows as D1Result<PolicySectionRow>).results, (policyPageRows as D1Result<PolicyPageRow>).results,
      { profiles, methods, licence: deps.licence, retention, responsiblePerson }, now, emails,
    ),
    retention,
  };
}

interface ProjectRow {
  readonly id: string; readonly accent: string | null; readonly featured: number; readonly position: number; readonly createdAt: string;
  /** The `projects.question_order` JSON array of Research_Question ids (R50.5). */
  readonly questionOrder: string | null;
}

/** The stored `question_order` JSON array parsed into view keys (`u:<id>`); a malformed or absent value yields no order. */
function questionOrderKeys(stored: string | null): UnitKey[] {
  if (!stored) return [];
  try {
    const ids = JSON.parse(stored) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').map((id) => `u:${id}` as UnitKey) : [];
  } catch { return []; }
}
interface MemberRow {
  readonly id: string; readonly email: string; readonly status: ProfileRecord['status'];
  readonly displayName: string | null; readonly bio: string | null; readonly publicProfile: number | null;
}
interface NamedRow { readonly memberId: string; readonly name: string }
interface AffiliationRow { readonly memberId: string; readonly position: number; readonly text: string }
interface ValueRow { readonly id: string; readonly setKey: string; readonly name: string; readonly retired: number; readonly publicDescription: string | null; readonly position: number }
interface TermRow { readonly key: string; readonly name: string; readonly publicDescription: string; readonly position: number }
interface PolicyPageRow {
  readonly pageKey: PolicyPageKey; readonly sectionsChangedAt: string | null;
  readonly generatedHash: string | null; readonly generatedChangedAt: string | null;
}
interface PolicySectionRow { readonly pageKey: PolicyPageKey; readonly sectionKey: string; readonly title: string; readonly required: number; readonly text: string; readonly position: number }

/** The current (open) Public_Views, parsed from their stored canonical JSON, keyed by unit key (`p:…`/`u:…`). */
async function loadViews(pub: D1Database): Promise<ReadonlyMap<UnitKey, PublicView>> {
  const result = await pub.prepare('SELECT unit_key AS unitKey, view_json AS viewJson FROM public_views WHERE valid_to_at IS NULL')
    .all<{ unitKey: string; viewJson: string }>();
  return new Map(result.results.map((row) => [row.unitKey as UnitKey, JSON.parse(row.viewJson) as PublicView]));
}

/** The Methods page input: each configurable set's values in display order, and the fixed Methods_Terms (R46.11, R46.12). */
function buildMethods(values: readonly ValueRow[], terms: readonly TermRow[]): MethodsInput {
  const byKind = Object.fromEntries(METHODS_SET_KINDS.map((kind) => [kind, [] as MethodsValue[]])) as Record<MethodsSetKind, MethodsValue[]>;
  for (const value of values) {
    const kind = value.setKey as MethodsSetKind;
    if (kind in byKind) byKind[kind].push({ id: value.id, name: value.name, description: value.publicDescription ?? '', retired: value.retired === 1 });
  }
  return { values: byKind, terms: terms.map((term) => ({ key: term.key as MethodsInput['terms'][number]['key'], name: term.name, description: term.publicDescription })) };
}

/**
 * The Policy_Pages input: each page's sections in order with Member addresses scrubbed, and its last-updated date out
 * of its section change and its generated-content change (R46.9, R46.29). The generated-content date comes from
 * hashing the content each page presents and comparing it to the hash the last build stored (`policy-pages.ts`); the
 * public renderer adds the page's fixed-text version date on top. With a build `now` a changed hash advances the date
 * to today; without one (preview/export) the stored date stands.
 */
function buildPolicy(
  sections: readonly PolicySectionRow[], pages: readonly PolicyPageRow[],
  generated: GeneratedContent, now: Timestamp | undefined, emails: readonly string[],
): Readonly<Record<PolicyPageKey, PolicyPageInput>> {
  const lastUpdated = policyLastUpdated(generated, policyPageState(pages), now);
  const result = Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageInput] => [key, {
    changedOn: lastUpdated[key].changedOn,
    sections: sections.filter((section) => section.pageKey === key).map((section) => ({
      key: section.sectionKey, title: section.title, required: section.required === 1,
      text: projectPolicyText({ text: section.text, spans: [] }, emails).text,
    })),
  }])) as Record<PolicyPageKey, PolicyPageInput>;
  return result;
}

/** The stored section-change date and generated hash/date each Policy_Page carries, keyed by page, for the last-updated computation. */
function policyPageState(pages: readonly PolicyPageRow[]): Readonly<Record<PolicyPageKey, PolicyPageState>> {
  const byKey = new Map(pages.map((page) => [page.pageKey, page]));
  return Object.fromEntries(POLICY_PAGE_KEYS.map((key): [PolicyPageKey, PolicyPageState] => {
    const page = byKey.get(key);
    return [key, { sectionChangedAt: page?.sectionsChangedAt ?? null, stored: { hash: page?.generatedHash ?? null, changedAt: page?.generatedChangedAt ?? null } }];
  })) as Record<PolicyPageKey, PolicyPageState>;
}

/**
 * Persist the generated-content hash and date of every Policy_Page whose generated content changed this build, so the
 * last-updated date the render shows is the date later builds keep while the content is unchanged (R46.29). Read-only
 * when nothing changed. Called only from the Publisher's `renderSiteBuild`, which passes the build `now`.
 */
async function persistGeneratedDates(core: D1Database, site: SiteInput, now: Timestamp): Promise<void> {
  const pages = await core.prepare('SELECT page_key AS pageKey, sections_changed_at AS sectionsChangedAt, generated_hash AS generatedHash, generated_changed_at AS generatedChangedAt FROM policy_pages')
    .all<PolicyPageRow>();
  const generated: GeneratedContent = { profiles: site.profiles, methods: site.methods, licence: site.licence, retention: site.retention, responsiblePerson: site.responsiblePerson };
  const rows: GeneratedRow[] = advancedGeneratedRows(policyLastUpdated(generated, policyPageState(pages.results), now));
  if (rows.length === 0) return;
  await core.batch(rows.map((row) => core.prepare('UPDATE policy_pages SET generated_hash = ?1, generated_changed_at = ?2 WHERE page_key = ?3').bind(row.hash, row.changedAt, row.pageKey)));
}

/** The active Public_Profiles for the People page, scrubbed of Member addresses and limited to the setting-On Active Members (R46.5). */
function buildProfiles(members: readonly MemberRow[], specialties: D1Result<NamedRow>, affiliations: D1Result<AffiliationRow>, emails: readonly string[]): PublicProfileView[] {
  const specialtiesByMember = new Map<string, string[]>();
  for (const row of specialties.results) (specialtiesByMember.get(row.memberId) ?? specialtiesByMember.set(row.memberId, []).get(row.memberId)!).push(row.name);
  const affiliationsByMember = new Map<string, string[]>();
  for (const row of affiliations.results) (affiliationsByMember.get(row.memberId) ?? affiliationsByMember.set(row.memberId, []).get(row.memberId)!).push(row.text);
  const views: PublicProfileView[] = [];
  for (const member of members) {
    // `projectProfile` keeps only Members that are both Active and have the Public_Profile setting On, and scrubs
    // any registered address from the four shown fields (R46.5). A Member without a Profile row contributes none.
    const record: ProfileRecord = {
      displayName: member.displayName ?? '', specialties: specialtiesByMember.get(member.id) ?? [],
      affiliations: affiliationsByMember.get(member.id) ?? [], biography: member.bio ?? '',
      publicProfile: member.publicProfile === 1, status: member.status,
    };
    const projected = projectProfile(record, emails);
    if (projected !== undefined) views.push(projected.view);
  }
  return views;
}

const parseSetting = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === 'string' ? parsed : undefined; } catch { return undefined; }
};

// ---------------------------------------------------------------------------
// Manifest I/O.
// ---------------------------------------------------------------------------

/** The current `rf-public.site_files` rows, the manifest the plan diffs against. */
async function readManifest(pub: D1Database): Promise<ManifestEntry[]> {
  const result = await pub.prepare('SELECT path, hash, size FROM site_files').all<ManifestEntry>();
  return result.results;
}

/** How many `site_files` upserts travel in one `rf-public` batch; large sites split the manifest write into batches. */
const MANIFEST_BATCH_ROWS = 200;

/** Upsert every produced row and delete the rows for files no longer produced, in bounded `rf-public` batches. */
async function writeManifest(pub: D1Database, plan: SitePlan, now: Timestamp): Promise<void> {
  const upserts = [...plan.added, ...plan.changed];
  for (let start = 0; start < upserts.length; start += MANIFEST_BATCH_ROWS) {
    const statements = upserts.slice(start, start + MANIFEST_BATCH_ROWS).map((file) => pub.prepare(
      `INSERT INTO site_files (path, hash, size, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT (path) DO UPDATE SET hash = excluded.hash, size = excluded.size, updated_at = excluded.updated_at`,
    ).bind(file.path, file.hash, file.size, now));
    if (statements.length > 0) await pub.batch(statements);
  }
  if (plan.removed.length > 0) {
    await pub.prepare('DELETE FROM site_files WHERE path IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(plan.removed)).run();
  }
}

/** The 16,000-file System_Alert for Administrators: the site is approaching the 20,000-file version ceiling (R28.16). */
async function raiseFileCountAlert(core: D1Database, fileCount: number, now: Timestamp): Promise<void> {
  const batch = new GuardedBatch(core, { id: null, now }, { ignoreFreeze: true });
  notifySystemAlert(batch, 'site_file_count', {
    allowance: `The public site has ${fileCount} files, nearing the ${OPERATIONS.siteFileCeiling}-file version limit`,
    files: fileCount, ceiling: OPERATIONS.siteFileCeiling, at: now,
  });
  await batch.commit();
}
