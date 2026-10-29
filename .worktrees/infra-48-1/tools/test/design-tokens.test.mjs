import stylelint from 'stylelint';
import { expect, it } from 'vitest';
import config from '../../stylelint.config.mjs';

it.each(['color: red', 'color: #fff', 'color: rgb(0 0 0)', 'box-shadow: 0 0 red', 'padding: 12px', 'width: 50%', 'font-family: serif', 'font-weight: 700', 'line-height: 1.5', 'padding: var(--rf-space-page, 12px)', '--sneaky-space: 12px'])('rejects raw visual values: %s', async (declaration) => {
  const result = await stylelint.lint({ code: `main { ${declaration}; }`, codeFilename: 'apps/app/web/src/example.css', config });
  expect(result.errored).toBe(true);
});

it('accepts tokens and structural zero values', async () => {
  const result = await stylelint.lint({ code: 'main { color: var(--rf-colour-text); margin: 0 auto; padding: var(--rf-space-page); }', codeFilename: 'apps/app/web/src/example.css', config });
  expect(result.errored).toBe(false);
});

it('allows definitions only inside the canonical token file', async () => {
  const result = await stylelint.lint({ code: ':root { --rf-space-page: 2rem; }', codeFilename: 'packages/design/src/tokens.css', config });
  expect(result.errored).toBe(false);
});
