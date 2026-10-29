import { stableJson } from './history';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { RichText, Span } from './richtext';
import { validateSpans } from './richtext';
import { DEFAULT_RESOURCE_PROFILE, assertPayloadBudget, encodedJsonBytes } from './resource-profile';
import { cpLength } from './text';

export const FIELD_FORMAT = 'rich-text-v1' as const;
export interface TextFragment { readonly kind: 'text'; readonly ordinal: number; readonly start: number; readonly end: number; readonly text: string }
export interface SpanFragment { readonly kind: 'spans'; readonly ordinal: number; readonly start: number; readonly spans: readonly Span[] }
export type FieldFragment = TextFragment | SpanFragment;
export interface FragmentDescriptor { readonly kind: FieldFragment['kind']; readonly ordinal: number; readonly start: number; readonly end: number; readonly sha256: string }
export interface FieldManifest {
  readonly format: typeof FIELD_FORMAT; readonly utf16Length: number; readonly codePoints: number; readonly spanCount: number;
  readonly fragments: readonly FragmentDescriptor[];
}
export interface FieldReference {
  readonly $fieldVersion: 1; readonly id: string; readonly ownerType: string; readonly ownerId: string; readonly field: string; readonly digest: string;
}
export interface FieldVersionReader {
  manifest(reference: FieldReference): Promise<FieldManifest>;
  fragments(reference: FieldReference): AsyncIterable<FieldFragment>;
}
export const fragmentDigest = (value: unknown): string => bytesToHex(sha256(utf8ToBytes(stableJson(value))));
export function isFieldReference(value: unknown): value is FieldReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 6 && v['$fieldVersion'] === 1 && ['id', 'ownerType', 'ownerId', 'field'].every((k) => typeof v[k] === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/u.test(v[k] as string))
    && typeof v['digest'] === 'string' && /^[a-f0-9]{64}$/u.test(v['digest']);
}

