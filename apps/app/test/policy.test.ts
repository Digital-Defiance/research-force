import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_POLICY_SECTIONS } from '@researchforce/db/seed/policy-sections';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { asTimestamp } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../src/env';
import { migrated } from './d1';
import { addMember, call, KeyServer, resetPeople, testApi } from './api';
import type { TestApi } from './api';

const t0 = new Date('2026-11-01T12:00:00.000Z');
const at = asTimestamp(t0.toISOString());
let bindings: Env;
let access: TestAccess;
let api: TestApi;
let admin: string;
let adminId: ULID;
let contributor: string;
const core = () => bindings.RF_CORE;
const token = (email: string) => signAssertion(access, assertionSpec(email), t0) as Promise<string>;

interface SectionView { readonly key: string; readonly position: number; readonly title: string; readonly required: boolean; readonly text: { text: string; spans: unknown[] } }
interface PageView { readonly page: string; readonly title: string; readonly rev: number; readonly sections: SectionView[]; readonly preview: string }
interface HistoryEntry { readonly point: string; readonly kind: string; readonly memberId: ULID | null; readonly reason?: string | null; readonly changes?: { field: string; before: unknown; after: unknown }[]; readonly values?: Record<string, unknown> }

const get = (by: string, page: string) => call(api, bindings, by, 'GET', `/policy/${page}`);
const put = (by: string, page: string, body: unknown) => call(api, bindings, by, 'PUT', `/policy/${page}`, body);
const historyOf = async (page: string) => (await (await call(api, bindings, admin, 'GET', `/policy/${page}/history`)).json<{ history: HistoryEntry[] }>()).history;
const activity = async () => (await core().prepare("SELECT kind, actor_id AS actorId, target_type AS targetType, target_id AS targetId FROM activity ORDER BY id").all<{ kind: string; actorId: ULID; targetType: string; targetId: string }>()).results;
const outboxScopes = async () => (await core().prepare('SELECT topic, scope FROM outbox ORDER BY seq').all<{ topic: string; scope: string }>()).results;
const revisions = async () => (await core().prepare("SELECT kind, reason, prev FROM revisions WHERE target_type = 'policy_page' ORDER BY seq").all<{ kind: string; reason: string | null; prev: string }>()).results;

/** The seeded Policy_Sections and page rev restored to their initial state, so each test starts clean. */
async function reseedPolicy(): Promise<void> {
  const statements = [
    core().prepare('DELETE FROM policy_sections'),
    core().prepare('DELETE FROM revisions'),
    core().prepare('DELETE FROM activity'),
    core().prepare('DELETE FROM outbox'),
    core().prepare("UPDATE policy_pages SET rev = 1, sections_changed_at = ?1, actor_id = NULL, updated_seq = 0").bind(at),
  ];
  const byPage = new Map<string, typeof SEED_POLICY_SECTIONS[number][]>();
  for (const section of SEED_POLICY_SECTIONS) (byPage.get(section.pageKey) ?? byPage.set(section.pageKey, []).get(section.pageKey)!).push(section);
  for (const [, sections] of byPage) {
    sections.forEach((section, position) => {
      statements.push(core().prepare(
        'INSERT INTO policy_sections (page_key, section_key, position, title, required, text, text_spans, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
      ).bind(section.pageKey, section.sectionKey, position, section.title, section.required ? 1 : 0, section.text, '[]', at));
    });
  }
  await core().batch(statements);
}

/** A full edit body: every required section keeps its stored text, with the overrides applied. */
function fullEdit(page: PageView, overrides: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rev: page.rev, mark: { mark: 'minor_edit' }, ...extra,
    sections: page.sections.map((section) => ({ key: section.key, text: { text: overrides[section.key] ?? section.text.text, spans: [] } })),
  };
}

beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});
beforeEach(async () => {
  await resetPeople(core());
  await reseedPolicy();
  adminId = await addMember(core(), 'admin@example.test', 'active', at, ROLE_IDS.administrator);
  await addMember(core(), 'contributor@example.test', 'active', at);
  api = testApi(access, new KeyServer(access), t0, { contentLicence: 'Synthetic Licence 1.0' });
  admin = await token('admin@example.test');
  contributor = await token('contributor@example.test');
  await core().prepare('DELETE FROM outbox').run();
});

