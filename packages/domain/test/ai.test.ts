import { describe, expect, it } from 'vitest';
import {
  AI_FALLBACK_MODEL,
  AI_MODEL,
  AI_MODEL_ALLOW_LIST,
  AI_MODEL_VERSION,
  cutToInputLimit,
  DRAFT_FIELD_LIMIT,
  DRAFT_MAX_TOKENS,
  draftTextHash,
  isAllowedModel,
  isDisclosureField,
  isEmptyInput,
  reservationNeurons,
  savedProvenance,
  systemPrompt,
  utf8ByteLength,
  worstCaseDraftNeurons,
  worstCaseNeurons,
} from '@researchforce/domain/ai';
import { SETTINGS } from '@researchforce/domain/settings';

describe('the model allow-list (R44.9)', () => {
  it('accepts only the two Cloudflare-hosted @cf/ models', () => {
    expect(isAllowedModel(AI_MODEL)).toBe(true);
    expect(isAllowedModel(AI_FALLBACK_MODEL)).toBe(true);
    expect(AI_MODEL_ALLOW_LIST.every((model) => model.startsWith('@cf/'))).toBe(true);
  });
  it('refuses anything not on the list, including non-@cf/ ids', () => {
    expect(isAllowedModel('@cf/some/other-model')).toBe(false);
    expect(isAllowedModel('openai/gpt-4')).toBe(false);
    expect(isAllowedModel('google/nano-banana')).toBe(false);
    expect(isAllowedModel('')).toBe(false);
  });
});

describe('field limits and max_tokens (R44.14, design "Prompt")', () => {
  it('maps each field to its length limit and max_tokens', () => {
    expect(DRAFT_FIELD_LIMIT).toEqual({ logSummary: 2000, publicSummary: 2000, disclosureKind: 100, disclosureNote: 200 });
    expect(DRAFT_MAX_TOKENS).toEqual({ logSummary: 800, publicSummary: 800, disclosureKind: 200, disclosureNote: 200 });
  });
  it('identifies the short Disclosure_Line fields', () => {
    expect(isDisclosureField('disclosureKind')).toBe(true);
    expect(isDisclosureField('disclosureNote')).toBe(true);
    expect(isDisclosureField('logSummary')).toBe(false);
    expect(isDisclosureField('publicSummary')).toBe(false);
  });
});

describe('the worst-case Neuron computation (R28.14, design "Neuron budget")', () => {
  it('rounds up inRate × (promptBytes + overhead) + outRate × max_tokens', () => {
    // 2,000 input bytes + 64 overhead = 2,064 tokens; 600 output tokens.
    const expected = Math.ceil((2064 * 9091 + 600 * 27_273) / 1_000_000);
    expect(worstCaseNeurons(2000, 600)).toBe(expected);
  });
  it('a typical draft (10,000 chars in, 600 out) is about 45 Neurons (R28.15)', () => {
    const typical = worstCaseNeurons(10_000, 600);
    expect(typical).toBeGreaterThan(100); // worst case at 1 byte/char is well above the typical 45
    // The documented "typical ~45" uses ~2,000 input tokens; confirm that figure lands near 45.
    expect(worstCaseNeurons(2000, 600)).toBeGreaterThanOrEqual(30);
    expect(worstCaseNeurons(2000, 600)).toBeLessThanOrEqual(45);
  });
  it('a worst-case draft at the AI_Input_Limit uses 4 bytes per character', () => {
    const limit = SETTINGS.aiInputLimit.default;
    expect(worstCaseDraftNeurons(limit)).toBe(worstCaseNeurons(limit * 4, DRAFT_MAX_TOKENS.logSummary));
  });
  it('reserves from the actual prompt bytes', () => {
    const text = 'abc';
    expect(reservationNeurons(text, 'logSummary')).toBe(worstCaseNeurons(utf8ByteLength(text), 800));
  });
  it('counts multi-byte characters by their UTF-8 bytes', () => {
    expect(utf8ByteLength('ä')).toBe(2);
    expect(utf8ByteLength('𝄞')).toBe(4);
    expect(utf8ByteLength('ss')).toBe(2);
  });
});

describe('cutting to the AI_Input_Limit (R44.3, R44.18)', () => {
  it('keeps short input unchanged and flags nothing', () => {
    expect(cutToInputLimit('hello', 1000)).toEqual({ text: 'hello', truncated: false });
  });
  it('cuts to the first N code points and flags the remainder', () => {
    const result = cutToInputLimit('abcdef', 3);
    expect(result).toEqual({ text: 'abc', truncated: true });
  });
  it('counts code points, not UTF-16 units, when cutting', () => {
    const astral = '𝄞𝄞𝄞𝄞'; // four 2-unit code points
    const result = cutToInputLimit(astral, 2);
    expect([...result.text].length).toBe(2);
    expect(result.truncated).toBe(true);
  });
  it('treats blank input as empty', () => {
    expect(isEmptyInput('')).toBe(true);
    expect(isEmptyInput('   \n\t ')).toBe(true);
    expect(isEmptyInput('x')).toBe(false);
  });
});

describe('the fixed system prompt (design "Prompt")', () => {
  it('names the field limit for a summary and forbids invented facts', () => {
    const prompt = systemPrompt('logSummary');
    expect(prompt).toContain('2000');
    expect(prompt.toLowerCase()).toContain('invent no facts');
    expect(prompt).toContain('English');
  });
  it('asks only for kind and note for a Disclosure_Line draft', () => {
    const prompt = systemPrompt('disclosureKind');
    expect(prompt).toContain('kind:');
    expect(prompt).toContain('note:');
    expect(prompt).toContain('100');
    expect(prompt).toContain('200');
  });
  it('is identical for the same field (carries no per-request content)', () => {
    expect(systemPrompt('logSummary')).toBe(systemPrompt('logSummary'));
  });
});

describe('AI provenance (R44.6)', () => {
  it('hashes a field over its canonical UTF-8 text, as a 64-hex digest, with no normalization', () => {
    expect(draftTextHash('abc')).toMatch(/^[0-9a-f]{64}$/u);
    expect(draftTextHash('abc')).toBe(draftTextHash('abc'));
    // Trimming and case are preserved: distinct texts hash distinctly.
    expect(draftTextHash('abc')).not.toBe(draftTextHash('abc '));
    expect(draftTextHash('abc')).not.toBe(draftTextHash('ABC'));
  });

  it('records differs:false when the saved text matches the placed draft', () => {
    const draft = { model: AI_MODEL, version: AI_MODEL_VERSION, draftSha256: draftTextHash('The run eliminated wheel order III-II-I.') };
    expect(savedProvenance(draft, 'The run eliminated wheel order III-II-I.')).toEqual({ model: AI_MODEL, version: AI_MODEL_VERSION, differs: false });
  });

  it('records differs:true when the saved text was edited after the draft was placed', () => {
    const draft = { model: AI_MODEL, version: AI_MODEL_VERSION, draftSha256: draftTextHash('The run eliminated wheel order III-II-I.') };
    expect(savedProvenance(draft, 'The run eliminated wheel order III-II-I (confirmed).')).toEqual({ model: AI_MODEL, version: AI_MODEL_VERSION, differs: true });
  });

  it('carries the model and version through unchanged', () => {
    const draft = { model: AI_FALLBACK_MODEL, version: '1999-01', draftSha256: draftTextHash('x') };
    expect(savedProvenance(draft, 'x')).toEqual({ model: AI_FALLBACK_MODEL, version: '1999-01', differs: false });
  });
});
