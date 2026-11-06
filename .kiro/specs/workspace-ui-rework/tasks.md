# Implementation Plan: Workspace UI Rework (workspace-ui-rework)

## Overview

This plan delivers a presentational, information-architecture, and targeted UX-flow rework of the authenticated Workspace SPA (`apps/app/web/`) on top of the existing `@researchforce/design` tokens. It changes nothing about the server, the API contract, the data model, the routes, or what any action does; it reorganizes chrome, adds reusable components, and makes the dense curator/admin queues scannable with client-side filter and sort.

The implementation language is **TypeScript/TSX** throughout, matching the existing Workspace and design package. No property-based tests are added: the design deliberately omits a Correctness Properties section because this is UI rendering, information architecture, and thin view transforms over already-loaded data. Verification is by React Testing Library unit tests under `apps/app/web/test/`, neutral-tree builder tests under `packages/design/test/`, and the existing Playwright presentation suite under `tests/presentation/`.

The build order follows the design's dependency order: the shared component foundation first (CSS + neutral-tree builders), then the Workspace React wrappers, then the declarative nav config, then `PrimaryNav`, then `AppShell`, then the `Dashboard`, then per-screen adoption, and finally a deliberate presentation re-baseline and continuous-green gate. Each task keeps the repository continuously green: `tsc` reports zero errors, `npm run lint` passes (including import-boundary and copy checks), and `npm test` passes after the task.

Key invariants held across every task:

- New Design_System styling and static markup live in `packages/design/src/components.css` and `packages/design/src/components/`, importing only `@researchforce/domain`; interactive composition lives in the Workspace (`apps/app/web/src/`). This mirrors the existing `controls.ts` ↔ `ui.tsx` split (R14.3).
- Every new style resolves to an existing `--rf-*` token; a derived token is added to `tokens.ts` only where a component genuinely needs it, additively, so no existing token value changes (R7.6, R13.3).
- The Workspace imports Design_System code only through package entry points (`@researchforce/design/tokens`, `@researchforce/design/react`, and the new `@researchforce/design/components` barrel) (R14.3).
- No route path, route element, endpoint path/method/request shape, or action effect changes (R2, R5.6, R10).

## Tasks

- [x] 1. Build the Design_System component foundation (CSS + neutral-tree builders)
  - [x] 1.1 Add the new component CSS to `packages/design/src/components.css`
    - Add additive `.rf-*` classes using only existing `--rf-*` tokens: `.rf-card` / `.rf-card__header` (surface-raised, border-subtle, radius-md, space-lg); data-table/listing additions on `.rf-table` / `.rf-table-scroll` for sortable `<th>` affordance and `aria-sort` states; `.rf-tabs` / `.rf-tablist` / tab / tabpanel styles (accent selected indicator, border-subtle rule); `.rf-empty` empty state (muted text); `.rf-skeleton` / `.rf-skeleton__row` loading skeleton with a `--rf-duration-fast` pulse suppressed under the existing `@media (prefers-reduced-motion: reduce)` rule; `.rf-page-header` / `.rf-page-header__description` / `.rf-breadcrumb` page-header + breadcrumb; `.rf-layout` with `.rf-layout--wide` (max-inline-size `--rf-width-page`) and `.rf-layout--split` (CSS grid collapsing to one column below `48rem`)
    - If and only if a component genuinely needs one, add a single additive derived token (e.g. `--rf-colour-skeleton` from `--rf-colour-surface-raised`) in `tokens.ts` so `tokens.css` equals `tokensCss()`; add nothing that alters an existing token value
    - Keep the `48rem` (`md`) breakpoint as the single responsive threshold, reusing `BREAKPOINTS.md`
    - _Requirements: 6.1, 6.2, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 12.5, 13.3, 14.3_
  - [x] 1.2 Add neutral-tree builders in `packages/design/src/components/layout.ts` and `tabs.ts`
    - `layout.ts`: `pageHeader(...)`, `breadcrumb(...)` (`<nav aria-label="Breadcrumb"><ol>…</ol></nav>` with ancestor `<a href>` links and a final `aria-current="page"` item), `card(...)`, `emptyState(message, action?)`, and `pageLayout('wide' | 'split', children)` — each returning an `ElementNode`/`FragmentNode`, importing only `@researchforce/domain/tree`, matching the style of `content.ts`/`page.ts`
    - `tabs.ts`: the tablist/tab/tabpanel markup contract helper (ARIA roles, `id`s, `aria-controls`/`aria-labelledby`) and the skeleton markup helper
    - Re-export the new builders from `packages/design/src/components/index.ts` (the `@researchforce/design/components` barrel)
    - _Requirements: 6.1, 6.3, 7.1, 7.2, 7.4, 7.5, 7.7, 14.3_
  - [x] 1.3 Write design-package builder tests in `packages/design/test/`
    - Extend `components.test.ts` to assert the rendered-string markup, classes, and ARIA attributes of `pageHeader`, `breadcrumb`, `card`, `emptyState`, `pageLayout`, and the tabs/skeleton markup helpers, matching the existing `dataTable`/`siteHeader` assertion style
    - Confirm `tokens.test.ts` still passes (`tokens.css` equals `tokensCss()`), including any added derived token
    - _Requirements: 6.1, 6.3, 7.1, 7.2, 7.4, 7.5, 7.7, 13.3, 14.1_

