/**
 * Print the ResearchForce.org Installation_Public_Copy (R46.41, R46.42) as the single-line JSON the `PUBLIC_COPY`
 * binding expects, validated first so a broken bundle is never stored. The wording lives in
 * `@researchforce/design/researchforce-copy` (encoded verbatim from docs/instance/researchforce-org-content.md); this
 * keeps it out of committed wrangler config, as docs/instance/installation.md requires.
 *
 *   npx tsx tools/public-copy-json.ts | npx wrangler secret put PUBLIC_COPY [--env staging]
 */
import { validatePublicCopy } from '@researchforce/design/installation';
import { RESEARCHFORCE_PUBLIC_COPY } from '@researchforce/design/researchforce-copy';

const issues = validatePublicCopy(RESEARCHFORCE_PUBLIC_COPY);
if (issues.length > 0) {
  console.error(`The public copy is incomplete:\n${issues.map((issue) => `  ${issue.field}: ${issue.rule}`).join('\n')}`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(RESEARCHFORCE_PUBLIC_COPY));
