// Feature: research-collab-cms, Property 31: Configurable value sets behave uniformly
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { scalarTextArb } from '../arbitraries';
import { asULID } from '../../src/types';
import { acceptsNewlySet, changeValueSet, LOCKED_VALUE_IDS, offeredValues, VALUE_SET_KINDS } from '../../src/value-sets';
import type { ConfigValue, ValueSet, ValueSetKind, ValueSetOperation } from '../../src/value-sets';

const id = (value: number) => asULID(String(value).padStart(26, '0'));
function initial(kind: ValueSetKind): ValueSet {
  const locked: [ConfigValue['id'], string][] = kind === 'hypothesis_status' ? [[LOCKED_VALUE_IDS.hypothesisOpen, 'Open'], [LOCKED_VALUE_IDS.hypothesisEliminated, 'Eliminated']]
    : kind === 'archival_request_status' ? [[LOCKED_VALUE_IDS.archivalSent, 'Sent'], [LOCKED_VALUE_IDS.archivalReplied, 'Replied']]
      : kind === 'rights_status' ? [[LOCKED_VALUE_IDS.rightsUnknown, 'Unknown']] : [];
  return { kind, values: [...locked, [id(100), 'Initial'], [id(101), 'Another']].map(([key, name]) => ({ id: key as ConfigValue['id'], name: name!, retired: false, ...(kind !== 'specialty' ? { publicDescription: 'Synthetic explanation' } : {}), ...(kind === 'rights_status' ? { permitsPublication: false } : {}) })) };
}

/** A separate state machine tracks changes by identity and treats stored references as opaque. */
function reference(set: ValueSet, operation: ValueSetOperation, locked: ReadonlySet<ConfigValue['id']>): ValueSet | undefined {
  const validName = (name: string, except?: ConfigValue['id']): boolean => Array.from(name).length >= 1 && Array.from(name).length <= 50
    && !/^[\p{White_Space}\uFEFF]*$/u.test(name) && !set.values.some((entry) => entry.id !== except && entry.name.toLowerCase() === name.toLowerCase());
  const values = set.values.map((entry) => ({ ...entry }));
  if (operation.kind === 'add') {
    const value = operation.value;
    if (values.some((entry) => entry.id === value.id) || Object.values(LOCKED_VALUE_IDS).includes(value.id)) return undefined;
    if (!validName(value.name) || value.retired) return undefined;
    if (set.kind !== 'specialty' || value.publicDescription !== undefined) {
      if (value.publicDescription === undefined || /^[\p{White_Space}\uFEFF]*$/u.test(value.publicDescription) || Array.from(value.publicDescription).length > 500) return undefined;
    }
    if (set.kind !== 'rights_status' && value.permitsPublication !== undefined) return undefined;
    values.push({ ...value, ...(set.kind === 'rights_status' ? { permitsPublication: value.permitsPublication ?? false } : {}) });
  } else {
    const index = values.findIndex((entry) => entry.id === operation.id);
    const value = values[index];
    if (!value) return undefined;
    if (operation.kind === 'rename') {
      if ((value.id === LOCKED_VALUE_IDS.rightsUnknown && value.name !== operation.name) || !validName(operation.name, value.id)) return undefined;
      values[index] = { ...value, name: operation.name };
    } else if (operation.kind === 'retire') {
      if (locked.has(value.id) || (!value.retired && values.filter((entry) => !entry.retired).length === 1)) return undefined;
      values[index] = { ...value, retired: true };
    } else {
      if (set.kind !== 'rights_status' || (value.id === LOCKED_VALUE_IDS.rightsUnknown && operation.permits)) return undefined;
      values[index] = { ...value, permitsPublication: operation.permits };
    }
  }
  return { kind: set.kind, values };
}

it('matches an independent state machine through accepted and rejected operation sequences', () => {
  const name = fc.oneof(scalarTextArb, fc.constantFrom('', ' ', 'INITIAL', '😀'.repeat(50), '😀'.repeat(51)));
  const action = fc.record({ kind: fc.constantFrom('add', 'rename', 'retire', 'mark_publication'), name, description: fc.option(fc.constantFrom('', ' ', 'A description', '😀'.repeat(500), 'x'.repeat(501)), { nil: undefined }), target: fc.nat({ max: 30 }), flag: fc.boolean() });
  fc.assert(fc.property(fc.constantFrom(...VALUE_SET_KINDS), fc.array(action, { minLength: 1, maxLength: 50 }), (kind, actions) => {
    let state = initial(kind);
    let model = structuredClone(state);
    const locked = new Set(state.values.filter((value) => Object.values(LOCKED_VALUE_IDS).includes(value.id)).map((value) => value.id));
    const references = state.values.map((value) => value.id);
    for (const [step, action] of actions.entries()) {
      const selected = action.target % 5 === 0 ? id(999) : state.values[action.target % state.values.length]!.id;
      let operation: ValueSetOperation;
      if (action.kind === 'add') operation = { kind: 'add', value: { id: action.target % 4 === 0 ? selected : id(1000 + step), name: action.name, retired: action.target % 7 === 0, ...(action.description === undefined ? {} : { publicDescription: action.description }) } };
      else if (action.kind === 'rename') operation = { kind: 'rename', id: selected, name: action.name };
      else if (action.kind === 'retire') operation = { kind: 'retire', id: selected };
      else operation = { kind: 'mark_publication', id: selected, permits: action.flag };
      const snapshot = structuredClone(state);
      const expected = reference(model, operation, locked);
      const actual = changeValueSet(state, operation);
      expect(actual.ok).toBe(expected !== undefined);
      expect(state).toEqual(snapshot);
      if (actual.ok) { state = actual.value; model = expected!; }
      expect(state).toEqual(model);
      expect(references.every((key) => state.values.some((value) => value.id === key))).toBe(true);
      expect(offeredValues(state).map((value) => value.id)).toEqual(state.values.filter((value) => !value.retired).map((value) => value.id));
      expect(state.values.every((value) => acceptsNewlySet(value) === !value.retired)).toBe(true);
    }
  }));
});
