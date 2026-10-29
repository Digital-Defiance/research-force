// Feature: research-collab-cms, Property 109: Logical text fragments preserve valid fields across storage and history
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOURCE_PROFILE } from '@researchforce/domain/resource-profile';
import type { RichText, Span } from '@researchforce/domain/richtext';
import { validateSpans } from '@researchforce/domain/richtext';
import { isCodePointBoundary } from '@researchforce/domain/text';
import { fieldFragments, fieldManifest, fragmentDigest, fragmentText, readField, streamField, validateFieldManifest } from '@researchforce/domain/text-fragments';
import type { FieldFragment, FieldManifest, FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { drainSearch } from '../../src/search/indexer';
import type { SearchPage } from '../../src/search/query';
import { errorOf, itemBody, itemWorld, rich } from '../items';
import type { ItemView, Who } from '../items';

/**
 * Validates R4.10, R4.11, R11.10: for any allowed logical text and spans, physical and transport chunk boundaries (one oversized section, multi-byte
 * Unicode, heavy JSON escaping) change nothing about the text, offsets, identities, parsing, search phrase positions, history or atomic visibility, and
 * encoded pieces and manifests stay inside their budgets. The models below are written from the requirements, not from the splitter.
 */
const FRAGMENT_BYTES = DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment;
const ROW_BYTES = DEFAULT_RESOURCE_PROFILE.chosen.bytes.physicalRow;
const SPANS_PER_FIELD = DEFAULT_RESOURCE_PROFILE.chosen.logical.spansPerField;
const encoder = new TextEncoder();
const jsonBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

// ---- Generators ---------------------------------------------------------------------------------------------------------------------------
/** Code points of every UTF-8 width, a surrogate pair, line separators and the characters JSON must escape. */
const UNITS = ['a', 'é', '€', '😀', '𝒳', '"', '\\', '\n', '\u0001', ' ', 'ß', '한', ' '];
interface TextSpec { readonly recipe: readonly string[]; readonly repeats: number }
const textSpec = (repeats: readonly number[]) => fc.record({ recipe: fc.array(fc.constantFrom(...UNITS), { minLength: 1, maxLength: 4 }), repeats: fc.constantFrom(...repeats) });
const textOf = (spec: TextSpec): string => spec.recipe.join('').repeat(spec.repeats);

const KINDS = ['quote', 'lang', 'source_reported', 'paraphrase'] as const;
interface SpanSpec { readonly picks: readonly number[]; readonly edgeIndexes: readonly number[]; readonly deltas: readonly number[]; readonly kinds: readonly number[] }
const spanSpec = fc.record({
  picks: fc.array(fc.nat(2_000_000), { maxLength: 6 }), edgeIndexes: fc.array(fc.nat(40), { maxLength: 4 }),
  deltas: fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 4, maxLength: 4 }), kinds: fc.array(fc.nat(KINDS.length - 1), { minLength: 5, maxLength: 5 }),
});
const snap = (text: string, offset: number): number => { let at = Math.max(0, Math.min(text.length, offset)); while (!isCodePointBoundary(text, at)) at++; return at; };
/** Disjoint labels of mixed kinds, some of them straddling the points where an independent fragmenter cuts the text. */
function spansOf(text: string, spec: SpanSpec): Span[] {
  const edges = [...fragmentText(text)].map((fragment) => fragment.end).slice(0, -1);
  const points = [...spec.picks.map((pick) => snap(text, pick % (text.length + 1))), ...spec.edgeIndexes.filter(() => edges.length > 0).map((index, i) => snap(text, edges[index % edges.length]! + spec.deltas[i % spec.deltas.length]!))];
  const sorted = [...new Set(points)].sort((a, b) => a - b);
  const spans: Span[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 2) {
    const [s, e] = [sorted[i]!, sorted[i + 1]!];
    const kind = KINDS[spec.kinds[(i / 2) % spec.kinds.length]!]!;
    spans.push(kind === 'lang' ? { k: 'lang', s, e, lang: 'de' } : kind === 'source_reported' ? { k: 'source_reported', s, e } : { k: kind, s, e, source: 'Synthetic ß source' });
  }
  return spans;
}
const fieldArb = (repeats: readonly number[]) => fc.record({ text: textSpec(repeats), spans: spanSpec }).map(({ text, spans }): RichText => { const value = textOf(text); return { text: value, spans: spansOf(value, spans) }; });

