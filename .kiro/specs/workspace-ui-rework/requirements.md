# Requirements Document

## Introduction

The Workspace is the authenticated single-page application of the research-collab-cms project, served from `apps/app/web/` (entry `main.tsx`, shell and routing `routes.tsx`, shared components `ui.tsx`, app styles `styles.css`). It is feature-complete across 30+ areas (projects, project log, items of ~11 kinds, search, members and profiles, reviews, moderation, consent, disclosure, releases, exports, backups, imports, admin settings/policy/value-sets, work coordination, decisions, citations, evidence, drafts, proposals, dual approvals, notifications, activity). It is backed by the `@researchforce/design` design system in `packages/design/src/` (`tokens.css`, `components.css`, `fonts.css`, `print.css`, plus React primitives in `components/` and `react.ts`).

The Workspace is functionally complete but presentationally basic in four concrete ways: (1) the header is a flat, undifferentiated list of ~30 links that is not grouped, not role-aware, has no active state, and does not collapse responsively; (2) the start page is a stub (an `<h1>` and a bare list of record kinds to submit) with no dashboard; (3) the component layer lacks cards, data tables, tabs, side-nav, breadcrumbs, a page-header pattern, empty states, and loading skeletons; (4) there is no information-architecture or data-density system (no two-column layouts, no filtering or sorting affordances, no scannable record tables for curator and admin screens).

This spec defines a **presentational, information-architecture, and targeted UX-flow rework** of the Workspace SPA. It introduces a grouped, role-aware application shell, a real start dashboard, a set of new design-system components built on the existing tokens, and client-side filtering and sorting affordances on high-density curator and admin queues. It changes nothing about server behavior, the API contract, the data model, routes, or what any action does, and it preserves every existing accessibility and presentation guarantee.

This spec is distinct from and does not modify the parent `research-collab-cms` spec. It inherits that spec's behavioral and accessibility obligations as non-regression constraints.

## Glossary

- **Workspace**: The authenticated React SPA at `apps/app/web/`, rendered by the `Workspace` and `WorkspaceRoutes` components in `routes.tsx`.
- **Design_System**: The `@researchforce/design` package at `packages/design/src/`, comprising design tokens (`tokens.css`, `tokens.ts`), component styles (`components.css`, `print.css`), fonts (`fonts.css`, `fonts.ts`), and React primitives (`react.ts`, `components/`).
- **Design_Token**: A named CSS custom property defined in `tokens.css`/`tokens.ts` for type scale, spacing, colour, surfaces, borders, and focus rings.
- **App_Shell**: The persistent Workspace frame comprising the brand, the primary navigation, the skip link, workspace-wide status notices, and the main content region.
- **Primary_Navigation**: The grouped, role-aware navigation that replaces the current flat link list, listing the Workspace destinations organized into labelled groups and filtered by the viewer's Role.
- **Navigation_Group**: A labelled set of related navigation links within the Primary_Navigation (for example, a general group for all Members and curation or administration groups shown only to authorized Roles).
- **Role**: A Member's assigned role, as carried by the `Session` in `session.tsx`, whose permissions are tested through `session.can(permission)`.
- **Session**: The signed-in Member context from `session.tsx`, exposing `me`, `roles`, and `can(permission)`.
- **Dashboard**: The reworked Workspace start page (route `/`) presenting what needs the viewer's attention and recent activity, replacing the current stub `StartPage`.
- **Page_Header**: A reusable component presenting a page title, optional description, optional breadcrumb trail, and optional actions.
- **Breadcrumb**: A navigational trail within a Page_Header that shows the viewer's location in the Workspace hierarchy and links to ancestor pages.
- **Card**: A reusable surface component that groups related content with a consistent border, padding, and surface token.
- **Data_Table**: A reusable component that presents a collection of records as scannable rows and columns with a semantic table structure.
- **Listing**: A Data_Table or equivalent scannable presentation of a record collection, used on queue and index screens.
- **Tabs**: A reusable component that presents sibling views of a page and lets the viewer switch between them without navigating away.
- **Empty_State**: A reusable component shown in place of a Listing or region when it has no content, giving a short explanation and any relevant next action.
- **Loading_Skeleton**: A reusable placeholder shown while a region's data is loading, occupying the region's expected shape.
- **Page_Layout**: The consistent layout system that constrains reading-focused pages to a readable measure and allows wide or two-column layouts for dense pages.
- **Reading_Width**: A constrained line length for reading-focused pages that keeps text legible.
- **Curator_Admin_Queue**: A high-density screen for curation or administration, specifically the moderation queue, the review queue, the disclosure screens (Unclassified, Public overview), and the evidence queue.
- **Filter_Affordance**: A client-side control that narrows a Listing's visible rows using data already loaded into the client, without issuing a new server request.
- **Sort_Affordance**: A client-side control that reorders a Listing's visible rows using data already loaded into the client, without issuing a new server request.
- **Colour_Scheme**: A light or dark presentation, selected by the `prefers-color-scheme` media feature.
- **Presentation_Suite**: The Playwright tests under `tests/presentation/` (`accessibility.spec.ts`, `colour-scheme.spec.ts`, `print-pdf.spec.ts`, `privacy-crawl.spec.ts`, `viewport-sweep.spec.ts`, `visual-regression.spec.ts`).
- **Unit_Suite**: The Vitest/React Testing Library tests under `apps/app/web/test/` (including `test/properties/`) and the design-system and public-render tests that run in the repository's test command.
- **Public_Site**: The public-facing output from `packages/public-render` and `apps/site-shell`, which shares Design_System tokens and components and is governed by its own Playwright and Lighthouse budgets.

