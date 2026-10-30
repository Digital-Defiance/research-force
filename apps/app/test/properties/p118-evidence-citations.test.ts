// Feature: research-collab-cms, Property 118: Evidence citations retain version identity and safe locators
import { describe, expect, it } from 'vitest';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { newULID } from '@researchforce/domain/identifiers';
import { errorOf, itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';

/**
 * Validates R54.1 to R54.6 against an independent model. One finding cites a Source and a text through random sequences of citations (with
 * locators that are valid, reversed, out of range, cutting a character in two or of the wrong type for the target), edits of the cited Source
 * and text, removals, attempts by a Member who may not edit, and loss of read access to the Source. After every step what each Member lists and
 * exports is exactly the model's set of citations whose ends that Member can read, each with the locator it was made with, the content hash it
 * recorded and the state the model predicts; a refused step changes nothing; and a Member who cannot read the Source sees no trace of it.
 */
type Target = 'source' | 'text';
interface Locator { readonly type: string; readonly [key: string]: unknown }
// The words the cited text takes in turn. The first holds a character outside the Basic Multilingual Plane, so offsets 2 and 4 cut it.
const TEXTS = ['a😀b tile', 'x'] as const;
const LOCATORS: readonly Locator[] = [
  { type: 'page', from: 2 }, { type: 'page', from: 3, to: 2 }, { type: 'folio', from: { number: 4, side: 'v' } },
  { type: 'text_range', start: 0, end: 1 }, { type: 'text_range', start: 1, end: 3 }, { type: 'text_range', start: 2, end: 4 }, { type: 'text_range', start: 0, end: 9 },
  { type: 'section', section: 'Chapter 2', paragraph: 3 }, { type: 'unresolved', text: 'in the second box' }, { type: 'image_region', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
];
const ROLES = ['supports', 'contradicts', 'background', 'method'] as const;

// Written out again here, not imported, so a change to the domain rule must be a deliberate change of this model too.
function validLocator(locator: Locator, target: Target, text: string): boolean {
  switch (locator.type) {
    case 'page': return target === 'source' && (locator['to'] === undefined || (locator['to'] as number) >= (locator['from'] as number));
    case 'folio': return target === 'source';
    case 'section': case 'unresolved': return true;
    case 'image_region': return false;
    case 'text_range': {
      if (target !== 'text') return false;
      const start = locator['start'] as number;
      const end = locator['end'] as number;
      if (end <= start || end > text.length) return false;
      const boundaries = new Set<number>([0]);
      let offset = 0;
      for (const character of text) { offset += character.length; boundaries.add(offset); }
      return boundaries.has(start) && boundaries.has(end);
    }
    default: return false;
  }
}

interface Cited { id: string; target: Target; locator: Locator; role: string; hash: string; state: 'current' | 'earlier_version'; retired: boolean }
interface Model { text: string; textStep: number; edition: number; hidden: boolean; cited: Cited[] }
type Op =
  | { t: 'cite'; who: 'author' | 'colleague'; target: Target; locator: number; role: typeof ROLES[number] }
  | { t: 'editSource' } | { t: 'editText' } | { t: 'retire'; who: 'author' | 'colleague'; index: number } | { t: 'hide' };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('cite' as const), who: fc.constantFrom('author' as const, 'author' as const, 'colleague' as const), target: fc.constantFrom<Target>('source', 'text'),
    locator: fc.integer({ min: 0, max: LOCATORS.length - 1 }), role: fc.constantFrom(...ROLES) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('editSource' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('editText' as const) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('retire' as const), who: fc.constantFrom('author' as const, 'colleague' as const), index: fc.nat(5) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('hide' as const) }) },
);

const world = itemWorld();
interface Listed { citations: { id: string; state: string; role: string; locator: Locator; contentHash: string }[] }
interface Exported { citations: { id: string; state: string; role: string; locator: Locator; contentHash: string }[] }