/** Counts JSON escaping too; splitting never normalizes text or splits a surrogate pair. */
export function* fragmentText(text: string): Generator<TextFragment> {
  const limit = DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment;
  let start = 0; let ordinal = 0;
  do {
    const overhead = encodedJsonBytes({ kind: 'text', ordinal, start, end: text.length, text: '' });
    let end = start; let bytes = overhead;
    while (end < text.length) {
      const c = text.charCodeAt(end); const following = text.charCodeAt(end + 1);
      const pair = c >= 0xd800 && c <= 0xdbff && following >= 0xdc00 && following <= 0xdfff;
      const size = pair ? 4 : c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : c < 32 || (c >= 0xd800 && c <= 0xdfff) ? 6 : c < 128 ? 1 : c < 2048 ? 2 : 3;
      if (bytes + size > limit) break;
      bytes += size; end += pair ? 2 : 1;
    }
    if (end === start && start < text.length) throw new RangeError('No code point fits the fragment budget.');
    const fragment: TextFragment = { kind: 'text', ordinal, start, end, text: text.slice(start, end) };
    assertPayloadBudget(fragment, 'fragment'); yield fragment;
    ordinal++; start = end;
  } while (start < text.length);
}
function checkedSpan(value: Span): Span {
  const span = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as unknown as Span;
  const extras: Record<Span['k'], readonly string[]> = { quote: ['source'], paraphrase: ['source'], source_reported: ['source'], lang: ['lang'], mention: ['member', 'specialty'] };
  if (!Object.hasOwn(extras, span.k) || !Number.isSafeInteger(span.s) || !Number.isSafeInteger(span.e) || Object.keys(span).some((k) => !['k', 's', 'e', ...extras[span.k]].includes(k))) throw new Error('Invalid fragment span shape.');
  for (const key of extras[span.k]) if (Object.hasOwn(span, key) && typeof (span as unknown as Record<string, unknown>)[key] !== 'string') throw new Error('Invalid fragment span value.');
  if ((span.k === 'quote' || span.k === 'paraphrase') && typeof span.source !== 'string') throw new Error('Missing fragment label source.');
  return span;
}
export function* fragmentSpans(spans: readonly Span[]): Generator<SpanFragment> {
  const limit = DEFAULT_RESOURCE_PROFILE.chosen.bytes.fragment;
  let start = 0; let ordinal = 0;
  while (start < spans.length) {
    const pieces: Span[] = []; let size = encodedJsonBytes({ kind: 'spans', ordinal, start, spans: [] });
    while (start + pieces.length < spans.length) {
      const span = checkedSpan(spans[start + pieces.length]!); const bytes = encodedJsonBytes(span);
      if (size + bytes + (pieces.length ? 1 : 0) > limit) break;
      size += bytes + (pieces.length ? 1 : 0); pieces.push(span);
    }
    if (!pieces.length) throw new RangeError('An individual span exceeds the fragment budget.');
    const piece: SpanFragment = { kind: 'spans', ordinal, start, spans: pieces };
    assertPayloadBudget(piece, 'fragment'); yield piece; ordinal++; start += pieces.length;
  }
}
export function validateFieldFragment(fragment: FieldFragment): void {
  assertPayloadBudget(fragment, 'fragment');
  if (!fragment || !Number.isSafeInteger(fragment.ordinal) || fragment.ordinal < 0 || !Number.isSafeInteger(fragment.start) || fragment.start < 0) throw new Error('Invalid fragment address.');
  if (fragment.kind === 'text') {
    if (Object.keys(fragment).length !== 5 || typeof fragment.text !== 'string' || !Number.isSafeInteger(fragment.end) || fragment.end - fragment.start !== fragment.text.length) throw new Error('Invalid text fragment range.');
  } else if (fragment.kind === 'spans') {
    if (Object.keys(fragment).length !== 4 || !Array.isArray(fragment.spans) || !fragment.spans.length) throw new Error('Invalid span fragment.');
    for (const span of fragment.spans) checkedSpan(span);
  } else throw new Error('Unsupported fragment kind.');
}
export function* fieldFragments(value: RichText): Generator<FieldFragment> { yield* fragmentText(value.text); yield* fragmentSpans(value.spans); }
export function describeFragment(fragment: FieldFragment): FragmentDescriptor {
  validateFieldFragment(fragment);
  return { kind: fragment.kind, ordinal: fragment.ordinal, start: fragment.start, end: fragment.kind === 'text' ? fragment.end : fragment.start + fragment.spans.length, sha256: fragmentDigest(fragment) };
}
/** Only bounded pieces are hashed. The manifest binds their ordered kinds, global ranges and exact encoded bytes. */
export function fieldManifest(value: RichText): FieldManifest {
  if (value.spans.length > DEFAULT_RESOURCE_PROFILE.chosen.logical.spansPerField || validateSpans(value).length) throw new RangeError('Invalid logical field spans.');
  const manifest: FieldManifest = { format: FIELD_FORMAT, utf16Length: value.text.length, codePoints: cpLength(value.text), spanCount: value.spans.length,
    fragments: Array.from(fieldFragments(value), describeFragment) };
  assertPayloadBudget(manifest, 'physicalRow'); return manifest;
}
export function validateFieldManifest(value: unknown): asserts value is FieldManifest {
  assertPayloadBudget(value, 'physicalRow');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing field manifest.');
  const m = value as FieldManifest;
  if (Object.keys(m).length !== 5 || m.format !== FIELD_FORMAT || ![m.utf16Length, m.codePoints, m.spanCount].every((v) => Number.isSafeInteger(v) && v >= 0) || m.spanCount > DEFAULT_RESOURCE_PROFILE.chosen.logical.spansPerField || !Array.isArray(m.fragments)) throw new Error('Unsupported field manifest.');
  let textAt = 0; let spansAt = 0; let textOrdinal = 0; let spanOrdinal = 0; let sawSpans = false;
  for (const descriptor of m.fragments) {
    if (!descriptor || Object.keys(descriptor).length !== 5 || !/^[a-f0-9]{64}$/u.test(descriptor.sha256) || ![descriptor.ordinal, descriptor.start, descriptor.end].every((n) => Number.isSafeInteger(n) && n >= 0) || descriptor.end < descriptor.start) throw new Error('Malformed fragment descriptor.');
    if (descriptor.kind === 'text' && !sawSpans && descriptor.ordinal === textOrdinal++ && descriptor.start === textAt) textAt = descriptor.end;
    else if (descriptor.kind === 'spans' && descriptor.ordinal === spanOrdinal++ && descriptor.start === spansAt && descriptor.end > descriptor.start) { spansAt = descriptor.end; sawSpans = true; }
    else throw new Error('Missing, reordered or overlapping fragment.');
  }
  if (textOrdinal === 0 || textAt !== m.utf16Length || spansAt !== m.spanCount || m.codePoints > m.utf16Length || m.utf16Length > m.codePoints * 2) throw new Error('Manifest totals do not match.');
}
/** Authenticated internal readers resolve only an already-authorized logical owner. No public lookup endpoint is implied. */
export async function readField(reference: FieldReference, reader: FieldVersionReader): Promise<RichText> {
  if (!isFieldReference(reference)) throw new Error('Malformed field reference.');
  const manifest = await reader.manifest(reference); validateFieldManifest(manifest);
  if (fragmentDigest(manifest) !== reference.digest) throw new Error('Field manifest digest mismatch.');
  const text: string[] = []; const spans: Span[] = []; let ordinal = 0; let characters = 0;
  for await (const fragment of reader.fragments(reference)) {
    assertPayloadBudget(fragment, 'fragment');
    const expected = manifest.fragments[ordinal++];
    if (!expected || stableJson(describeFragment(fragment)) !== stableJson(expected)) throw new Error('Fragment digest, range or order mismatch.');
    if (fragment.kind === 'text' && fragment.end - fragment.start !== fragment.text.length) throw new Error('Text fragment length mismatch.');
    if (fragment.kind === 'text') { text.push(fragment.text); characters += cpLength(fragment.text); }
    else spans.push(...fragment.spans);
  }
  if (ordinal !== manifest.fragments.length || characters !== manifest.codePoints) throw new Error('Incomplete field version.');
  const result = { text: text.join(''), spans };
  if (result.text.length !== manifest.utf16Length || validateSpans(result).length) throw new Error('Reconstructed field violates its logical ranges.');
  return result;
}