## Requirements

### Requirement 1: Grouped, role-aware primary navigation

**User Story:** As a Member, I want the Workspace navigation grouped and filtered to my Role, so that I can find the destinations relevant to me without scanning an undifferentiated list of thirty links.

#### Acceptance Criteria

1. THE Primary_Navigation SHALL present the Workspace destinations organized into labelled Navigation_Groups rather than a single flat list.
2. THE Primary_Navigation SHALL present a general Navigation_Group of destinations to every signed-in Member.
3. WHERE the viewer's Role grants a curation or administration permission, THE Primary_Navigation SHALL present the corresponding curation or administration Navigation_Group to that viewer.
4. WHERE the viewer's Role does not grant a curation or administration permission, THE Primary_Navigation SHALL omit the Navigation_Group that requires that permission from that viewer's navigation.
5. WHEN a Navigation_Group is presented, THE Primary_Navigation SHALL present a visible label identifying that Navigation_Group.
6. THE Primary_Navigation SHALL decide each Navigation_Group's visibility using the viewer's Session permissions as reported by `session.can`.

### Requirement 2: Navigation preserves all existing destinations and URLs

**User Story:** As a Member who relies on existing links and bookmarks, I want every current destination to remain reachable at its current URL, so that the rework does not break navigation or saved locations.

#### Acceptance Criteria

1. THE Primary_Navigation SHALL link to every destination that the current header links to, using the same route path for each destination.
2. WHERE the Primary_Navigation retitles a navigation link, THE Primary_Navigation SHALL link that retitled label to the same route path the current header uses for that destination.
3. THE Workspace SHALL keep every route path defined in `routes.tsx` unchanged.
4. WHEN a Member navigates directly to any existing route path, THE Workspace SHALL render the same page component that route currently renders.

### Requirement 3: Active navigation state

**User Story:** As a Member, I want the navigation to show which section I am in, so that I can orient myself within the Workspace.

#### Acceptance Criteria

1. WHILE a Workspace page is displayed, THE Primary_Navigation SHALL present the navigation link whose route matches the current location in a visually distinct active state.
2. WHILE a Workspace page is displayed, THE Primary_Navigation SHALL mark the active navigation link with `aria-current` set to `page`.
3. WHERE no navigation link matches the current location, THE Primary_Navigation SHALL present no navigation link in the active state.

### Requirement 4: Responsive, collapsing application shell

**User Story:** As a Member on a narrow viewport, I want the navigation to collapse into a toggleable control, so that the Workspace remains usable on small screens.

#### Acceptance Criteria

1. THE App_Shell SHALL present the brand, the Primary_Navigation, the skip link, the workspace-wide status notices, and the main content region on every Workspace page.
2. WHILE the viewport is at or below a defined narrow-layout threshold, THE App_Shell SHALL present the Primary_Navigation in a collapsed form controlled by a labelled toggle control.
3. WHEN the viewer activates the navigation toggle control while the navigation is collapsed, THE App_Shell SHALL reveal the Primary_Navigation.
4. WHEN the viewer activates the navigation toggle control while the navigation is revealed, THE App_Shell SHALL collapse the Primary_Navigation.
5. THE navigation toggle control SHALL expose its expanded or collapsed state through `aria-expanded`.
6. WHILE the viewport is above the narrow-layout threshold, THE App_Shell SHALL present the Primary_Navigation in its expanded form without requiring the viewer to activate the toggle control.

