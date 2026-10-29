import { describe, expect, it } from 'vitest';
import { assertPayloadBudget } from '@researchforce/domain/resource-profile';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { fieldFragments, fieldManifest } from '@researchforce/domain/text-fragments';
import type { FieldFragment, FieldReference } from '@researchforce/domain/text-fragments';
import { errorOf, itemBody, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';

const world = itemWorld();
type Uploaded = { part: number; sections: number; fields: { ordinal: number; id: string; reference: FieldReference }[] };
const metadata = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const { sections: _sections, ...rest } = itemBody('journal_entry', world.projectId, overrides);
  return rest;
};
const sectionContents = (item: ItemView) => (item['sections'] as { id: string; content: RichText }[]);
const counts = async () => JSON.stringify((await world.core().batch(['units', 'research_items', 'entry_sections', 'submissions', 'revisions']
  .map((table) => world.core().prepare(`SELECT count(*) AS n FROM ${table}`)))).map((result) => result.results));

async function open(who: Who, body: Record<string, unknown> = {}): Promise<string> {
  const response = await world.request(who, 'POST', '/stages', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ token: string }>()).token;
}
const putPart = (who: Who, token: string, part: number, sections: readonly unknown[]) => world.request(who, 'PUT', `/stages/${token}/parts/${part}`, { sections });
const putFragment = (who: Who, token: string, part: number, ordinal: number, fragment: FieldFragment) =>
  world.request(who, 'PUT', `/stages/${token}/parts/${part}/sections/${ordinal}/fragments`, fragment);
const commit = (who: Who, token: string, body: Record<string, unknown>) => world.request(who, 'POST', `/stages/${token}/commit`, body);