describe('Property 118: Evidence citations retain version identity and safe locators', () => {
  it('matches an independent model after every step, changes nothing on a refusal, and shows each Member only the ends they can read', async () => {
    let run = 0;
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
      run += 1;
      const finding = await world.created('author', 'finding', { title: `Finding ${run}` });
      const source = await world.created('author', 'source', { title: `Source ${run}` });
      const topic = await world.created('author', 'topic', { title: `Topic ${run}`, body: rich(TEXTS[0]) });
      const model: Model = { text: TEXTS[0], textStep: 0, edition: 0, hidden: false, cited: [] };
      const ids = { finding: finding.id as string, source: source.id as string, topic: topic.id as string };
      const targetBody = (target: Target) => (target === 'source' ? { type: 'source', unitId: ids.source } : { type: 'text', unitId: ids.topic, field: 'body' });
      const visible = (viewer: Who) => model.cited.filter((entry) => !entry.retired && !(viewer === 'colleague' && model.hidden && entry.target === 'source'));
      const rowCount = async () => (await world.core().prepare('SELECT count(*) AS n FROM evidence_citations').first<number>('n'))!;
      const listed = async (viewer: Who): Promise<Listed> => (await world.request(viewer, 'GET', `/citations?citingRootId=${ids.finding}`)).json<Listed>();
      const exported = async (viewer: Who): Promise<Exported> => (await world.request(viewer, 'GET', `/citations/export?citingRootId=${ids.finding}`)).json<Exported>();
      const verify = async (label: string) => {
        for (const viewer of ['author', 'colleague'] as const) {
          const expected = visible(viewer);
          const shown = await listed(viewer);
          const ordered = [...shown.citations].sort((a, b) => (a.id < b.id ? -1 : 1));
          expect(ordered.map((entry) => entry.id), `${label}: ${viewer} lists`).toEqual(expected.map((entry) => entry.id).sort());
          for (const entry of shown.citations) {
            const mine = expected.find((candidate) => candidate.id === entry.id)!;
            expect(entry.locator, `${label}: locator of ${entry.id}`).toEqual(mine.locator);
            expect([entry.role, entry.contentHash, entry.state], `${label}: role, hash and state of ${entry.id}`).toEqual([mine.role, mine.hash, mine.state]);
          }
          const document = await exported(viewer);
          expect(document.citations.map((entry) => entry.id).sort(), `${label}: ${viewer} exports`).toEqual(expected.map((entry) => entry.id).sort());
          for (const entry of document.citations) expect(entry.locator).toEqual(expected.find((candidate) => candidate.id === entry.id)!.locator);
          if (viewer === 'colleague' && model.hidden) {
            expect(JSON.stringify([shown, document]), `${label}: a hidden Source leaves no trace`).not.toContain(ids.source);
          }
        }
      };
      const snapshot = async () => JSON.stringify([await rowCount(), await listed('author')]);
      await verify('start');
      for (const [index, op] of ops.entries()) {
        const label = `step ${index} ${JSON.stringify(op)}`;
        if (op.t === 'hide') {
          await world.core().prepare("UPDATE research_items SET access_level = 'restricted' WHERE unit_id = ?1").bind(ids.source).run();
          model.hidden = true;
        } else if (op.t === 'editSource') {
          const rev = (await world.view('author', ids.source))['rev'];
          model.edition += 1;
          const response = await world.edit('author', ids.source, { rev, mark: { mark: 'correction', reason: 'Edition.' }, bibliography: { creators: [{ name: 'J. Doe', role: 'author' }], edition: `${model.edition}th` } });
          expect(response.status, `${label} -> ${response.status}`).toBe(200);
          for (const entry of model.cited) if (entry.target === 'source' && !entry.retired) entry.state = 'earlier_version';
        } else if (op.t === 'editText') {
          const rev = (await world.view('author', ids.topic))['rev'];
          model.textStep += 1;
          model.text = TEXTS[model.textStep % 2]!;
          const response = await world.edit('author', ids.topic, { rev, mark: { mark: 'correction', reason: 'Wording.' }, body: rich(model.text) });
          expect(response.status, `${label} -> ${response.status}`).toBe(200);
          for (const entry of model.cited) if (entry.target === 'text' && !entry.retired) entry.state = 'earlier_version';
        } else if (op.t === 'retire') {
          const active = model.cited.filter((entry) => !entry.retired);
          const picked = active.length === 0 ? undefined : active[op.index % active.length];
          if (picked === undefined) continue;
          const before = await snapshot();
          const response = await world.request(op.who, 'DELETE', `/citations/${picked.id}`);
          expect(response.status === 200, `${label} -> ${response.status}`).toBe(op.who === 'author');
          if (op.who === 'author') picked.retired = true; else expect(await snapshot(), `${label} refused but changed something`).toBe(before);
        } else {
          const locator = LOCATORS[op.locator]!;
          const allowed = op.who === 'author' && validLocator(locator, op.target, model.text);
          const before = await snapshot();
          const response = await world.request(op.who, 'POST', '/citations', { citingUnitId: ids.finding, citingField: 'claim', target: targetBody(op.target), role: op.role, locator });
          expect(response.status === 201, `${label} -> ${response.status}`).toBe(allowed);
          if (allowed) {
            const created = (await response.json<{ citation: { id: string; state: string; contentHash: string; locator: Locator } }>()).citation;
            expect(created.state).toBe('current');
            expect(created.locator).toEqual(locator);
            model.cited.push({ id: created.id, target: op.target, locator, role: op.role, hash: created.contentHash, state: 'current', retired: false });
          } else expect(await snapshot(), `${label} refused but changed something`).toBe(before);
        }
        await verify(label);
      }
    }), { numRuns: Math.min(FC_RUNS, 25) });
  }, 280_000);
});