- [x] 2. Build the Workspace React component wrappers in `apps/app/web/src/ui.tsx`
  - [x] 2.1 Implement `PageHeader`, `PageLayout`, and `Card` wrappers
    - `PageHeader({ title, description?, breadcrumb?, actions? })`: renders the single `<h1>` title, optional `<p class="rf-page-header__description">`, an optional breadcrumb `<nav aria-label="Breadcrumb">` whose links target existing ancestor route paths and whose last crumb is the current page without a link, and an `.rf-actions` cluster for `actions`
    - `PageLayout({ variant?: 'reading' | 'wide' | 'split', children })`: emits the correct `.rf-layout` class (`reading` leaves the default `.rf-main` reading measure untouched)
    - `Card({ heading?, headingHref?, children })`: `<section class="rf-card">` with an optional `.rf-card__header` heading that links via `headingHref`
    - All reuse the `.rf-*` classes from task 1; import Design_System only through package entry points
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 14.3_
  - [x] 2.2 Implement `DataTable`, `EmptyState`, and `LoadingSkeleton` wrappers
    - `DataTable<Row>({ caption, columns, rows })`: a semantic `<table class="rf-table">` with `<caption>`, a header row of `<th scope="col">`, and a `<tr>` per record inside the keyboard-focusable `.rf-table-scroll` region; when a column supplies `sortBy`, its `<th>` holds a sort `<button>` and the active column carries `aria-sort="ascending|descending"` (others `none`); per-row cells keep existing action links/buttons
    - `EmptyState({ message, action? })`: `<div class="rf-empty">` with an explanatory `<p>` and an optional action link/button
    - `LoadingSkeleton({ rows?, label? })`: `aria-hidden` `.rf-skeleton` placeholder blocks plus a visually-hidden `role="status"` "Loading…" for assistive tech
    - Generic over the existing response types in `apps/app/web/src/types.ts`; no type in `types.ts` changes
    - _Requirements: 7.2, 7.4, 7.5, 8.2, 11.4_
  - [x] 2.3 Implement the `Tabs` wrapper
    - `Tabs({ label, tabs, initial? })`: a `<div role="tablist">` of `<button role="tab" id="tab-{id}" aria-controls="panel-{id}" aria-selected>` with roving `tabindex` (active `0`, others `-1`) and Left/Right arrow-key focus movement; one `<div role="tabpanel" id="panel-{id}" aria-labelledby="tab-{id}">` per view with inactive panels hidden; switching is local state only and navigates to no route
    - _Requirements: 7.3, 7.7, 11.2, 11.4_
  - [x] 2.4 Implement the `useClientFilterSort` hook
    - `useClientFilterSort<Row>(rows, { filters?, sorts? })`: derives `visible` purely from `rows` already in state via `useMemo`; exposes `filterValue`/`setFilter` and `sortKey`/`setSort`; never calls `useApi`/`useLoad` and never changes any request
    - _Requirements: 9.1, 9.2, 9.3, 9.5_
  - [x] 2.5* Write RTL tests for the component wrappers in `apps/app/web/test/`
    - `PageHeader`/`Breadcrumb`: single `<h1>` title, breadcrumb `<nav aria-label="Breadcrumb">` with ancestor route-path links and a current-page item; `PageLayout`: reading vs wide vs split container classes; `Card`: grouping markup and optional linked heading
    - `DataTable`: semantic `<table>` with `<caption>`, `<th scope="col">`, a row per record, retained per-row action links, and sort-header toggle updating `aria-sort` and row order; `EmptyState` and `LoadingSkeleton` render expected roles/markup (`role="status"` loading label, `aria-hidden` skeleton)
    - `Tabs`: exposes `tablist`/`tab`/`tabpanel` with `aria-controls`/`aria-labelledby`/`aria-selected`; arrow keys move focus; selecting a tab shows the right panel without navigation
    - `useClientFilterSort`: filtering returns a subset of input rows and never a foreign row; sorting is a permutation of the filtered set; applying a filter/sort issues no request (mock `useApi` asserted uncalled)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 8.2, 9.1, 9.2, 9.3, 9.5_