/** A continuation retains canonical identity and global addresses; clipped marks do not create new logical fields. */
export function fragmentRichText(value: RichText): Generator<{ fragment: TextFragment; content: RichText }> {
  function* parts() {
    for (const fragment of fragmentText(value.text)) {
      const spans = value.spans.filter((s) => s.e > fragment.start && s.s < fragment.end).map((s) => ({ ...s, s: Math.max(s.s, fragment.start) - fragment.start, e: Math.min(s.e, fragment.end) - fragment.start }));
      yield { fragment, content: { text: fragment.text, spans } };
    }
  }
  return parts();
}

/** Bounded verified stream for printers, exports and backup/citation readers; the full field need not be serialized. */
export async function* streamField(reference: FieldReference, reader: FieldVersionReader): AsyncGenerator<FieldFragment> {
  if (!isFieldReference(reference)) throw new Error('Malformed field reference.');
  const manifest = await reader.manifest(reference); validateFieldManifest(manifest);
  if (fragmentDigest(manifest) !== reference.digest) throw new Error('Field manifest digest mismatch.');
  let index = 0; let characters = 0;
  for await (const part of reader.fragments(reference)) {
    assertPayloadBudget(part, 'fragment');
    if (stableJson(describeFragment(part)) !== stableJson(manifest.fragments[index++])) throw new Error('Field fragment mismatch.');
    if (part.kind === 'text') { if (part.end - part.start !== part.text.length) throw new Error('Field fragment range mismatch.'); characters += cpLength(part.text); }
    yield part;
  }
  if (index !== manifest.fragments.length || characters !== manifest.codePoints) throw new Error('Incomplete field stream.');
}