describe('legacy label text without a mapping (R54.4)', () => {
  it('stays as written and unresolved until a citation is made, and a citation never rewrites it', async () => {
    const finding = await world.created('author', 'finding', { claim: rich('Müller says so', [{ k: 'quote', s: 0, e: 6, source: 'Müller 1944' }]) });
    const references = async () => (await (await world.request('colleague', 'GET', `/citations/references/${finding.id as string}`)).json<{ references: { source: string; text: string }[] }>()).references;
    expect(await references()).toMatchObject([{ source: 'Müller 1944', text: 'Müller' }]);
    const source = await world.created('author', 'source');
    const response = await world.request('author', 'POST', '/citations', { citingUnitId: finding.id, citingField: 'claim', target: { type: 'source', unitId: source.id }, role: 'supports', locator: { type: 'unresolved', text: 'p. 12 or so' } });
    expect(response.status).toBe(201);
    // Citing a Source does not map the words of the label to it: the label keeps naming its source in words.
    expect(await references()).toMatchObject([{ source: 'Müller 1944', text: 'Müller' }]);
    expect((await world.view('author', finding.id as string))['claim']).toMatchObject({ text: 'Müller says so', spans: [{ source: 'Müller 1944' }] });
  });
});

describe('maximum encoded input (R54.2, R54.3)', () => {
  const cite = (locator: unknown, target: Record<string, unknown>, citing: ItemView) => world.request('author', 'POST', '/citations', { citingUnitId: citing.id, citingField: 'claim', target, role: 'method', locator });

  it('accepts an unresolved locator of 1,000 code points of ordinary text, refuses 1,001, and refuses astral text too big to store with a 422 rather than a failure', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const target = { type: 'source', unitId: source.id };
    expect((await errorOf(await cite({ type: 'unresolved', text: 'é'.repeat(1001) }, target, finding))).status).toBe(422);
    const accepted = await cite({ type: 'unresolved', text: 'é'.repeat(1000) }, target, finding);
    expect(accepted.status).toBe(201);
    expect((await accepted.json<{ citation: { locator: { text: string } } }>()).citation.locator.text).toBe('é'.repeat(1000));
    // 1,000 characters of four bytes each, with the locator's own keys, is more than the 4,000 bytes a locator is stored in.
    const tooBig = await errorOf(await cite({ type: 'unresolved', text: '𝒜'.repeat(1000) }, target, finding));
    expect(tooBig.status).toBe(422);
    expect(tooBig.fields?.[0]?.field).toBe('locator.text');
    const fits = await cite({ type: 'unresolved', text: '𝒜'.repeat(990) }, target, finding);
    expect(fits.status).toBe(201);
    expect((await fits.json<{ citation: { locator: { text: string } } }>()).citation.locator.text).toBe('𝒜'.repeat(990));
  });

  it('accepts a section of 200 code points and refuses 201', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const target = { type: 'source', unitId: source.id };
    expect((await cite({ type: 'section', section: '😀'.repeat(201) }, target, finding)).status).toBe(422);
    expect((await cite({ type: 'section', section: '😀'.repeat(200) }, target, finding)).status).toBe(201);
  });

  it('accepts a text range at the very end of a long text and refuses one a unit beyond it', async () => {
    const long = '😀'.repeat(5000);
    const topic = await world.created('author', 'topic', { body: rich(long) });
    const finding = await world.created('author', 'finding');
    const target = { type: 'text', unitId: topic.id, field: 'body' };
    expect((await cite({ type: 'text_range', start: 0, end: 10_001 }, target, finding)).status).toBe(422);
    expect((await cite({ type: 'text_range', start: 9998, end: 10_000 }, target, finding)).status).toBe(201);
    expect((await cite({ type: 'text_range', start: 9999, end: 10_000 }, target, finding)).status).toBe(422);
  });

  it('refuses the 1,001st active citation of a record and keeps every one of the 1,000 exact', async () => {
    const source = await world.created('author', 'source');
    const finding = await world.created('author', 'finding');
    const rows = Array.from({ length: 1000 }, (_unused, index) => ({ id: newULID(world.at), cu: finding.id, target: source.id, locator: JSON.stringify({ type: 'page', from: index + 1 }) }));
    await world.core().prepare(`INSERT INTO evidence_citations (id, citing_unit_id, citing_root_id, citing_field, target_type, target_unit_id, target_root_id, target_rev, content_hash, role, locator_type, locator_json, created_by, created_at, updated_seq)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.cu'), json_extract(value, '$.cu'), 'claim', 'source', json_extract(value, '$.target'), json_extract(value, '$.target'), 1, ?2, 'supports', 'page', json_extract(value, '$.locator'), ?3, ?4, 0
      FROM json_each(?1)`).bind(JSON.stringify(rows), 'a'.repeat(64), world.ids.author, world.at).run();
    const over = await errorOf(await cite({ type: 'page', from: 1001 }, { type: 'source', unitId: source.id }, finding));
    expect(over.status).toBe(422);
    const page = await (await world.request('author', 'GET', `/citations?citingRootId=${finding.id as string}&limit=100`)).json<{ citations: { id: string; contentHash: string }[]; next: string | null }>();
    expect(page.citations).toHaveLength(100);
    expect(page.next).not.toBeNull();
    expect(page.citations.every((entry) => entry.contentHash === 'a'.repeat(64))).toBe(true);
  }, 120_000);
});