### Requirement 5: Start dashboard

**User Story:** As a Member, I want the start page to show what needs my attention and recent activity, so that I can act on my work immediately instead of reading a bare list of record kinds.

#### Acceptance Criteria

1. WHEN a Member opens the route `/`, THE Dashboard SHALL present regions for the Member's reviews, the Member's drafts, the Member's work, and recent activity.
2. WHILE a Dashboard region is loading its data, THE Dashboard SHALL present a Loading_Skeleton in that region.
3. IF a Dashboard region has no content after loading, THEN THE Dashboard SHALL present an Empty_State in that region.
4. WHEN the Dashboard presents a region summarizing the Member's reviews, drafts, work, or recent activity, THE Dashboard SHALL link that region to the existing destination for that content.
5. THE Dashboard SHALL present the controls for submitting a new record that the current start page presents, linking each to the same `/items/new/{kind}` route.
6. THE Dashboard SHALL read its data from the existing Workspace API endpoints without introducing a new endpoint or changing an existing request shape.

### Requirement 6: Reusable layout and page-header components

**User Story:** As a Member reading Workspace pages, I want a consistent page header and layout, so that every page is legible and I always know where I am.

#### Acceptance Criteria

1. THE Design_System SHALL provide a Page_Header component presenting a page title, an optional description, an optional Breadcrumb trail, and an optional set of page actions.
2. THE Design_System SHALL provide a Page_Layout system offering a Reading_Width layout for reading-focused pages and a wide or two-column layout for dense pages.
3. WHEN a Page_Header presents a Breadcrumb trail, THE Page_Header SHALL render the Breadcrumb as a navigation region whose links target the ancestor pages' existing route paths.
4. WHEN a Page_Header presents a page title, THE Page_Header SHALL render the title as the page's level-one heading.
5. THE Page_Layout SHALL constrain Reading_Width pages to a line length that keeps body text legible.

### Requirement 7: Reusable content components

**User Story:** As a Member, I want consistent cards, tables, tabs, empty states, and loading placeholders across the Workspace, so that content is scannable and the interface feels coherent.

#### Acceptance Criteria

1. THE Design_System SHALL provide a Card component that groups related content using the existing surface, border, and spacing Design_Tokens.
2. THE Design_System SHALL provide a Data_Table component that renders a record collection using a semantic table structure with a header row and column headers.
3. THE Design_System SHALL provide a Tabs component that presents sibling views and lets the viewer switch the displayed view.
4. THE Design_System SHALL provide an Empty_State component that presents a short explanation and an optional next action.
5. THE Design_System SHALL provide a Loading_Skeleton component that occupies the expected shape of the content it replaces while data loads.
6. THE Design_System SHALL build every component in this requirement using the existing Design_Tokens without introducing a third-party UI component library.
7. WHEN the Tabs component presents its tabs and panels, THE Tabs component SHALL expose the `tab`, `tablist`, and `tabpanel` roles with the ARIA relationships that associate each tab with its panel.

### Requirement 8: Scannable curator and admin queues

**User Story:** As a curator or administrator, I want the high-density queues presented as scannable tables, so that I can review many records efficiently.

#### Acceptance Criteria

1. THE Workspace SHALL present each Curator_Admin_Queue as a Listing using the Data_Table component.
2. WHEN a Curator_Admin_Queue has records to present, THE Listing SHALL present each record as a row with the record's identifying columns.
3. IF a Curator_Admin_Queue has no records, THEN THE Workspace SHALL present an Empty_State in place of the Listing.
4. THE Workspace SHALL keep each Curator_Admin_Queue's existing actions and links available from its reworked Listing.

### Requirement 9: Client-side filtering and sorting on queues

**User Story:** As a curator or administrator, I want to filter and sort a queue without reloading, so that I can focus on the records that matter to me.

#### Acceptance Criteria

