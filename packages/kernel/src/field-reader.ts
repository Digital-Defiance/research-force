import { isFieldReference, readField } from '@researchforce/domain/text-fragments';
import type { FieldReference, FieldVersionReader } from '@researchforce/domain/text-fragments';
import type { RichText } from '@researchforce/domain/richtext';
import type { ProjectionInput } from './input';

type Stored<T> = T extends string | number | boolean | null | undefined ? T : T extends RichText ? T | FieldReference : T extends readonly (infer U)[] ? readonly Stored<U>[] : T extends object ? { readonly [K in keyof T]: Stored<T[K]> } : T;
export type StoredProjectionInput = Stored<ProjectionInput>;
/** The trusted projection loader supplies scoped readers. The kernel still performs every ordinary projection/suppression rule. */
export async function materializeProjectionInput(input: StoredProjectionInput, reader: (reference: FieldReference) => FieldVersionReader): Promise<ProjectionInput> {
  const walk = async (value: unknown, owner: string, field = ''): Promise<unknown> => {
    if (isFieldReference(value)) {
      if (value.ownerType !== 'unit' || value.ownerId !== owner || value.field !== field) throw new Error('Projection field reference does not match its logical owner/field.');
      return readField(value, reader(value));
    }
    if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await walk(item, owner, field)); return result; }
    if (value && typeof value === 'object') { const result: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) result[key] = await walk(item, owner, key); return result; }
    return value;
  };
  const units = []; for (const unit of input.units) units.push(await walk(unit, unit.id));
  return { ...input, units } as ProjectionInput;
}