- [x] 3. Checkpoint - component foundation green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Create the declarative navigation config in `apps/app/web/src/shell/nav-config.ts`
  - [x] 4.1 Define `NavLink`, `NavGroup`, and the `NAV_GROUPS` mapping
    - Define `NavLink { label; to; permission? }` (`to` is always an existing `routes.tsx` path; `permission` from `@researchforce/domain/permissions`) and `NavGroup { label; links }`
    - Populate `NAV_GROUPS` from the design's group→link table: General (no permission), Curation and Administration links each carrying their required `Permission`, and You — mapping every destination the current `Header` links to, with URLs unchanged and only labels refined
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2_
  - [x] 4.2* Write RTL/unit tests for `nav-config` in `apps/app/web/test/`
    - Assert the set of `{to}` across `NAV_GROUPS` equals the set of destinations the current `Header`/`routes.tsx` links to (no destination dropped) and that every `to` matches an existing route path unchanged
    - Assert each Curation/Administration link carries the required permission and General/You links carry none
    - _Requirements: 1.1, 1.2, 2.1, 2.2_

- [x] 5. Implement `PrimaryNav` in `apps/app/web/src/shell/primary-nav.tsx`
  - [x] 5.1 Implement role-filtered, active-state, responsive navigation
    - `visibleGroups(session)` filters each group's links by `session.can(permission)` and omits groups left with no links; render one `<nav aria-label="Workspace">` of labelled `<section class="rf-nav-group">` regions, each with a visible heading naming its list and `<a class="rf-nav__link">` links
    - Mark exactly the link matching the current location (`isActive(pathname, to)`, a total function) with `aria-current="page"`; no match marks none
    - Add the collapse toggle `<button class="rf-nav-toggle" aria-expanded aria-controls="rf-primary-nav">` driving `.rf-primary-nav--open`; CSS from task 1 hides the toggle and expands the nav at/above `48rem` and collapses by default below it
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 3.2, 3.3, 4.2, 4.3, 4.4, 4.5, 4.6, 11.4_
  - [x] 5.2* Write RTL tests for `PrimaryNav` in `apps/app/web/test/`
    - For a Contributor session, curation/admin groups with unpermitted links are omitted while General and You are always present; for an Administrator, all groups present
    - At a given `MemoryRouter` location, exactly the matching link has `aria-current="page"`; an unmatched location marks none
    - The toggle flips `aria-expanded` and reveals/hides the nav; above threshold the nav is expanded without activating the toggle
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 3.1, 3.2, 3.3, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 6. Implement `AppShell` and rewire the frame in `apps/app/web/src/shell/app-shell.tsx`
  - [x] 6.1 Build `AppShell`, preserving the exact session gating
    - Replace the `Header` + `Workspace` frame with `AppShell`: skip link to `#main`, `header.rf-header` with the brand link to `/`, `PrimaryNav`, and `ActivityBadges`; `main#main.rf-main` with `StatusNotices`, keeping the verbatim `/me` + `/roles` + `sessionFor` load, the `session === null` `LoadState`, the profile-incomplete gate rendering `ProfileForm`, and otherwise `WorkspaceRoutes` inside `SessionContext.Provider`
    - Rewire `apps/app/web/src/routes.tsx` and `main.tsx` to render `AppShell` (keep `Workspace` as a thin alias or point `main.tsx` at `AppShell`); remove only `Header`/`StartPage`/the old frame; change no `<Route path=.../>` and no route element
    - _Requirements: 2.3, 2.4, 4.1, 10.4, 11.1_
  - [x] 6.2* Write/adapt RTL tests for the shell in `apps/app/web/test/shell.test.tsx`
    - Assert the skip link targets `#main`, the brand, `PrimaryNav`, `StatusNotices`, and the main region render on every page, and the profile-incomplete gate still renders `ProfileForm`
    - Assert every route path still renders its existing page component (iterate the route table), confirming no route changed
    - Update existing header-link-list assertions to the new grouped structure while preserving their behavioral intent
    - _Requirements: 2.1, 2.3, 2.4, 4.1, 10.4, 10.5, 11.1_

