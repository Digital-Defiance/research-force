export default {
  plugins: ['./scripts/stylelint-design-tokens.mjs'],
  rules: {
    'block-no-empty': true,
    'color-no-invalid-hex': true,
    'color-named': 'never',
    'declaration-block-no-duplicate-properties': true,
    'researchforce/design-tokens': true,
  },
  overrides: [{ files: ['packages/design/src/tokens.css'], rules: { 'researchforce/design-tokens': null, 'color-named': null } }],
  ignoreFiles: ['**/node_modules/**', '**/dist/**', '**/.cache/**', '**/.wrangler/**'],
};