// ---- An independent model of the stored field ---------------------------------------------------------------------------------------------
const manifests = new WeakMap<RichText, FieldManifest>();
const manifestOf = (value: RichText): FieldManifest => { let manifest = manifests.get(value); if (!manifest) { manifest = fieldManifest(value); manifests.set(value, manifest); } return manifest; };
function reference(manifest: FieldManifest): FieldReference { return { $fieldVersion: 1, id: 'F1', ownerType: 'unit', ownerId: 'U1', field: 'text', digest: fragmentDigest(manifest) }; }
function memory(value: RichText, edit: (fragments: FieldFragment[], manifest: FieldManifest) => { fragments: FieldFragment[]; manifest: FieldManifest } = (fragments, manifest) => ({ fragments, manifest })): { reader: FieldVersionReader; reference: FieldReference } {
  const manifest = manifestOf(value);
  const edited = edit([...fieldFragments(value)], manifest);
  return { reference: reference(manifest), reader: { manifest: () => Promise.resolve(edited.manifest), fragments: async function* () { for (const fragment of edited.fragments) yield fragment; } } };
}

describe('Property 109: Logical text fragments preserve valid fields across storage and history', () => {
  it('splits text into contiguous, in-budget pieces that never cut a code point and rebuild the exact field', async () => {
    await fc.assert(fc.asyncProperty(fieldArb([0, 1, 9, 5_000, 21_000, 22_000, 43_000, 64_000]).filter((value) => value.text.length > 0), async (value) => {
      expect(validateSpans(value)).toEqual([]);
      const fragments = [...fieldFragments(value)];
      const texts = fragments.filter((fragment) => fragment.kind === 'text');
      const spans = fragments.filter((fragment) => fragment.kind === 'spans');
      // The model of the cut: contiguous global UTF-16 ranges, whole code points, each piece's encoded JSON inside its budget.
      let at = 0;
      for (const [ordinal, piece] of texts.entries()) {
        expect(piece.ordinal).toBe(ordinal); expect(piece.start).toBe(at); expect(piece.text.length).toBe(piece.end - piece.start);
        expect(isCodePointBoundary(value.text, piece.start)).toBe(true); expect(isCodePointBoundary(value.text, piece.end)).toBe(true);
        at = piece.end;
      }
      expect(at).toBe(value.text.length);
      expect(texts.map((piece) => piece.text).join('') === value.text).toBe(true);
      expect(spans.flatMap((piece) => [...piece.spans])).toEqual(value.spans);
      for (const piece of fragments) expect(jsonBytes(piece)).toBeLessThanOrEqual(FRAGMENT_BYTES);
      const manifest = fieldManifest(value);
      expect(() => validateFieldManifest(manifest)).not.toThrow();
      expect(jsonBytes(manifest)).toBeLessThanOrEqual(ROW_BYTES);
      expect(manifest.utf16Length).toBe(value.text.length); expect(manifest.codePoints).toBe([...value.text].length); expect(manifest.spanCount).toBe(value.spans.length);
      expect(manifest.fragments.map((entry) => entry.kind)).toEqual(fragments.map((piece) => piece.kind));
      // Reading rebuilds exactly the same field; the streaming reader yields the same pieces.
      const { reader, reference: ref } = memory(value);
      const rebuilt = await readField(ref, reader);
      expect(rebuilt.text === value.text).toBe(true); expect(rebuilt.spans).toEqual(value.spans);
      const streamed: FieldFragment[] = []; for await (const piece of streamField(ref, reader)) streamed.push(piece);
      expect(streamed).toEqual(fragments);
    }), { numRuns: FC_RUNS });
  }, 600_000);

  it('never returns a changed field when storage drops, repeats, reorders or alters a piece, or the manifest is tampered with', async () => {
    const fault = fc.record({ kind: fc.constantFrom('drop', 'repeat', 'swap', 'alter', 'trim-manifest', 'wrong-digest', 'extra-fragment'), at: fc.nat(1000), other: fc.nat(1000) });
    await fc.assert(fc.asyncProperty(fieldArb([1, 9, 22_000, 43_000, 64_000]).filter((value) => value.text.length > 20 && manifestOf(value).fragments.length > 1), fault, async (value, injected) => {
      const clean = memory(value);
      const pieceCount = manifestOf(value).fragments.length;
      const index = injected.at % pieceCount;
      const faulty = memory(value, (fragments, manifest) => {
        const pieces = [...fragments];
        if (injected.kind === 'drop') pieces.splice(index, 1);
        else if (injected.kind === 'repeat') pieces.splice(index, 0, pieces[index]!);
        else if (injected.kind === 'swap') { const other = (index + 1 + (injected.other % (pieceCount - 1))) % pieceCount; [pieces[index], pieces[other]] = [pieces[other]!, pieces[index]!]; }
        else if (injected.kind === 'alter') {
          const piece = pieces[index]!;
          pieces[index] = piece.kind === 'text' ? { ...piece, text: (piece.text[0] === 'x' ? 'y' : 'x') + piece.text.slice(1) } : { ...piece, spans: piece.spans.map((span) => ({ ...span, e: span.e + 1 })) as typeof piece.spans };
        } else if (injected.kind === 'extra-fragment') pieces.push({ kind: 'text', ordinal: pieceCount, start: value.text.length, end: value.text.length + 1, text: 'x' });
        return { fragments: pieces, manifest: injected.kind === 'trim-manifest' ? { ...manifest, fragments: manifest.fragments.slice(0, -1) } : manifest };
      });
      const ref = injected.kind === 'wrong-digest' ? { ...faulty.reference, digest: fragmentDigest({ other: 1 }) } : faulty.reference;
      let outcome: 'rejected' | RichText;
      try { outcome = await readField(ref, faulty.reader); } catch { outcome = 'rejected'; }
      expect(outcome).toBe('rejected');
      let streamed = 'rejected';
      try { for await (const piece of streamField(ref, faulty.reader)) void piece; streamed = 'accepted'; } catch { /* rejected */ }
      expect(streamed).toBe('rejected');
      // The clean copy of the same field is still read exactly: the fault was in storage, not in the field.
      expect((await readField(clean.reference, clean.reader)).text === value.text).toBe(true);
    }), { numRuns: FC_RUNS });
  }, 600_000);

  it('holds at the maximum encoded inputs: two million escape-heavy code points, two million emoji, and 50,000 spans', async () => {
    for (const [unit, bytes] of [['\u0001', 6], ['😀', 4], ['"', 2]] as const) {
      const value = rich(unit.repeat(2_000_000));
      const fragments = [...fieldFragments(value)];
      expect(fragments.length).toBeGreaterThanOrEqual(Math.ceil(2_000_000 * bytes / FRAGMENT_BYTES));
      for (const piece of fragments) expect(jsonBytes(piece)).toBeLessThanOrEqual(FRAGMENT_BYTES);
      const { reader, reference: ref } = memory(value);
      expect((await readField(ref, reader)).text === value.text).toBe(true);
      expect(jsonBytes(fieldManifest(value))).toBeLessThanOrEqual(ROW_BYTES);
    }
    const spans: Span[] = Array.from({ length: SPANS_PER_FIELD }, (_, i) => ({ k: 'quote', s: i * 2, e: i * 2 + 1, source: 'S' }));
    const full = rich('ab'.repeat(SPANS_PER_FIELD), spans);
    const manifest = fieldManifest(full);
    expect(manifest.spanCount).toBe(SPANS_PER_FIELD); expect(jsonBytes(manifest)).toBeLessThanOrEqual(ROW_BYTES);
    const { reader, reference: ref } = memory(full);
    expect((await readField(ref, reader)).spans).toEqual(spans);
    expect(() => fieldManifest(rich('ab'.repeat(SPANS_PER_FIELD + 1), [...spans, { k: 'quote', s: SPANS_PER_FIELD * 2, e: SPANS_PER_FIELD * 2 + 1, source: 'S' }]))).toThrow();
  }, 300_000);
});

