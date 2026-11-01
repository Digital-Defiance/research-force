import { FONT_LICENCES, fontsCss } from '@researchforce/design/fonts';
import { tokensCss } from '@researchforce/design/tokens';
import { ASSETS_DIR } from './paths';
import type { ExportFile } from './manifest';

/** The relative font-file base `fonts.css` uses inside the package: the font binaries sit beside the stylesheets under `assets/fonts/`. */
const FONT_BASE = 'fonts/';

/**
 * A notice that names every font family in the package and the licence file that must accompany its copies (R45.20). The render layer lists
 * the licences here; the job (task 38.2) copies the font binaries and the licence `.txt` files the notice names under `assets/fonts/`.
 */
export function fontLicenceNotice(): string {
  const lines = [
    'Typefaces in this package are self-hosted under the licences named below.',
    'Each licence text is included under assets/fonts/licences/.',
    '',
    ...FONT_LICENCES.map((licence) => `${licence.families.join(', ')}: ${licence.file}`),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * The text assets the render layer produces under `assets/` (R45.1, R45.20): the Design_System token and font stylesheets and the font
 * licence notice. `components.css` and the font binaries and licence texts are files on disk that the job copies beside these.
 */
export function assetFiles(): ExportFile[] {
  return [
    { path: `${ASSETS_DIR}/tokens.css`, content: tokensCss(), contentType: 'text/css; charset=utf-8' },
    { path: `${ASSETS_DIR}/fonts.css`, content: fontsCss(FONT_BASE), contentType: 'text/css; charset=utf-8' },
    { path: `${ASSETS_DIR}/fonts/LICENCES.txt`, content: fontLicenceNotice(), contentType: 'text/plain; charset=utf-8' },
  ];
}
