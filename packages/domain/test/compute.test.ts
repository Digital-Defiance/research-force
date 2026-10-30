import { describe, expect, it } from 'vitest';
import { configurationChunks, configurationIssues, COMPUTE_LIMITS, manifestHash, manifestSchema, missingIngredients, packageInputSchema, uriIssues } from '../src/compute';
import type { Manifest } from '../src/compute';

const full: Manifest = {
  code: { repository: 'https://example.org/r.git', commit: 'a'.repeat(40) }, command: 'run', methodVersion: '1', usesRandomness: false,
  environment: [{ kind: 'toolchain', name: 't', value: '1' }, { kind: 'hardware', name: 'h', value: '1' }],
  artifacts: [{ role: 'input', type: 'external', uri: 'https://example.org/i' }, { role: 'output', type: 'external', uri: 'https://example.org/o' }],
};

describe('what a package still lacks (R56.2)', () => {
  it('lists nothing for a complete description and names each gap otherwise', () => {
    expect(missingIngredients(full)).toEqual([]);
    expect(missingIngredients({ ...full, code: { repository: 'https://example.org/r.git' } })).toEqual(['code_identity']);
    expect(missingIngredients({ ...full, code: { commit: 'a'.repeat(40) } })).toEqual(['code_identity']);
    const { command: _command, ...noCommand } = full;
    expect(missingIngredients(noCommand)).toEqual(['command']);
    expect(missingIngredients({ ...noCommand, entrypoint: 'main' })).toEqual([]);
    expect(missingIngredients({ ...full, usesRandomness: true })).toEqual(['seeds']);
    expect(missingIngredients({ ...full, usesRandomness: true, environment: [...full.environment, { kind: 'seed', name: 'rng', value: '1' }] })).toEqual([]);
    expect(missingIngredients({ ...full, artifacts: [], environment: [] })).toEqual(['inputs', 'outputs', 'toolchain', 'hardware']);
  });
});

describe('the identity of a description (R56.1)', () => {
  it('is the same whatever the order of keys, and different when any value differs', () => {
    expect(manifestHash({ ...full, configuration: { a: 1, b: 2 } })).toBe(manifestHash({ ...full, configuration: { b: 2, a: 1 } }));
    expect(manifestHash({ ...full, configuration: { a: 1 } })).not.toBe(manifestHash({ ...full, configuration: { a: '1' } }));
    expect(manifestHash(full)).not.toBe(manifestHash({ ...full, command: 'run ' }));
    expect(manifestHash(full)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('configuration (R56.1, R56.6)', () => {
  it('accepts safe integers, text, booleans, null, lists and objects, and refuses what would be rounded', () => {
    expect(configurationIssues({ a: 9007199254740991, b: -5, c: 'x', d: [true, null], e: { f: {} } })).toEqual([]);
    for (const bad of [{ a: 0.5 }, { a: 9007199254740992 }, { a: 1e21 }, { a: Number.NaN }, { a: Infinity }, { a: undefined }]) expect(configurationIssues(bad), JSON.stringify(bad)).not.toEqual([]);
  });
  it('bounds depth and size', () => {
    let deep: unknown = 'x';
    for (let level = 0; level < COMPUTE_LIMITS.configurationDepth + 1; level += 1) deep = { a: deep };
    expect(configurationIssues(deep)).not.toEqual([]);
    expect(configurationIssues({ k: 'x'.repeat(COMPUTE_LIMITS.configurationBytes) })).not.toEqual([]);
    expect(configurationIssues({ k: 'x'.repeat(COMPUTE_LIMITS.configurationBytes - 8) })).toEqual([]);
  });
  it('splits into bounded pieces without cutting a surrogate pair, and joins back exactly', () => {
    const text = `${'a'.repeat(COMPUTE_LIMITS.configurationChunkUnits - 1)}😀${'b'.repeat(50_000)}`;
    const pieces = configurationChunks(text);
    expect(pieces.join('')).toBe(text);
    expect(pieces.every((piece) => piece.length <= COMPUTE_LIMITS.configurationChunkUnits)).toBe(true);
    expect(pieces.every((piece) => !/[\ud800-\udbff]$/u.test(piece) && !/^[\udc00-\udfff]/u.test(piece))).toBe(true);
  });
});

describe('references and secrets (R56.6)', () => {
  it('accepts an address that names where something is, and refuses one that carries a credential', () => {
    for (const ok of ['https://example.org/a.tar', 's3://bucket/key', 'ssh://git@example.org/r.git', 'doi:10.1234/abc', 'https://example.org/f?version=3']) expect(uriIssues('u', ok), ok).toEqual([]);
    for (const bad of ['https://u:p@example.org/', 'https://example.org/?token=abc', 'https://example.org/?X-Amz-Signature=1', 'file:///etc/passwd', 'ftp://example.org/', 'relative/path', 'javascript:alert(1)']) expect(uriIssues('u', bad), bad).not.toEqual([]);
  });
});

describe('the input schemas', () => {
  it('refuse unknown fields and bad hashes, and default the lists', () => {
    expect(manifestSchema.parse({}).artifacts).toEqual([]);
    expect(packageInputSchema.safeParse({ rev: 1, expectedVersion: 0 }).success).toBe(true);
    expect(packageInputSchema.safeParse({ rev: 1, expectedVersion: 0, extra: 1 }).success).toBe(false);
    expect(packageInputSchema.safeParse({ rev: 0, expectedVersion: 0 }).success).toBe(false);
    expect(packageInputSchema.safeParse({ rev: 1, expectedVersion: 0, artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/a', sha256: 'ABC' }] }).success).toBe(false);
    expect(packageInputSchema.safeParse({ rev: 1, expectedVersion: 0, artifacts: [{ type: 'external', role: 'sample', uri: 'https://example.org/a' }] }).success).toBe(false);
  });
});
