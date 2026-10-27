import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBoundaries, checkSource, root } from '../../scripts/check-boundaries.mjs';

describe('workspace import boundaries', () => {
  it('keeps the checked-in sources and TypeScript graph within the allowed edges', () => {
    expect(checkBoundaries()).toEqual([]);
  });

  it.each([
    "import { value } from '@researchforce/db/schema/core/units';",
    "export * from '../../db/src/schema/core/units';",
    "const value = import('@researchforce/db/schema/core/units');",
    "const value = require('@researchforce/db/schema/core/units');",
    "type Value = import('@researchforce/db/schema/core/units').Value;",
  ])('rejects database access from public renderers: %s', (source) => {
    expect(checkSource(resolve(root, 'packages/public-render/src/view.ts'), source)).not.toEqual([]);
  });

  it('allows kernel types but rejects executable kernel imports in public outputs', () => {
    for (const name of ['public-render', 'search-public']) {
      const file = resolve(root, `packages/${name}/src/view.ts`);
      expect(checkSource(file, "import type { PublicView } from '@researchforce/kernel/public-view';")).toEqual([]);
      expect(checkSource(file, "import { project } from '@researchforce/kernel/public-view';")).not.toEqual([]);
    }
  });

  it('keeps the kernel dependent only on domain and allows shared testing helpers in tests', () => {
    expect(checkSource(resolve(root, 'packages/kernel/src/view.ts'), "import {} from '@researchforce/markdown/render';")).not.toEqual([]);
    expect(checkSource(resolve(root, 'packages/kernel/src/view.ts'), "import { readFile } from 'node:fs';")).not.toEqual([]);
    expect(checkSource(resolve(root, 'packages/kernel/test/view.test.ts'), "import {} from '@researchforce/testing/fc';")).toEqual([]);
  });
});
