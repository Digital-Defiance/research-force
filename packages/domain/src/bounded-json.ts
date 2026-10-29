import { DEFAULT_RESOURCE_PROFILE, encodedJsonBytes } from './resource-profile';

/** Counts the complete envelope, including metadata and escaping. One oversized logical value needs field fragments. */
export function* boundedEnvelopes<T, E>(values: Iterable<T>, envelope: (part: readonly T[]) => E, maximum = DEFAULT_RESOURCE_PROFILE.chosen.bytes.request): Generator<E> {
  let part: T[] = [];
  for (const value of values) {
    if (encodedJsonBytes(envelope([value]), maximum) > maximum) throw new RangeError('An individual value requires logical fragments.');
    if (part.length && encodedJsonBytes(envelope([...part, value]), maximum) > maximum) { yield envelope(part); part = []; }
    part.push(value);
  }
  if (part.length) yield envelope(part);
}
