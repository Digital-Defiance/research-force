import { asULID } from './types';
import type { Timestamp, ULID } from './types';
/** One format definition, shared by generation, validation, registry keys and later displays. */
export const ITEM_ID_FORMAT = Object.freeze({ alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ', groups: Object.freeze([4, 4, 4] as const), separator: '-' });
const SUBMISSION_REFERENCE_FORMAT = Object.freeze({ prefix: 'RS-', groups: Object.freeze([5, 5] as const) });
export interface RandomSource { getRandomValues(array: Uint8Array): Uint8Array; }
function randomSource(): RandomSource {
  const source = (globalThis as unknown as { crypto?: RandomSource }).crypto;
  if (!source) throw new Error('Cryptographic randomness is unavailable.');
  return source;
}
function randomGroups(groups: readonly number[], source: RandomSource): string {
  const bytes = new Uint8Array(groups.reduce((sum, length) => sum + length, 0));
  source.getRandomValues(bytes);
  let index = 0;
  return groups.map((length) => Array.from({ length }, () => ITEM_ID_FORMAT.alphabet[bytes[index++]! & 31]!).join('')).join(ITEM_ID_FORMAT.separator);
}
export function isItemIdentifier(value: string): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(value)) return false;
  const pieces = value.toUpperCase().split(ITEM_ID_FORMAT.separator);
  return pieces.length === ITEM_ID_FORMAT.groups.length && pieces.every((piece, index) => piece.length === ITEM_ID_FORMAT.groups[index] && [...piece].every((character) => ITEM_ID_FORMAT.alphabet.includes(character)));
}
export function itemIdentifierKey(value: string): string {
  if (!isItemIdentifier(value)) throw new RangeError('Invalid Item Identifier.');
  return value.toLowerCase();
}
/** The key that matches a Member's email ignoring letter case (`members.email_lc`, R1.4). */
export function emailKey(email: string): string {
  return email.toLowerCase();
}
export function newItemIdentifier(source: RandomSource = randomSource()): { readonly identifier: string; readonly registryKey: string } {
  const identifier = randomGroups(ITEM_ID_FORMAT.groups, source);
  return { identifier, registryKey: itemIdentifierKey(identifier) };
}
export function newSubmissionReference(source: RandomSource = randomSource()): string {
  return SUBMISSION_REFERENCE_FORMAT.prefix + randomGroups(SUBMISSION_REFERENCE_FORMAT.groups, source);
}
/** A canonical ULID: 48 bits of the supplied time and 80 random bits. The clock is always the caller's. */
export function newULID(now: Timestamp, source: RandomSource = randomSource()): ULID {
  let time = Date.parse(now);
  const timePart: string[] = [];
  for (let index = 0; index < 10; index++) {
    timePart.unshift(ITEM_ID_FORMAT.alphabet[time % 32]!);
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  return asULID(timePart.join('') + Array.from(bytes, (byte) => ITEM_ID_FORMAT.alphabet[byte & 31]!).join(''));
}