// ---- Stored through the Worker --------------------------------------------------------------------------------------------------------------
const world = itemWorld();
type Uploaded = { part: number; sections: number };
type SectionView = { id: string; content: RichText };
const sectionsOf = (item: ItemView): SectionView[] => item['sections'] as SectionView[];
const counts = async () => JSON.stringify((await world.core().batch(['units', 'research_items', 'entry_sections', 'submissions', 'revisions', 'field_current']
  .map((table) => world.core().prepare(`SELECT count(*) AS n FROM ${table}`)))).map((result) => result.results));
const open = async (who: Who, body: Record<string, unknown> = {}): Promise<string> => {
  const response = await world.request(who, 'POST', '/stages', body);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ token: string }>()).token;
};
const putFragment = (token: string, part: number, fragment: FieldFragment) => world.request('author', 'PUT', `/stages/${token}/parts/${part}/sections/0/fragments`, fragment);
const commit = (token: string, body: Record<string, unknown>) => world.request('author', 'POST', `/stages/${token}/commit`, body);
const metadata = (overrides: Record<string, unknown> = {}): Record<string, unknown> => { const { sections: _sections, ...rest } = itemBody('journal_entry', world.projectId, overrides); return rest; };

interface Sent { readonly id?: string; readonly content: RichText; readonly holdBack?: boolean; readonly replay?: boolean }
/** Send every section as a logical field (or inline when small) in part order; returns the pieces held back from the last section. */
async function stage(token: string, sections: readonly Sent[]): Promise<FieldFragment[]> {
  const held: FieldFragment[] = [];
  for (const [index, section] of sections.entries()) {
    const part = index + 1;
    const inline = section.content.text.length < 50 && section.content.spans.length === 0;
    const response = await world.request('author', 'PUT', `/stages/${token}/parts/${part}`, { sections: [{ ...(section.id ? { id: section.id } : {}), ...(inline ? { content: section.content } : { field: fieldManifest(section.content) }) }] });
    if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
    await response.json<Uploaded>();
    if (inline) continue;
    const pieces = [...fieldFragments(section.content)];
    for (const [i, piece] of pieces.entries()) {
      if (section.holdBack && i === pieces.length - 1 && pieces.length > 1) { held.push(piece); continue; }
      for (let attempt = 0; attempt < (section.replay ? 2 : 1); attempt++) {
        const stored = await putFragment(token, part, piece);
        if (stored.status !== 200) throw new Error(`${stored.status} ${await stored.text()}`);
      }
    }
  }
  return held;
}
const largestRow = async (): Promise<number> => Math.max(...await Promise.all([
  'SELECT max(length(CAST(payload AS BLOB))) AS n FROM staging_rows', 'SELECT max(length(CAST(text AS BLOB)) + length(CAST(text_spans AS BLOB))) AS n FROM entry_sections',
  'SELECT max(length(CAST(prev AS BLOB))) AS n FROM revisions', 'SELECT max(length(CAST(manifest_json AS BLOB))) AS n FROM field_versions', 'SELECT max(length(CAST(payload_json AS BLOB))) AS n FROM text_fragments',
].map(async (query) => (await world.core().prepare(query).first<number>('n')) ?? 0)));

