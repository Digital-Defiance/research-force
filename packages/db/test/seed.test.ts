import { describe, expect, it } from 'vitest';
import { BUILT_IN_ROLES } from '@researchforce/domain/permissions';
import { BUILT_IN_VALUE_IDS, LOCKED_VALUE_IDS, VALUE_SET_KINDS, addValue, isMethodsTermSet } from '@researchforce/domain/value-sets';
import type { ValueSet } from '@researchforce/domain/value-sets';
import { cpLength, isBlank } from '@researchforce/domain/text';
import { seedSql } from '../src/seed/seed';
import { SEED_VALUES } from '../src/seed/value-sets';
import { FIXED_METHODS_TERMS } from '../src/seed/methods-descriptions';
import { SEED_POLICY_SECTIONS, STATE_MAILBOX_RESIDUAL_COPIES } from '../src/seed/policy-sections';

describe('seed migration', () => {
  it('matches the committed migration file, which `vitest -u` regenerates', async () => {
    await expect(seedSql()).toMatchFileSnapshot('../migrations/core/0002_seed.sql');
  });

  it('builds every initial value set through the same rules Administrators use', () => {
    for (const kind of VALUE_SET_KINDS) {
      const values = SEED_VALUES.filter((value) => value.setKey === kind);
      expect(values.length).toBeGreaterThan(0);
      let set: ValueSet = { kind, values: [] };
      for (const value of values) {
        // Built-in IDs are reserved against Administrator additions, so check the rules with a stand-in id.
        const reserved = Object.values(BUILT_IN_VALUE_IDS).includes(value.id);
        const candidate = { id: reserved ? '7ZZZZZZZZZZZZZZZZZZZZZZZZZ' as typeof value.id : value.id, name: value.name, retired: false,
          ...(value.publicDescription === null ? {} : { publicDescription: value.publicDescription }),
          ...(value.permitsPublication === null ? {} : { permitsPublication: value.permitsPublication }) };
        const result = addValue(set, candidate);
        expect(result.ok, `${kind} ${value.name}`).toBe(true);
        if (result.ok) set = { kind, values: result.value.values.map((entry) => entry.id === candidate.id ? { ...entry, id: value.id } : entry) };
      }
      expect(values.every((value) => (value.publicDescription !== null) === isMethodsTermSet(kind))).toBe(true);
    }
  });

  it('seeds every locked and built-in value under its fixed id, with Unknown never permitting publication', () => {
    const byId = new Map(SEED_VALUES.map((value) => [value.id, value]));
    for (const id of Object.values(BUILT_IN_VALUE_IDS)) expect(byId.has(id)).toBe(true);
    for (const id of Object.values(LOCKED_VALUE_IDS)) expect(byId.get(id)?.locked).toBe(true);
    expect(SEED_VALUES.filter((value) => value.locked).length).toBe(Object.keys(LOCKED_VALUE_IDS).length);
    expect(byId.get(LOCKED_VALUE_IDS.rightsUnknown)?.permitsPublication).toBe(false);
    expect(SEED_VALUES.filter((value) => value.permitsPublication).map((value) => value.name).sort()).toEqual(['Licensed', 'Own work', 'Permission granted', 'Public domain']);
    expect(new Set(SEED_VALUES.map((value) => value.id)).size).toBe(SEED_VALUES.length);
  });

  it('gives every fixed Methods_Term a Public_Description within the limit', () => {
    expect(FIXED_METHODS_TERMS.map((term) => term.key)).toEqual([
      'source_kind.primary', 'source_kind.secondary', 'disclosure_level.public', 'disclosure_level.withheld',
      'label_kind.quote', 'label_kind.paraphrase', 'label_kind.source_reported',
      'term.scope_caveat', 'term.elimination_scope', 'term.resume_point', 'term.withdrawn', 'term.superseded',
    ]);
    for (const term of FIXED_METHODS_TERMS) expect(!isBlank(term.publicDescription) && cpLength(term.publicDescription) <= 500).toBe(true);
  });

  it('seeds the fixed Policy_Sections with non-empty text for each required one', () => {
    expect(SEED_POLICY_SECTIONS.map((section) => `${section.pageKey}/${section.title}`)).toEqual([
      'about/About the group', 'people/Introduction',
      'methods/Evidence standards', 'methods/Provenance labels', 'methods/Statuses and outcomes', 'methods/Withheld and private material', 'methods/Corrections and withdrawals',
      'licence/Further notes',
      'privacy/Members', 'privacy/Submitters and requesters', 'privacy/People named in records', 'privacy/Visitors', 'privacy/Services that process data', 'privacy/Your requests',
      'corrections/Asking for a correction', 'corrections/Asking for a removal or about personal data', 'corrections/What happens next',
    ]);
    for (const section of SEED_POLICY_SECTIONS) {
      expect(section.required ? !isBlank(section.text) : section.text === '').toBe(true);
      expect(cpLength(section.text)).toBeLessThanOrEqual(20_000);
      // Fixed and seeded text never offers an email address, telephone number, or straight quotes (R46.10, R45.14).
      expect(section.text).not.toMatch(/@|\+?\d[\d\s()-]{6,}\d|['"]/);
    }
    const services = SEED_POLICY_SECTIONS.find((section) => section.sectionKey === 'services_that_process_data')!.text;
    expect(services).toContain('Microsoft 365');
    expect(services).toContain('Workers AI');
    expect(STATE_MAILBOX_RESIDUAL_COPIES).toBe(false);
  });

  it('makes no claim for a particular installation and leaves bootstrap values out', () => {
    const text = seedSql();
    expect(text).not.toMatch(/researchforce\.org|P1030680|Enigma/i);
    expect(text).not.toContain('responsiblePerson');
    expect(text).not.toMatch(/INSERT INTO `(members|projects|profiles)`/);
    for (const role of Object.values(BUILT_IN_ROLES)) expect(text).toContain(`'${role.id}'`);
  });
});
