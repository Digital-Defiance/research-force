import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression: workerd throws "Illegal invocation" when the global fetch is stored on an object and called as a method
// (`this.#fetch(...)`). Found on the first staging invite. Every default must wrap the global so it is called unbound.
const FILES = [
  '../../apps/ops/src/access.ts', '../../apps/ops/src/alerts.ts', '../../apps/ops/src/analytics.ts', '../../apps/ops/src/containment.ts', '../../apps/ops/src/deploy.ts', '../../apps/ops/src/waf.ts',
  '../../apps/app/src/mail/provider.ts', '../../apps/app/src/mail/providers/graph.ts',
];

describe('default fetch wrappers', () => {
  it.each(FILES)('%s never defaults a fetcher to the bare global fetch', (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    expect(source).not.toMatch(/typeof fetch = fetch\b/);
  });
});