describe('Property 109 through staged saves, history, search and access', () => {
  const sizes = [3, 400, 22_000, 43_000, 64_000];
  const sectionArb = fc.record({ field: fieldArb(sizes), replay: fc.boolean(), holdBack: fc.boolean() });
  const plan = fc.record({ sections: fc.array(sectionArb, { minLength: 1, maxLength: 3 }), refuseFirst: fc.boolean(), replacement: fieldArb(sizes), target: fc.nat(2) });

  it('keeps text, spans, identities and order exact through staged saves with replayed pieces, refused commits and a later edit, and keeps the old value in history', async () => {
    await fc.assert(fc.asyncProperty(plan, async (scenario) => {
      const sections = scenario.sections.map(({ field, replay }, i) => ({ content: field.text.length === 0 ? rich(`Section ${i}`) : field, replay, holdBack: i === scenario.sections.length - 1 && scenario.sections[i]!.holdBack }));
      const token = await open('author');
      const before = await counts();
      const held = await stage(token, sections);
      // Atomic visibility: nothing is visible while pieces are missing or the rest of the save is refused.
      if (held.length > 0) {
        expect((await errorOf(await commit(token, metadata()))).status).toBe(422);
        expect(await counts()).toBe(before);
        for (const piece of held) expect((await putFragment(token, sections.length, piece)).status).toBe(200);
      }
      if (scenario.refuseFirst) { expect((await errorOf(await commit(token, metadata({ title: ' ' })))).fields?.map((issue) => issue.field)).toEqual(['title']); expect(await counts()).toBe(before); }
      const saved = await commit(token, metadata());
      expect(saved.status, await saved.clone().text()).toBe(201);
      const { item } = await saved.json<{ item: ItemView }>();
      const stored = sectionsOf(item);
      expect(stored).toHaveLength(sections.length);
      for (const [i, section] of sections.entries()) { expect(stored[i]!.content.text === section.content.text).toBe(true); expect(stored[i]!.content.spans).toEqual(section.content.spans); }
      expect(new Set(stored.map((section) => section.id)).size).toBe(stored.length);
      expect(await largestRow()).toBeLessThanOrEqual(ROW_BYTES);
      expect(sectionsOf(await world.view('author', item.id))).toEqual(stored);
      // Edit one section with a new logical value: the others keep identity and content, and history still reconstructs the old state exactly.
      const target = scenario.target % stored.length;
      const replacement = scenario.replacement.text.length === 0 ? rich('Replaced.') : scenario.replacement;
      const edit = await open('author', { itemId: item.id });
      await stage(edit, stored.map((section, i) => ({ id: section.id, content: i === target ? replacement : section.content })));
      const edited = await commit(edit, { rev: item.rev, mark: { mark: 'correction', reason: 'Synthetic correction.' } });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const now = sectionsOf((await edited.json<{ item: ItemView }>()).item);
      expect(now.map((section) => section.id)).toEqual(stored.map((section) => section.id));
      for (const [i, section] of now.entries()) {
        const expected = i === target ? replacement : stored[i]!.content;
        expect(section.content.text === expected.text).toBe(true); expect(section.content.spans).toEqual(expected.spans);
      }
      const past = await world.request('author', 'GET', `/items/${item.id}/history?point=creation`);
      expect(past.status).toBe(200);
      const state = (await past.json<{ state: { item: { sections?: SectionView[] } } }>()).state.item.sections ?? [];
      expect(state.map((section) => section.id)).toEqual(stored.map((section) => section.id));
      for (const [i, section] of state.entries()) { expect(section.content.text === stored[i]!.content.text).toBe(true); expect(section.content.spans).toEqual(stored[i]!.content.spans); }
      expect(await largestRow()).toBeLessThanOrEqual(ROW_BYTES);
    }), { numRuns: Math.min(FC_RUNS, 6) });
  }, 600_000);

  it('finds phrases that cross a physical cut at the right place, and obeys current access without reindexing', async () => {
    const word = (n: number) => 'q' + n.toString(26).replace(/[0-9]/gu, (digit) => String.fromCharCode(97 + Number(digit))).padStart(5, 'a').replace(/[^a-z]/gu, 'b');
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1 }), async (skew) => {
      const words = Array.from({ length: 24_000 }, (_, i) => word(i));
      const text = words.join(' ');
      const [firstPiece] = [...fragmentText(text)];
      expect(firstPiece!.end).toBeLessThan(text.length);
      // The word that holds the first cut, and the two words after it.
      let at = 0; let index = 0;
      while (at + words[index]!.length < firstPiece!.end - skew) { at += words[index]!.length + 1; index++; }
      const [left, right, third] = [words[index]!, words[index + 1]!, words[index + 2]!];
      const token = await open('author');
      await stage(token, [{ content: rich(text) }]);
      const created = await commit(token, metadata());
      expect(created.status).toBe(201);
      const { item } = await created.json<{ item: ItemView }>();
      const section = sectionsOf(item)[0]!.id;
      await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
      const find = async (who: Who, q: string) => (await (await world.request(who, 'GET', '/search?q=' + encodeURIComponent(q))).json<SearchPage>()).results.map((result) => result.id);
      expect(await find('author', `"${left} ${right}"`)).toContain(section);
      expect(await find('author', `"${right} ${third}"`)).toContain(section);
      expect(await find('author', `"${left} ${third}"`)).not.toContain(section);
      expect(await find('author', `${left} ${third}`)).toContain(section);
      // Current access decides, not the index: a Restricted Item is invisible to a colleague at once, and no body of it is returned.
      await world.core().prepare("UPDATE research_items SET access_level='restricted' WHERE unit_id=?").bind(item.id).run();
      expect(await find('colleague', right)).toEqual([]);
      const refused = await world.request('colleague', 'GET', `/items/${item.id}`);
      expect(refused.status).not.toBe(200);
      expect(await refused.text()).not.toContain(right);
      expect(await find('author', right)).toContain(section);
    }), { numRuns: 3 });
  }, 600_000);
});
