/**
 * Visual regression of every component (design "Visual regression", R45.1): each Design_System
 * component is screenshot-compared in both colour schemes at three widths (320, 768, 1280), so an
 * unintended change to a component's typefaces, type sizes, colours, spacing, or states is caught.
 *
 * Components are captured where they appear on the served pages, by their Design_System class, so
 * the snapshot is of the real rendered component rather than an isolated fixture. A component is
 * skipped on a run when no page in the targeted deployment shows it (for example the
 * Disclosure_Line or Dissent_Note blocks need published Withheld or dissenting content), which
 * keeps the suite valid against a minimal deployment while CI, with content on staging, captures
 * every component.
 *
 * "Both renderers": the Public_Site HTML comes from the string renderer and the Workspace from the
 * React adapter (packages/design). The same specs run against each by pointing
 * PRESENTATION_BASE_URL at the Public_Site and then at the Workspace; CI runs the two as separate
 * jobs and keeps a snapshot baseline per browser for each. Screenshots are updated in CI with
 * `npm run test:presentation -- --update-snapshots`.
 */
import { expect, test, type Page } from '@playwright/test';
import { COLOUR_SCHEMES, SNAPSHOT_WIDTHS, SWEEP_HEIGHT } from './support/helpers';

/** A Design_System component: its name, the first public page that shows it, and its root selector. */
interface Component {
  readonly name: string;
  readonly path: string;
  readonly selector: string;
}

/** Every presentational component named in the Design_System (design "Markup"), with where it shows. */
const COMPONENTS: readonly Component[] = [
  { name: 'header', path: '/', selector: '.rf-header' },
  { name: 'main navigation', path: '/', selector: '.rf-header .rf-nav' },
  { name: 'footer', path: '/', selector: '.rf-footer' },
  { name: 'footer navigation', path: '/', selector: '.rf-footer-nav' },
  { name: 'skip link', path: '/', selector: '.rf-skip-link' },
  { name: 'search box', path: '/search', selector: '.rf-search' },
  { name: 'form fields', path: '/submit/general', selector: 'form' },
  { name: 'submit button', path: '/submit/general', selector: '.rf-button' },
  { name: 'notice', path: '/search', selector: '.rf-notice' },
  { name: 'status label', path: '/projects', selector: '.rf-status' },
  { name: 'pagination', path: '/projects', selector: '.rf-pagination' },
  { name: 'citation block', path: '/', selector: '.rf-citation' },
  { name: 'attachment list', path: '/', selector: '.rf-attachments' },
  { name: 'data table', path: '/', selector: '.rf-table-scroll' },
  { name: 'disclosure line block', path: '/', selector: '.rf-disclosure-line' },
  { name: 'dissent note block', path: '/', selector: '.rf-dissent' },

  // Workspace-only components added by the UI rework (workspace-ui-rework task 11.1). They render
  // only on the authenticated Workspace deployment, so on the Public_Site run every one is absent
  // and captureIfPresent skips it, leaving the Public_Site baselines untouched. Each page is a
  // Workspace route that actually renders the component: the Dashboard card grid at `/`, the
  // moderation queue table at `/moderation`, and the Search screen's header and breadcrumb at
  // `/search`. The tabs component has no adopting screen yet, so its row is skipped on every
  // deployment until one renders `.rf-tabs`; the row is kept so the capture lands automatically
  // once a Workspace page shows it.
  { name: 'workspace card', path: '/', selector: '.rf-card' },
  { name: 'workspace page header', path: '/search', selector: '.rf-page-header' },
  { name: 'workspace breadcrumb', path: '/search', selector: '.rf-breadcrumb' },
  { name: 'workspace primary nav group', path: '/', selector: '.rf-nav-group' },
  { name: 'workspace queue table', path: '/moderation', selector: '.rf-table-scroll' },
  { name: 'workspace empty state', path: '/moderation', selector: '.rf-empty' },
  { name: 'workspace loading skeleton', path: '/', selector: '.rf-skeleton' },
  { name: 'workspace tabs', path: '/', selector: '.rf-tabs' },
];

/** Capture a component clip if it is present on the page, otherwise skip for this deployment. */
async function captureIfPresent(page: Page, component: Component, snapshotName: string): Promise<void> {
  const locator = page.locator(component.selector).first();
  const count = await locator.count();
  test.skip(count === 0, `No ${component.name} present at ${component.path} on this deployment.`);
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toHaveScreenshot(snapshotName);
}

for (const component of COMPONENTS) {
  for (const scheme of COLOUR_SCHEMES) {
    for (const width of SNAPSHOT_WIDTHS) {
      test(`${component.name} looks unchanged in ${scheme} at ${width}px`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: SWEEP_HEIGHT });
        const response = await page.goto(component.path, { waitUntil: 'networkidle' });
        expect(response?.ok(), `${component.path} should be served`).toBeTruthy();
        const snapshotName = `${component.name.replace(/\s+/g, '-')}-${scheme}-${width}.png`;
        await captureIfPresent(page, component, snapshotName);
      });
    }
  }
}