describe('reading a Policy_Page', () => {
  it('returns the fixed sections in order and a preview rendered as the Public_Site shows it', async () => {
    const response = await get(contributor, 'corrections');
    expect(response.status).toBe(200);
    const page = await response.json<PageView>();
    expect(page.page).toBe('corrections');
    expect(page.title).toBe('Corrections');
    expect(page.rev).toBe(1);
    expect(page.sections.map((section) => section.key)).toEqual(['asking_for_a_correction', 'asking_for_a_removal_or_about_personal_data', 'what_happens_next']);
    expect(page.sections.map((section) => section.position)).toEqual([0, 1, 2]);
    // The preview is the whole public page: the section text and the fixed Response_Target statement appear in it.
    expect(page.preview).toContain('<h1>Corrections</h1>');
    expect(page.preview).toContain(SEED_POLICY_SECTIONS.find((s) => s.sectionKey === 'what_happens_next')!.text);
    expect(page.preview).toContain('Ask for a correction');
  });

  it('answers an unknown page key with not found', async () => {
    expect((await get(admin, 'nope')).status).toBe(404);
  });
});

describe('editing a Policy_Page', () => {
  it('applies a Minor_Edit after the preview is confirmed, records one Revision, Activity entry, and publish row', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const response = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'We reply within the response target.' }));
    expect(response.status).toBe(200);
    const saved = await response.json<PageView>();
    expect(saved.rev).toBe(2);
    expect(saved.sections.find((s) => s.key === 'what_happens_next')!.text.text).toBe('We reply within the response target.');
    expect(saved.preview).toContain('We reply within the response target.');
    // Exactly one Revision, one Activity_Feed entry linking to the page's history, and one publish outbox row.
    expect(await revisions()).toEqual([{ kind: 'minor_edit', reason: null, prev: JSON.stringify({ what_happens_next: { text: SEED_POLICY_SECTIONS.find((s) => s.sectionKey === 'what_happens_next')!.text, spans: [] } }) }]);
    expect(await activity()).toEqual([{ kind: 'policy_change', actorId: adminId, targetType: 'policy_page', targetId: 'corrections' }]);
    expect(await outboxScopes()).toEqual([{ topic: 'publish', scope: 'policy:corrections' }]);
  });

  it('records a Correction with its reason and shows it in the history and comparison', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const seeded = SEED_POLICY_SECTIONS.find((s) => s.sectionKey === 'asking_for_a_correction')!.text;
    await put(admin, 'corrections', fullEdit(page, { asking_for_a_correction: 'Send corrections through the public form.' }, { mark: { mark: 'correction', reason: 'Clarified the process.' } }));
    const entries = await historyOf('corrections');
    expect(entries[0]).toMatchObject({ kind: 'correction', memberId: adminId, reason: 'Clarified the process.' });
    expect(entries[0]!.changes).toEqual([{ field: 'asking_for_a_correction', before: { text: seeded, spans: [] }, after: { text: 'Send corrections through the public form.', spans: [] } }]);
    expect(entries.at(-1)).toMatchObject({ kind: 'creation', values: expect.any(Object) });
    // Comparing the creation to the Revision shows the one changed section, with both values.
    const latest = await (await call(api, bindings, admin, 'GET', `/policy/corrections/compare?from=creation&to=${entries[0]!.point}`)).json<{ from: string; to: string; changes: { field: string; before: unknown; after: unknown }[] }>();
    expect(latest.changes).toEqual([{ field: 'asking_for_a_correction', before: { text: seeded, spans: [] }, after: { text: 'Send corrections through the public form.', spans: [] } }]);
  });

  it('refuses a missing Minor_Edit/Correction mark, keeping the page and listing no new Revision', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const body = fullEdit(page, { what_happens_next: 'Changed.' });
    delete (body as Record<string, unknown>)['mark'];
    const response = await put(admin, 'corrections', body);
    expect(response.status).toBe(422);
    expect((await response.json<{ fields: { field: string }[] }>()).fields.some((f) => f.field === 'mark')).toBe(true);
    expect((await (await get(admin, 'corrections')).json<PageView>()).rev).toBe(1);
    expect(await revisions()).toEqual([]);
  });

  it('refuses a Correction with a blank or over-long reason', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const blank = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'Changed.' }, { mark: { mark: 'correction', reason: '   ' } }));
    expect(blank.status).toBe(422);
    const long = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'Changed.' }, { mark: { mark: 'correction', reason: 'x'.repeat(1001) } }));
    expect(long.status).toBe(422);
    expect((await (await get(admin, 'corrections')).json<PageView>()).rev).toBe(1);
  });

  it('refuses an empty required section, keeping the input unapplied', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const response = await put(admin, 'corrections', fullEdit(page, { what_happens_next: '   ' }));
    expect(response.status).toBe(422);
    expect((await response.json<{ fields: { field: string; rule: string }[] }>()).fields.some((f) => /required Policy Section/u.test(f.rule))).toBe(true);
    expect((await (await get(admin, 'corrections')).json<PageView>()).sections.find((s) => s.key === 'what_happens_next')!.text.text).not.toBe('   ');
  });

  it('allows an optional section to be emptied', async () => {
    const page = await (await get(admin, 'people')).json<PageView>();
    const response = await put(admin, 'people', fullEdit(page, { introduction: '' }));
    expect(response.status).toBe(200);
    expect((await response.json<PageView>()).sections.find((s) => s.key === 'introduction')!.text.text).toBe('');
  });

  it('refuses a section longer than 20,000 code points', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const response = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'a'.repeat(20_001) }));
    expect(response.status).toBe(422);
    expect((await response.json<{ fields: { field: string }[] }>()).fields.some((f) => f.field.endsWith('.text'))).toBe(true);
    // The boundary length is accepted.
    const atLimit = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'a'.repeat(20_000) }));
    expect(atLimit.status).toBe(200);
  });

  it('refuses a conflicting base rev, keeping the input and listing the Revisions since', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'First change.' }));
    // A second save from the stale rev 1 conflicts.
    const stale = await put(admin, 'corrections', fullEdit(page, { what_happens_next: 'Second change.' }));
    expect(stale.status).toBe(409);
    const body = await stale.json<{ error: string; details: { rev: number; revisions: { kind: string }[] } }>();
    expect(body.error).toBe('conflict');
    expect(body.details.rev).toBe(2);
    expect(body.details.revisions.map((r) => r.kind)).toEqual(['minor_edit']);
    expect((await (await get(admin, 'corrections')).json<PageView>()).sections.find((s) => s.key === 'what_happens_next')!.text.text).toBe('First change.');
  });

  it('cannot add, remove, rename, or reorder sections', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    // Adding an unknown section key.
    const added = await put(admin, 'corrections', { rev: page.rev, mark: { mark: 'minor_edit' }, sections: [...page.sections.map((s) => ({ key: s.key, text: s.text })), { key: 'invented', text: { text: 'Nope.', spans: [] } }] });
    expect(added.status).toBe(422);
    expect((await added.json<{ fields: { rule: string }[] }>()).fields.some((f) => /added, removed, renamed, or reordered/u.test(f.rule))).toBe(true);
    // Removing a section (omitting one).
    const removed = await put(admin, 'corrections', { rev: page.rev, mark: { mark: 'minor_edit' }, sections: page.sections.slice(1).map((s) => ({ key: s.key, text: s.text })) });
    expect(removed.status).toBe(422);
    expect((await removed.json<{ fields: { rule: string }[] }>()).fields.some((f) => /is missing/u.test(f.rule))).toBe(true);
    // The response always keeps the fixed titles and order; a rename is not expressible (titles come from the store).
    const saved = await put(admin, 'corrections', fullEdit(page, {}));
    expect(saved.status).toBe(200);
    const after = await (await get(admin, 'corrections')).json<PageView>();
    expect(after.sections.map((s) => [s.key, s.title, s.position])).toEqual(page.sections.map((s) => [s.key, s.title, s.position]));
  });

  it('refuses a non-Administrator', async () => {
    const page = await (await get(contributor, 'corrections')).json<PageView>();
    const response = await put(contributor, 'corrections', fullEdit(page, { what_happens_next: 'Changed.' }));
    expect(response.status).toBe(403);
    expect(await revisions()).toEqual([]);
  });

  it('answers an unchanged save without a Revision', async () => {
    const page = await (await get(admin, 'corrections')).json<PageView>();
    const response = await put(admin, 'corrections', fullEdit(page, {}));
    expect(response.status).toBe(200);
    expect((await response.json<PageView>()).rev).toBe(1);
    expect(await revisions()).toEqual([]);
    expect(await outboxScopes()).toEqual([]);
  });

  it('scrubs registered Member addresses from the preview as the Public_Site does', async () => {
    const page = await (await get(admin, 'people')).json<PageView>();
    const response = await put(admin, 'people', fullEdit(page, { introduction: 'Write to admin@example.test for details.' }));
    expect(response.status).toBe(200);
    const saved = await response.json<PageView>();
    // The stored text keeps the address; the preview replaces it.
    expect(saved.sections.find((s) => s.key === 'introduction')!.text.text).toContain('admin@example.test');
    expect(saved.preview).toContain('[email address removed]');
    expect(saved.preview).not.toContain('admin@example.test');
  });
});