/** Send one logical section: its manifest in a part, then every fragment, optionally stopping early or sending a fragment twice. */
async function sendField(who: Who, token: string, part: number, content: RichText, options: { id?: string; stopAfter?: number; replay?: boolean } = {}): Promise<Uploaded> {
  const manifest = fieldManifest(content);
  const response = await putPart(who, token, part, [{ ...(options.id ? { id: options.id } : {}), field: manifest }]);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  const uploaded = await response.json<Uploaded>();
  let sent = 0;
  for (const fragment of fieldFragments(content)) {
    if (options.stopAfter !== undefined && sent >= options.stopAfter) break;
    for (let attempt = 0; attempt < (options.replay ? 2 : 1); attempt++) {
      const stored = await putFragment(who, token, part, 0, fragment);
      if (stored.status !== 200) throw new Error(`${stored.status} ${await stored.text()}`);
    }
    sent++;
  }
  return uploaded;
}
const total = async (table: string) => (await world.core().prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'))!;
const physicalLimit = 512_000;
async function largestRows(): Promise<Record<string, number>> {
  const longest = async (sqlText: string) => (await world.core().prepare(sqlText).first<number>('n')) ?? 0;
  return {
    staging: await longest('SELECT max(length(CAST(payload AS BLOB))) AS n FROM staging_rows'),
    sections: await longest('SELECT max(length(CAST(text AS BLOB)) + length(CAST(text_spans AS BLOB))) AS n FROM entry_sections'),
    revisions: await longest('SELECT max(length(CAST(prev AS BLOB))) AS n FROM revisions'),
    manifests: await longest('SELECT max(length(CAST(manifest_json AS BLOB))) AS n FROM field_versions'),
    fragments: await longest('SELECT max(length(CAST(payload_json AS BLOB))) AS n FROM text_fragments'),
  };
}
const expectBounded = async () => { for (const [name, bytes] of Object.entries(await largestRows())) expect(bytes, name).toBeLessThanOrEqual(physicalLimit); };

describe('logical-field staged saves of one large Entry_Section', () => {
  it.each([
    ['600,000 ASCII characters', 'a'.repeat(600_000)],
    ['600,000 emoji', '😀'.repeat(600_000)],
    ['two million code points', 'Zweiundzwanzig, naïve — ☃ '.repeat(80_000).slice(0, 2_000_000)],
  ])('commits %s exactly, with no row above the physical budget', async (_name, text) => {
    const content = rich(text);
    const token = await open('author');
    await sendField('author', token, 1, content);
    const saved = await commit('author', token, metadata());
    expect(saved.status, await saved.clone().text()).toBe(201);
    const { item } = await saved.json<{ item: ItemView }>();
    const [section] = sectionContents(item);
    expect(sectionContents(item)).toHaveLength(1);
    expect(section!.content.text === text).toBe(true);
    expect(section!.content.spans).toEqual([]);
    await expectBounded();
    expect((await world.view('author', item.id))['sections']).toEqual(item['sections']);
  }, 120_000);

  it('keeps label spans exact across fragment boundaries', async () => {
    const text = 'q'.repeat(300_000);
    const spans: Span[] = [
      { k: 'quote', s: 0, e: 10, source: 'S1' },
      { k: 'paraphrase', s: 127_990, e: 128_010, source: 'S2' },
      { k: 'lang', s: 255_990, e: 256_040, lang: 'de' },
      { k: 'source_reported', s: 299_990, e: 300_000, source: 'S3' },
    ];
    const content = rich(text, spans);
    expect(fieldManifest(content).fragments.filter((piece) => piece.kind === 'text').length).toBeGreaterThan(2);
    const token = await open('author');
    await sendField('author', token, 1, content);
    const { item } = await (await commit('author', token, metadata())).json<{ item: ItemView }>();
    const [section] = sectionContents(item);
    expect(section!.content.text === text).toBe(true);
    expect(section!.content.spans).toEqual(spans);
  });

  it('splits by the encoded JSON size, so heavily escaped text still fits every fragment', async () => {
    const text = '"\\\n\u0001'.repeat(60_000);
    const fragments = [...fieldFragments(rich(text))];
    expect(fragments.length).toBeGreaterThan(5);
    for (const fragment of fragments) expect(() => assertPayloadBudget(fragment, 'fragment')).not.toThrow();
    const token = await open('author');
    await sendField('author', token, 1, rich(text));
    const { item } = await (await commit('author', token, metadata())).json<{ item: ItemView }>();
    expect(sectionContents(item)[0]!.content.text === text).toBe(true);
    await expectBounded();
  });

  it('mixes inline sections and logical fields in one save, in part order', async () => {
    const big = rich('B'.repeat(700_000), [{ k: 'quote', s: 5, e: 9, source: 'S' }]);
    const token = await open('author');
    expect((await putPart('author', token, 2, [{ content: rich('Last, inline.') }])).status).toBe(200);
    await sendField('author', token, 1, big);
    const { item } = await (await commit('author', token, metadata())).json<{ item: ItemView }>();
    expect(sectionContents(item).map(({ content }) => content.text.length)).toEqual([700_000, 13]);
    expect(sectionContents(item)[0]!.content.spans).toEqual(big.spans);
  });
});

describe('crash and retry at every step', () => {
  it('reconciles a repeated open, a repeated part, and a repeated fragment without duplicating anything', async () => {
    const token = await open('author');
    expect((await world.request('author', 'POST', '/stages', { token })).status).toBe(201);
    expect((await world.request('author', 'POST', '/stages', { token, itemId: 'nope' })).status).not.toBe(201);
    const content = rich('r'.repeat(400_000));
    const versions = await total('field_versions');
    const first = await sendField('author', token, 1, content, { replay: true });
    const manifest = fieldManifest(content);
    const second = await (await putPart('author', token, 1, [{ field: manifest }])).json<Uploaded>();
    expect(second.fields[0]!.reference).toEqual(first.fields[0]!.reference);
    expect(await total('field_versions')).toBe(versions + 1);
    const saved = await commit('author', token, metadata());
    expect(saved.status).toBe(201);
  });

  it('refuses to commit until every fragment is present, naming the section, then succeeds once the rest arrive', async () => {
    const content = rich('c'.repeat(400_000));
    const token = await open('author');
    const before = await counts();
    await sendField('author', token, 1, content, { stopAfter: 2 });
    const refused = await errorOf(await commit('author', token, metadata()));
    expect(refused.status).toBe(422);
    expect(refused.fields?.[0]?.field).toBe('parts.1.sections.0.field');
    expect(await counts()).toBe(before);
    for (const fragment of fieldFragments(content)) expect((await putFragment('author', token, 1, 0, fragment)).status).toBe(200);
    expect((await commit('author', token, metadata())).status).toBe(201);
  });

  it('refuses a fragment that is not the manifest’s, a changed replay, and a fragment of another Member’s stage', async () => {
    const content = rich('d'.repeat(300_000));
    const token = await open('author');
    await sendField('author', token, 1, content, { stopAfter: 1 });
    const [first, second] = [...fieldFragments(content)] as [FieldFragment & { kind: 'text' }, FieldFragment & { kind: 'text' }];
    expect((await errorOf(await putFragment('author', token, 1, 0, { ...second, text: second.text.slice(0, -1) + 'X' }))).fields?.[0]?.field).toBe('fragment');
    expect((await errorOf(await putFragment('author', token, 1, 0, { ...first, ordinal: 9 }))).status).toBe(422);
    expect((await putFragment('colleague', token, 1, 0, second)).status).toBe(404);
    expect((await world.request('author', 'PUT', `/stages/${token}/parts/1/sections/5/fragments`, second)).status).toBe(404);
    expect((await putFragment('author', token, 1, 0, second)).status).toBe(200);
  });

  it('rejects a manifest that is inconsistent or too large and stores no field version', async () => {
    const token = await open('author');
    const versions = await total('field_versions');
    const manifest = fieldManifest(rich('m'.repeat(200_000)));
    for (const bad of [{ ...manifest, codePoints: manifest.codePoints + 1 }, { ...manifest, fragments: manifest.fragments.slice(1) }, { ...manifest, extra: 1 }]) {
      expect((await errorOf(await putPart('author', token, 1, [{ field: bad }]))).fields?.[0]?.field).toBe('sections.0.field');
    }
    expect(await total('field_versions')).toBe(versions);
  });

  it('answers a lost commit response from the stage’s receipt, saving the entry once', async () => {
    const token = await open('author');
    await sendField('author', token, 1, rich('s'.repeat(300_000)));
    expect(await (await world.request('author', 'GET', `/stages/${token}`)).json()).toEqual({ token, state: 'open' });
    const first = await commit('author', token, metadata());
    expect(first.status).toBe(201);
    const { item } = await first.json<{ item: ItemView }>();
    const afterFirst = await counts();
    expect(await (await world.request('author', 'GET', `/stages/${token}`)).json()).toEqual({ token, state: 'committed', itemId: item.id, rev: 1, status: 201 });
    const again = await commit('author', token, metadata({ title: 'Ignored on replay' }));
    expect(again.status).toBe(201);
    expect((await again.json<{ item: ItemView }>()).item).toEqual(item);
    expect(await counts()).toBe(afterFirst);
    expect((await putPart('author', token, 2, [{ content: rich('Late.') }])).status).toBe(409);
    expect((await world.request('colleague', 'GET', `/stages/${token}`)).status).toBe(404);
  });

  it('leaves nothing visible when the batch is refused after the fragments were stored', async () => {
    const token = await open('author');
    await sendField('author', token, 1, rich('v'.repeat(300_000)));
    const before = await counts();
    const current = await total('field_current');
    expect((await errorOf(await commit('author', token, metadata({ title: ' ' })))).fields?.map((issue) => issue.field)).toEqual(['title']);
    expect(await counts()).toBe(before);
    expect(await total('field_current')).toBe(current);
    expect((await commit('author', token, metadata())).status).toBe(201);
    expect(await total('field_current')).toBe(current + 1);
  });
});

describe('logical-field staged edits', () => {
  const four = { sections: ['One.', 'Two.', 'Three.', 'Four.'].map((text) => ({ content: rich(text) })) };

  it('replaces one section with a large field, keeps the others exact, and stores the old value as a bounded revision', async () => {
    const entry = await world.created('author', 'journal_entry', four);
    const [s1, s2, s3, s4] = sectionContents(entry).map((section) => section.id) as [string, string, string, string];
    const large = rich('E'.repeat(650_000), [{ k: 'quote', s: 127_999, e: 128_001, source: 'S' }]);
    const token = await open('author', { itemId: entry.id });
    expect((await putPart('author', token, 1, [{ id: s1, content: rich('One.') }, { id: s2, content: rich('Two.') }])).status).toBe(200);
    await sendField('author', token, 2, large, { id: s3 });
    expect((await putPart('author', token, 3, [{ id: s4, content: rich('Four.') }])).status).toBe(200);
    const saved = await commit('author', token, { rev: 1, mark: { mark: 'correction', reason: 'Synthetic correction.' } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const { item } = await saved.json<{ item: ItemView }>();
    expect(item.rev).toBe(2);
    expect(sectionContents(item).map((section) => section.id)).toEqual([s1, s2, s3, s4]);
    expect(sectionContents(item).map((section) => section.content.text.length)).toEqual([4, 4, 650_000, 5]);
    expect(sectionContents(item)[2]!.content.spans).toEqual(large.spans);
    expect(sectionContents(item)[0]!.content).toEqual(rich('One.'));
    const revisions = await world.core().prepare("SELECT count(*) AS n FROM revisions WHERE target_id = ?1").bind(entry.id).first('n');
    expect(revisions).toBe(1);
    await expectBounded();
  });

  it('saves nothing for an unchanged large field and keeps the existing one current', async () => {
    const entry = await world.created('author', 'journal_entry', { sections: [{ content: rich('Start.') }] });
    const id = sectionContents(entry)[0]!.id;
    const content = rich('U'.repeat(300_000));
    const first = await open('author', { itemId: entry.id });
    await sendField('author', first, 1, content, { id });
    expect((await commit('author', first, { rev: 1, mark: { mark: 'minor_edit' } })).status).toBe(200);
    const revisions = await world.core().prepare('SELECT count(*) AS n FROM revisions').first<number>('n');
    const second = await open('author', { itemId: entry.id });
    await sendField('author', second, 1, content, { id });
    const response = await commit('author', second, { rev: 2, mark: { mark: 'minor_edit' } });
    expect(response.status).toBe(200);
    const { item } = await response.json<{ item: ItemView }>();
    expect(item.rev).toBe(2);
    expect(await world.core().prepare('SELECT count(*) AS n FROM revisions').first('n')).toBe(revisions);
    expect(sectionContents(item)[0]!.content.text === content.text).toBe(true);
    expect(await (await world.request('author', 'GET', `/stages/${second}`)).json()).toMatchObject({ state: 'committed', itemId: entry.id, rev: 2, status: 200 });
  });

  it('refuses a stale edit after the fragments are stored and keeps the entry as it was', async () => {
    const entry = await world.created('author', 'journal_entry', { sections: [{ content: rich('Start.') }] });
    const id = sectionContents(entry)[0]!.id;
    const token = await open('author', { itemId: entry.id });
    await sendField('author', token, 1, rich('S'.repeat(250_000)), { id });
    expect((await world.edit('author', entry.id, { rev: 1, mark: { mark: 'minor_edit' }, title: 'Meanwhile' })).status).toBe(200);
    expect(await errorOf(await commit('author', token, { rev: 1, mark: { mark: 'minor_edit' } }))).toMatchObject({ status: 409, error: 'conflict' });
    const current = await world.view('author', entry.id);
    expect(sectionContents(current)[0]!.content).toEqual(rich('Start.'));
  });
});
