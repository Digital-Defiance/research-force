// Feature: research-collab-cms, Property 99: External_Party duplicate detection ignores case and diacritics
import { beforeAll, describe, expect, it } from 'vitest';
import { asTimestamp } from '@researchforce/domain/types';
import { fc } from '@researchforce/testing/fc';
import { assertionSpec, signAssertion, testAccess } from '@researchforce/testing/jwt';
import type { TestAccess } from '@researchforce/testing/jwt';
import type { Env } from '../../src/env';
import type { PartyRecord } from '../../src/records/parties';
import { migrated } from '../d1';
import { addMember, call, KeyServer, resetPeople, testApi } from '../api';

const MARKS = ['\u0301', '\u0300', '\u0308', '\u0303', '\u0327'];
/** A spelling of one letter or of "ss", and the folded text it stands for. */
const letterArb = fc.record({ base: fc.constantFrom('a', 'o', 's', 'n'), upper: fc.boolean(), mark: fc.option(fc.constantFrom(...MARKS)), composed: fc.boolean() })
  .map(({ base, upper, mark, composed }) => {
    const letter = (upper ? base.toUpperCase() : base) + (mark ?? '');
    return { text: composed ? letter.normalize('NFC') : letter, key: base };
  });
const ssArb = fc.constantFrom('ß', 'ẞ', 'ss', 'SS', 'sS').map((text) => ({ text, key: 'ss' }));
const wordArb = fc.array(fc.oneof({ weight: 4, arbitrary: letterArb }, { weight: 1, arbitrary: ssArb }), { minLength: 1, maxLength: 2 })
  .map((parts) => ({ text: parts.map((part) => part.text).join(''), key: parts.map((part) => part.key).join('') }));
const nameArb = fc.tuple(fc.array(wordArb, { minLength: 1, maxLength: 2 }), fc.constantFrom(' ', '  ', '\u00a0'))
  .map(([words, gap]) => ({ text: words.map((word) => word.text).join(gap), key: words.map((word) => word.key).join(' ') }));

let bindings: Env;
let access: TestAccess;
beforeAll(async () => {
  bindings = await migrated();
  access = await testAccess();
});

describe('Property 99: External_Party duplicate detection ignores case and diacritics', () => {
  it('asks for confirmation exactly when the name folds to an existing one, listing every such External_Party', async () => {
    const now = new Date('2026-10-27T18:00:00.000Z');
    const at = asTimestamp(now.toISOString());
    const core = () => bindings.RF_CORE;
    await resetPeople(core());
    await addMember(core(), 'member@example.test', 'active', at);
    const api = testApi(access, new KeyServer(access), now);
    const token = (await signAssertion(access, assertionSpec('member@example.test'), now))!;
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ name: nameArb, confirm: fc.boolean() }), { minLength: 1, maxLength: 6 }), async (steps) => {
      await core().prepare('DELETE FROM external_parties').run();
      const existing: { id: string; name: string; key: string }[] = [];
      for (const { name, confirm } of steps) {
        const matches = existing.filter((party) => party.key === name.key).map(({ id, name: stored }) => ({ id, name: stored })).sort((a, b) => a.id.localeCompare(b.id));
        const response = await call(api, bindings, token, 'POST', '/parties', { name: name.text, ...(confirm ? { confirmDistinct: true } : {}) });
        if (matches.length > 0 && !confirm) {
          expect([response.status, await response.json()]).toEqual([422, { error: 'rule', details: {
            rule: 'party_name_exists', message: 'An External Party with this name already exists. Confirm that this is a different person or organization.', parties: matches,
          } }]);
          continue;
        }
        expect(response.status).toBe(201);
        const { party } = await response.json<{ party: PartyRecord }>();
        expect(party.name).toBe(name.text);
        expect(await core().prepare('SELECT name_fold FROM external_parties WHERE id = ?1').bind(party.id).first('name_fold')).toBe(name.key);
        existing.push({ id: party.id, name: party.name, key: name.key });
      }
    }));
  });
});