- [x] 7. Implement the `Dashboard` in `apps/app/web/src/dashboard/dashboard.tsx`
  - [x] 7.1 Build the four regions plus new-record controls
    - Replace `StartPage` at route `/` with `Dashboard`: a `Card` region each for My reviews (`GET /reviews/queue` → `/reviews`), My drafts (`GET /drafts` → `/me/drafts`), My work (`GET /me/dashboard` → `/me/work`), and Recent activity (`GET /feed` → `/activity`), each reading via `useLoad` exactly as the existing screens do, with a short summary of the first few items and a "View all" link to the full destination
    - Each region shows a `LoadingSkeleton` while loading, an `EmptyState` with a short explanation when the resolved result is empty, and the existing `LoadState` on error (never an empty state on error)
    - Keep the current start-page new-record affordance verbatim: a "Submit a new record" `Card` listing `SUBMITTABLE_KINDS` from `items/forms/model.ts`, each linking to `/items/new/${kind}` with `ITEM_KIND_NAMES[kind]`
    - Add no endpoint and change no request shape
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 10.2_
  - [x] 7.2* Write RTL tests for the dashboard in `apps/app/web/test/`
    - With mocked `useLoad`, each region shows skeleton while loading, an empty state when empty, and a summary linking to the correct full destination when populated; new-record links target `/items/new/{kind}`
    - Assert the dashboard's requested paths equal `{/reviews/queue, /drafts, /me/dashboard, /feed}` and match the existing request shapes (no new endpoint)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 10.2_

- [x] 8. Checkpoint - shell and dashboard green
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Adopt `DataTable` + client filter/sort on the curator/admin queues
  - [x] 9.1 Rework the moderation queue (`apps/app/web/src/moderation/queue.tsx`)
    - Render the already-loaded rows through `DataTable` inside `PageLayout variant="wide"` with a `PageHeader`: columns reference, type, state, project/general, submitter, received, response target (keeping the overdue `rf-status rf-status--danger` mark and the `<Link to={/moderation/${id}}>` inside cells)
    - Keep the existing server-side `type`/`state`/`project`/`contactReview` query params unchanged; add client-side `useClientFilterSort` affordances over the loaded rows only; show an `EmptyState` when the queue is empty and when a client filter matches nothing; keep every existing action/link
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2_
  - [x] 9.2 Rework the review queue (`apps/app/web/src/reviews/reviews.tsx`, `/reviews/queue`)
    - Render loaded rows through `DataTable` in a `wide` layout with a `PageHeader`: columns target, requester, addressees, requested-at, retaining the existing review actions/links per row; add client filter/sort; show an `EmptyState` when empty or when a filter matches nothing
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2_
  - [x] 9.3 Rework the disclosure screens (`apps/app/web/src/disclosure/records.tsx`)
    - Unclassified (`/disclosure/unclassified`): render the grouped counts as a `DataTable` of group label and count linking to the existing destinations; Public overview (`/disclosure/public-units`): columns kind, project, root item, rights, effective, last projected; both in a `wide` layout with a `PageHeader`, client filter/sort, and `EmptyState` on empty / no-match
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2_
  - [x] 9.4 Rework the evidence queue (`apps/app/web/src/evidence/queue.tsx`, `/evidence/queue`)
    - Render loaded rows through `DataTable` in a `wide` layout with a `PageHeader`: columns unit, kind, root item, project, reason, retaining links; add client filter/sort; show an `EmptyState` when empty or when a filter matches nothing
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2_
  - [x] 9.5* Write/adapt RTL tests for the reworked queues in `apps/app/web/test/`
    - For each reworked queue (moderation, reviews, disclosure unclassified + public overview, evidence): rows render via `DataTable`, an `EmptyState` shows when empty and when a client filter matches nothing, and every existing link/action remains reachable
    - Assert each queue's server request path/method/shape is unchanged and that client filter/sort issues no new request (mock `useApi`/`useLoad` asserted for request shape)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2_