1. WHERE a Curator_Admin_Queue presents a Filter_Affordance, THE Workspace SHALL narrow the Listing's visible rows to those matching the Filter_Affordance using data already loaded into the client.
2. WHERE a Curator_Admin_Queue presents a Sort_Affordance, THE Workspace SHALL reorder the Listing's visible rows according to the Sort_Affordance using data already loaded into the client.
3. WHEN the viewer applies a Filter_Affordance or a Sort_Affordance, THE Workspace SHALL update the Listing without issuing a new server request.
4. IF applying a Filter_Affordance leaves no visible rows, THEN THE Workspace SHALL present an Empty_State indicating that no records match the active filter.
5. THE Filter_Affordance and the Sort_Affordance SHALL operate only on the records the server has already returned, without changing the request the Workspace sends to the server.

### Requirement 10: Behavior, routes, and API non-regression

**User Story:** As a maintainer, I want the rework to change only presentation and information architecture, so that the server, the data model, and every action behave exactly as before.

#### Acceptance Criteria

1. THE Workspace SHALL preserve the behavior of every existing action, so that each action produces the same effect it produces before the rework.
2. THE Workspace SHALL send each existing Workspace API request with the same path, method, and request shape it uses before the rework.
3. THE rework SHALL make no change to the server, the API contract, or the data model.
4. THE rework SHALL keep every route path in `routes.tsx` and the page component each route renders.
5. WHEN the Unit_Suite runs after the rework, THE Unit_Suite SHALL pass.

### Requirement 11: Accessibility non-regression

**User Story:** As a Member who relies on assistive technology or keyboard operation, I want every accessibility guarantee preserved, so that the reworked Workspace remains fully operable.

#### Acceptance Criteria

1. THE App_Shell SHALL present a skip link that moves focus to the main content region, as the current shell does.
2. THE Workspace SHALL keep every interactive control operable by keyboard alone.
3. WHEN an interactive control receives keyboard focus, THE Workspace SHALL present a visible focus indicator for that control.
4. THE Workspace SHALL present each interactive control with an accessible role and an accessible name.
5. WHEN the Presentation_Suite's `accessibility.spec.ts` runs after the rework, THE Presentation_Suite SHALL report no accessibility violation it does not report before the rework.

### Requirement 12: Colour-scheme, contrast, and print non-regression

**User Story:** As a Member reading in either colour scheme or printing a page, I want the reworked Workspace to keep its contrast, light-and-dark support, and print styling, so that it stays legible everywhere.

#### Acceptance Criteria

1. THE Workspace SHALL support both the light Colour_Scheme and the dark Colour_Scheme, following the viewer's `prefers-color-scheme`.
2. THE Workspace SHALL present text against its background at a contrast ratio of at least 4.5:1 in both Colour_Schemes.
3. THE Workspace SHALL present interface components and their visual states against their background at a contrast ratio of at least 3:1 in both Colour_Schemes.
4. THE Workspace SHALL keep its print styling, so that printed pages render with the existing print presentation.
5. WHILE the viewer's `prefers-reduced-motion` setting requests reduced motion, THE Workspace SHALL suppress non-essential motion in any component the rework introduces.
6. WHEN the Presentation_Suite's `colour-scheme.spec.ts`, `print-pdf.spec.ts`, `viewport-sweep.spec.ts`, and `visual-regression.spec.ts` run after the rework, THE Presentation_Suite SHALL pass.

### Requirement 13: Privacy and public-site non-regression

**User Story:** As a maintainer of the Public_Site, I want the Workspace rework to leave shared tokens and the public privacy guarantees intact, so that the public output does not regress.

#### Acceptance Criteria

1. WHEN the Presentation_Suite's `privacy-crawl.spec.ts` runs after the rework, THE Presentation_Suite SHALL pass.
2. WHERE the rework changes a shared Design_Token or shared Design_System component, THE rework SHALL keep the Public_Site's existing presentation and its Playwright and Lighthouse budgets within their current limits.
3. THE rework SHALL add Design_Tokens only where a new component requires them, and SHALL preserve the existing Design_Tokens' values that the Public_Site depends on.

### Requirement 14: Build and continuous-green non-regression

**User Story:** As a maintainer, I want the rework delivered without breaking the build or the checks, so that the repository stays continuously green.

#### Acceptance Criteria

1. WHEN the repository's type check runs after the rework, THE type check SHALL report zero errors.
2. WHEN the repository's lint runs after the rework, THE lint SHALL report no error, including its import-boundary and copy checks.
3. THE Workspace SHALL keep its imports within the existing import-boundary rules, importing Design_System code only through the `@researchforce/design` package entry points.
4. WHEN the repository's full test command runs after the rework, THE test command SHALL pass.
