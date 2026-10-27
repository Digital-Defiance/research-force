import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fontsCss } from '@researchforce/design/fonts';
import { tokensCss } from '@researchforce/design/tokens';

/** Writes `tokens.css` and `fonts.css` from their modules; tests fail while either file differs from what this writes. */
const target = (name: string): string => fileURLToPath(new URL(`../packages/design/src/${name}`, import.meta.url));
writeFileSync(target('tokens.css'), tokensCss());
writeFileSync(target('fonts.css'), fontsCss());
process.stdout.write('Wrote packages/design/src/tokens.css and fonts.css\n');