- [x] 10. Roll `PageHeader`/`PageLayout` across the priority reading screens
  - [x] 10.1 Adopt `PageHeader` + reading `PageLayout` on Project and Project log screens
    - Add a `PageHeader` (title, optional breadcrumb to existing ancestor routes) and the reading-width `PageLayout` to the Project and Project log screens, keeping all existing data loads, links, and actions unchanged
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 10.1, 10.4_
  - [x] 10.2 Adopt `PageHeader` + `PageLayout` on item/record and search screens
    - Add a `PageHeader` with breadcrumb and the appropriate `PageLayout` (`reading` for the record body, `split` where metadata sits beside the body) to the item/record and search screens, keeping all existing behavior, requests, and actions unchanged
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 10.1, 10.4_
  - [x] 10.3* Write/adapt RTL tests for the reading-screen adoption in `apps/app/web/test/`
    - Assert each adopted screen renders a single `<h1>` via `PageHeader`, a breadcrumb `<nav aria-label="Breadcrumb">` whose links target existing ancestor route paths, and the expected layout container class, with existing behavioral assertions preserved
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 10.4, 10.5_

- [x] 11. Non-regression gate and deliberate visual-regression re-baseline
  - [x] 11.1 Add new component rows to `tests/presentation/visual-regression.spec.ts` and re-baseline the Workspace snapshots only
    - Add `COMPONENTS` rows for the new components (name, a Workspace page that shows them, `.rf-*` selector: `.rf-card`, `.rf-table-scroll`, `.rf-tabs`, `.rf-empty`, `.rf-skeleton`, `.rf-page-header`, `.rf-breadcrumb`, grouped `.rf-nav`) captured in both schemes at 320/768/1280
    - Regenerate only the Workspace visual-regression baselines with `--update-snapshots` and confirm the Public_Site baselines are untouched (shared additive classes used only by the Workspace leave Public_Site snapshots unchanged)
    - _Requirements: 12.6, 13.2_
  - [x] 11.2 Confirm the full presentation suite and continuous-green checks pass
    - Confirm `accessibility.spec.ts` (axe-core, WCAG 2.2 AA, both schemes) reports no new violation on the reworked pages, and `colour-scheme.spec.ts`, `print-pdf.spec.ts`, `viewport-sweep.spec.ts`, and `privacy-crawl.spec.ts` pass unchanged
    - Confirm `tsc` reports zero errors, `npm run lint` passes (including import-boundary `no-restricted-imports` and copy checks), and `npm test` passes
    - _Requirements: 10.5, 11.5, 12.1, 12.2, 12.3, 12.4, 12.6, 13.1, 13.2, 14.1, 14.2, 14.3, 14.4_

- [x] 12. Final checkpoint - full suite green
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; core implementation sub-tasks are never marked optional.
- Each task references the specific requirement sub-clauses it implements for traceability back to `requirements.md`.
- No property-based tests are included: the design intentionally omits a Correctness Properties section (this is UI rendering, IA, and thin view transforms), so verification is RTL unit tests, design-package builder tests, and the existing Playwright presentation suite.
- Checkpoints (tasks 3, 8, 12) ensure incremental validation; the repository stays continuously green after every task (tsc 0, lint clean, tests passing).
- The only deliberate rendered-output change is re-baselining the Workspace visual-regression snapshots in task 11.1; the Public_Site baselines and every non-snapshot presentation assertion stay unchanged.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5", "4.1"] },
    { "id": 4, "tasks": ["4.2", "5.1"] },
    { "id": 5, "tasks": ["5.2", "6.1"] },
    { "id": 6, "tasks": ["6.2", "7.1"] },
    { "id": 7, "tasks": ["7.2", "9.1", "9.2", "9.3", "9.4", "10.1", "10.2"] },
    { "id": 8, "tasks": ["9.5", "10.3", "11.1"] },
    { "id": 9, "tasks": ["11.2"] }
  ]
}
```
