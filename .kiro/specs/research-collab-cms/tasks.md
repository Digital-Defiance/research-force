# Implementation Plan: Research Force (research-collab-cms)

## Overview

Research Force is the MIT-licensed reusable software product; ResearchForce.org is the first independent installation. All tasks follow the design's "Product and installation boundary": installation identity, trusted origins, fixed policy text, initial Project, sending configuration, Responsible Person, and content licence must not be universal ResearchForce.org constants. The instance runner or owner chooses the content licence explicitly; ResearchForce.org's choice remains undecided. Software licensing does not grant rights over stored research. Private research and real instance data stay outside source history.

The plan builds ResearchForce in TypeScript as one npm workspace with the packages, Workers, Durable Objects, D1 databases, and R2 buckets that design.md defines. It starts with the parts that carry the most risk and that everything else depends on: the scaffold, the domain types and the Role_Permission_Map, the D1 schemas, and the privacy core (the kernel, the public renderers, and the static public search index), which are pure code and can be tested with fast-check before any Worker exists. Authentication, the save pipeline with its transactional outbox, and the feature areas follow in the order the request lists. A few items move earlier than that list because later steps depend on them:

- The Journal_Parser and Journal_Printer come with the Markdown package, so an early migration dry-run can report the attachments that the journal does not reference (design open question 4) before any import code exists.
- The Design_System foundations come before the public renderers that use them; accessibility, print, performance, and the Policy_Page editing come later as requested.
- Project creation, ordering, and featuring come with the core records, because every Research_Item needs a Project and the home page lists Featured_Projects. The Project_Log and Project lists come later.
- The Log_Summary and the Group_Note come with the core submissions, because Requirement 41.2 makes the Log_Summary part of every submission. Dissent_Notes come later as requested.
- Files come before publishing, because the Publisher copies Public Attachment files.
- The `Budget` Durable Object comes with the public submission API, because that API and AI drafting both depend on it. Usage monitoring and alerts come later as requested.

Points that the design leaves open are implemented as written and kept in one place each, so that a later answer is a small change:

| Open point | Implemented as | Single location |
|---|---|---|
| Plain-text email part (design open question 1) | Graph JSON `sendMail` with one HTML body and Exchange's conversion for the plain-text part | `apps/app/src/mail/providers/graph.ts`, `BODY_MODE = 'html-with-exchange-conversion'` |
| Residual provider copies (resolved) | Verify tenant behavior and disclose residual mailbox and delivery-record retention | `STATE_MAILBOX_RESIDUAL_COPIES = true` and generated policy evidence |
| Static search under API exhaustion (resolved) | Search stays available; dynamic forms/views follow separate admitted budgets | `PUBLIC_SEARCH_FOLLOWS_BUDGET = false` in `apps/app/src/budget/status.ts` |
| Journal-unreferenced attachments (open question 4, closed: R26.15) | Reported early by the dry-run; imported under the Project's Unassigned_Attachments_Source | `resolveAttachmentParent()` in `packages/markdown/src/journal/attachments.ts` (an `undefined` result means unassigned) |
| AI_Drafting_Setting default (open question 7) | Starts On | `SETTINGS.aiDrafting.default` in `packages/domain/src/settings.ts` |
| Backup freeze (resolved) | Bounded renewable lease, snapshot invalidation on expiry, independent watchdog and recovery | `apps/app/src/recovery/leases.ts` and shared write predicates |
| Item_Identifier format (open question 12) | 12 random Crockford base-32 characters in groups of four | `ITEM_ID_FORMAT` in `packages/domain/src/identifiers.ts` |

Tests use synthetic data only. No task copies, quotes, or commits content from the existing journal or its attachments. The dry-run and the import read those files from paths the user gives, the dry-run prints only counts, phase identifiers, line ranges, and file names, and the import creates every unit Not_Published and Unclassified.

### Canonical build order after the 27 October review

The JSON graph at the end is the single scheduling source. Checked leaf tasks form an inherited baseline whose evidence is reconciled in 57.1. Remaining waves are serial barriers; every leaf appears exactly once across baseline and waves. Tasks 19.1, 57.1–57.5, 67.1 and the local environment in 50.1–50.3 are complete; 30.6 is the next remaining leaf. Its reconciled task 52 evidence leaves 52.4–52.6 open. A historical parent can remain checked only while all its leaf acceptance is complete; 30 is reopened for the identified gaps. Task 52's verified portions are reconciled without rerunning an applied migration; unfinished 52.4/52.5 follow the privacy helpers and 52.6 follows the Workspace lists.

| Milestone | Required scope and order |
|---|---|
| Repair and local walkthroughs | Status audit 57.1; local runner 50; Resource_Profile and compatible chunk foundations; reopened 19.1, 30.6–30.8 and 30.11; idempotency/real-channel regressions; reconcile existing access implementation 52 through the audit; retain unfinished integration in its dependent phase |
| Team collaboration | Question Workspace; bibliography/decision/release schemas; work and Question lifecycle; precise citations/derivations; decisions; compute reproducibility; durable drafts/proposed edits; navigation |
| Privacy and public archive implementation | Shared Owner/permission snapshot data before kernel gates and disclosure callers; holds/dual approvals and moves; imports/logs/Dissent; complete 52.4/52.5 after their privacy helpers and 52.6 after 40.3; independent publication epochs/containment/admission; Publisher; public Questions/releases/exports and required properties |
| Complete feature scope | Public submission, moderation and emailed permission flows; AI drafting; full policy and presentation. All remain disabled in production until the appropriate gate passes. |
| Recovery and operational assurance | Complete table inventory; encrypted format and lease helpers before backup/restore callers; automatic independent copies; fresh restore rehearsal; compatibility/retention/alerts, browser security and measured capacity |
| Release acceptance | Prepare all infrastructure/staging/gate tooling, then operator setup and real verification; team-archive gate before sole-copy custody; public gate before serving research; outside-service gate before enabling dynamic public endpoints; final 49 |

Tasks 26/27 code already exist in the inherited baseline; feature additions still extend their event/preference/recipient rules. The graph linearizes shared helpers before callers: 55.2 before moves, field-version/idempotency before new records, permission coverage before apply, codec/preflight before restore, and publication/permission gates before serving releases. Every authoritative new table is registered for backup/format migrations when added. This is an implementation schedule, not authorization to activate a paid service, publish content, or ingest sole-copy research before its release evidence passes.

Canonical phases: `repair` → `collaboration` → `privacy` → `imports_and_log` → `publication` → `outside_and_ai` → `recovery` → `release_tooling` → `staging_and_acceptance` → `production_activation`

## Tasks

- [x] 1. Set up the repository scaffold and tooling
  - [x] 1.1 Create the npm workspace and TypeScript project layout
    - Root `package.json` with workspaces `packages/*`, `apps/*`, and `tools`; `tsconfig.base.json` (strict, ES2023, bundler resolution) and TypeScript 6 project references
    - Packages `domain`, `kernel`, `markdown`, `manifest`, `design`, `public-render`, `search-public`, `db`, `testing`; apps `app` (Worker in `apps/app/src`, React 19 SPA with react-router 7 and Vite 8 in `apps/app/web`), `site-shell` (Vite), `submit`, `dl`, `ops`; each with `package.json` and `tsconfig.json`; each package exposes its modules through a wildcard subpath export (`"./*": "./src/*.ts"`), so later tasks add modules without editing a shared barrel file
    - Install the toolchain once in the root `package.json`: TypeScript, Vite, React, react-router, oxlint, stylelint, Vitest, fast-check, `@cloudflare/vitest-pool-workers`, Wrangler, Drizzle ORM and drizzle-kit, Playwright
    - Root scripts `lint`, `typecheck` (`tsc -b`), `test` (`vitest --run`), and `ci` (all three in order)
    - _Requirements: 28.1, 28.3_
  - [x] 1.2 Configure oxlint, stylelint, and package import boundaries
    - `.oxlintrc.json` with `no-restricted-imports` rules that enforce the design's "May import" column; `public-render` and `search-public` must not import `db`, and `kernel` imports only `domain`
    - TypeScript project references that mirror the same boundaries, so a forbidden import fails the type check
    - `stylelint.config.mjs` that refuses raw colour, size, spacing, and font values outside `packages/design/src/tokens.css`
    - _Requirements: 24.5, 24.6, 45.1_
  - [x] 1.3 Set up Vitest, fast-check, and the Workers test pool
    - `vitest.config.ts` with a `node` project for pure packages and a `workers` project using `@cloudflare/vitest-pool-workers` (Miniflare D1 with FTS5, R2, Durable Objects) for `apps/*`; every script runs `vitest --run`, never watch mode
    - `packages/testing/src/fc.ts`: fast-check defaults of 100 runs, `FC_RUNS` override for nightly 1,000-run jobs, failing-seed logging, and the tag comment format `// Feature: research-collab-cms, Property N: <title>`
    - `packages/testing/src/clock.ts`: a simulated clock for time-dependent tests
    - _Requirements: 28.3_
  - [x] 1.4 Create Wrangler configurations for `rf-app`, `rf-submit`, `rf-dl`, and `rf-ops`
    - `apps/app/wrangler.jsonc`: SPA static assets with `run_worker_first` for `/api/*`, D1 bindings `rf-core`, `rf-search`, `rf-public`, R2 bindings `rf-private` and `rf-public`, the `AI` binding, SQLite-backed Durable Object classes `Publisher`, `Mailer`, `Budget`, `Jobs` (`new_sqlite_classes` migration), a service binding to `rf-ops`, and Cron Triggers `* * * * *` and `7 * * * *`
    - `apps/submit/wrangler.jsonc`, `apps/dl/wrangler.jsonc`, `apps/ops/wrangler.jsonc` with the bindings from the design's component table; `workers_dev: false` and `preview_urls: false` on every Worker; a `staging` environment block in each; features permitted by the explicitly selected Operating_Profile; profile certification is completed in 57.2
    - _Requirements: 1.3, 28.1, 28.4, 28.6_

- [x] 2. Build the domain foundations: types, dates, and rich text
  - [x] 2.1 Define the core domain types and text utilities
    - `packages/domain/src/types.ts`: ULID ids, ISO 8601 UTC millisecond timestamps, `UnitType`, `ItemKind`, `Level`, `RevisionKind`, `EventType`, `MemberStatus`, Submission kinds, `CreditEntry`, `DisclosureLine`, `PartialDate`
    - `packages/domain/src/text.ts`: `cpLength` (Unicode code points), `isBlank` (whitespace-only counts as empty), and helpers that never normalize stored text
    - `packages/domain/src/tree.ts`: the neutral element tree that the `markdown` overlay and the `design` components produce and the Design_System renderers consume
    - _Requirements: 2.2, 23.1, 45.1, 45.13_
  - [x] 2.2 Implement dates and time zones in `packages/domain/src/dates.ts`
    - Partial dates at day, month, or year precision with an approximate flag, ranges, sort keys at the start of the period, and the "end falls entirely before start" check
    - Item_Date and Log_Date computation; display as "5 May 1943", "May 1943", or "1943" with the approximate mark; ISO 8601 export forms; metadata date forms
    - Recorded times in the viewer's Profile time zone through `Intl`, or in UTC marked "UTC"; inclusive local date ranges converted to UTC instants; "today" in a given time zone
    - _Requirements: 6.7, 18.9, 21.5, 43.2, 45.12, 45.23_
  - [x] 2.3 Write property test for dates and times
    - **Property 91: Dates and times follow precision and zone rules**
    - **Validates: Requirements 6.7, 45.12, 45.23**
  - [x] 2.4 Implement the RichText span model in `packages/domain/src/richtext.ts`
    - `RichText` and `Span` types (quote, paraphrase, source_reported, lang, mention) with UTF-16 offsets on code point boundaries
    - `validateSpans` naming each faulty span and reason (blank or over-long sources, Quote and Paraphrase on one character, languages outside the ISO 639-1 list, two language marks on one character)
    - `applyEdit` that maps spans through a text change, `labelsOnlyChanged` that confirms a label edit leaves the text unchanged, and `mentionsOf` that returns only picker-inserted Mention spans
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.7, 11.9, 16.8, 45.6_
  - [x] 2.5 Write property test for label edits
    - **Property 37: Labels never change text and follow edits**
    - **Validates: Requirements 11.7, 11.9, 45.6**
  - [x] 2.6 Write property test for label validity
    - **Property 38: Label and language-mark validity**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 45.6**

- [x] 3. Build the domain rules: value sets, identifiers, file kinds, settings, retention, permissions, and search text
  - [x] 3.1 Implement the configurable value-set rules in `packages/domain/src/value-sets.ts`
    - Pure operations add, rename, retire, and mark-as-permitting-publication, returning the new set or the rule broken: names of 1 to 50 characters unique ignoring letter case, the last value that is not retired, locked values (Open and Eliminated, Sent and Replied, Unknown), and Unknown never renamed or marked as permitting publication
    - `acceptsNewlySet(value)` refusing retired values; Methods_Term sets require a Public_Description of 1 to 500 characters when a value is added
    - _Requirements: 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12, 46.13_
  - [x] 3.2 Write property test for value sets
    - **Property 31: Configurable value sets behave uniformly**
    - **Validates: Requirements 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12**
  - [x] 3.3 Implement identifier generators in `packages/domain/src/identifiers.ts`
    - `ITEM_ID_FORMAT` and `newItemIdentifier()`: 12 Crockford base-32 characters from `crypto.getRandomValues` in groups of four, such as `K7QM-3XRW-9DPA`, with the lower-case registry key; this module is the only place the format is defined
    - `newSubmissionReference()`: `RS-` followed by ten random Crockford characters in two groups
    - _Requirements: 15.1, 15.6, 31.5_
  - [x] 3.4 Implement file kinds in `packages/domain/src/file-kinds.ts`
    - Map the lower-cased text after the last dot to PDF, image, archive, spreadsheet, CSV, structured data, text log, video, or other, using the design's extension table
    - _Requirements: 12.3_
  - [x] 3.5 Write property test for file kinds
    - **Property 44: File kind is a total function of the extension**
    - **Validates: Requirements 12.3**
  - [x] 3.6 Implement the settings registry in `packages/domain/src/settings.ts`
    - Every workspace-wide setting with its validator, allowed range, and default: Follow_Up_Interval, Email_Batch_Window, Direct_Upload_Threshold, Attachment_Size_Limit, Public_Upload_Size_Limit, Outside_Submission_Limits, Public_Traffic_Budget, configured Email_Provider, Recipient_Cap, AI_Drafting_Setting (default On, defined only here), AI_Input_Limit, and the Responsible_Person
    - Operational constants in the same module: slice sizes, the Bulk_Import write allowance of 30,000 rows per UTC day, and budget safety margins
    - _Requirements: 2.5, 10.8, 20.14, 20.25, 28.12, 44.11, 44.15, 46.37_
  - [x] 3.7 Implement retention constants and Retention_Table rows in `packages/domain/src/retention.ts`
    - One constant per kind of data listed in Requirement 46.19, read by the sweepers and by `retentionRows()`, which produces the Retention_Table rows for the Privacy page
    - _Requirements: 12.8, 31.8, 32.8, 35.6, 35.11, 36.3, 46.19, 46.20, 46.26_
  - [x] 3.8 Write property test for the Retention_Table
    - **Property 97: Retention_Table matches the retention constants**
    - **Validates: Requirements 46.19**
  - [x] 3.9 Implement the Role_Permission_Map in `packages/domain/src/permissions.ts`
    - Permission keys from the design's table; the built-in Contributor and Administrator Roles as one constant that matches Requirements 2.4 and 2.5 exactly; scope rules for own and any Items, the owner-only Log_Summary, Dissent_Note authorship, Do_Not_Name on and off, AI drafts, Project_Accents, Policy_Sections, and the Responsible_Person
    - `can(ctx, permission, target)` and `canAll(ctx, checks)` decided from the Role, Member_Status, and map as they stand; validation that an added Role draws its Permissions only from those the existing Roles grant; no Permission for withdrawing a Licence_Agreement
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.2, 13.8, 34.10, 41.3, 41.4, 42.5, 42.6, 44.13, 45.22, 46.16, 46.39_
  - [x] 3.10 Implement shared search text handling in `packages/domain/src/search-text.ts`
    - Normalization shared by the public index builder and the browser engine: NFKD, removal of combining marks, lower case, "ß" and "ẞ" to "ss", and tokens as runs of Unicode letters and digits
    - Query parsing into words and double-quoted phrases, and validation shared by Member search, public search, and the Project_Log: at least one letter or digit, at most 200 characters, and a date range whose end is not before its start
    - _Requirements: 21.3, 21.4, 21.9, 30.2, 30.3, 30.11, 43.8_

- [x] 4. Write the validation schemas for every record kind and setting
  - [x] 4.1 Implement zod schemas for Members, Profiles, Projects, and settings in `packages/domain/src/schemas/people.ts`
    - Invitation (Role required, address of at most 254 characters with one `@` and a dotted domain), Profile (display name 1 to 80, one or more distinct Specialties, up to 5 affiliations of at most 200, biography of at most 1,000, required IANA time zone, Daily_Digest hour), Project (name 1 to 100, description 1 to 500, Project_Slug rules and reserved names), Policy_Section (at most 20,000, required sections non-blank), Public_Description (1 to 500), Generic_Label (1 to 100), and every numeric setting through the settings registry
    - Every schema returns each failing field with the rule it breaks
    - _Requirements: 2.13, 3.1, 3.7, 10.8, 20.14, 20.25, 28.12, 34.8, 39.5, 44.15, 46.13, 46.28_
  - [x] 4.2 Implement zod schemas for Research_Item kinds in `packages/domain/src/schemas/items.ts`
    - Journal_Entry (title 1 to 200, phase identifier at most 200, section count and character limits for submissions, parser-created entries, and edits, dates in order), Finding (claim and Scope_Caveat 1 to 2,000; Withdrawn needs a reason), Source (title, Source_Kind, reliability, document date), Run (field limits, start time to the second with a zone, up to 20 distinct counts of at most 30 digits kept as strings, end not before start), Hypothesis (statement 1 to 10,000; Elimination_Scope at most 1,000), Correspondence (at least two Parties, date not after today in the saver's zone), Archival_Request (Sent and Replied rules), Topic (body 1 to 50,000), Log_Summary (1 to 2,000; required at submission except for Journal_Entry and Topic)
    - _Requirements: 4.4, 4.7, 5.5, 5.8, 6.6, 7.1, 7.8, 7.9, 8.2, 8.9, 9.5, 10.6, 10.7, 16.9, 41.1, 41.2_
  - [x] 4.3 Implement zod schemas for discussion, reviews, files, disclosure, edits, and outside submissions in `packages/domain/src/schemas/other.ts`
    - Reply and Group_Note (1 to 50,000; an empty Group_Note means none), Dissent_Note (1 to 2,000), Review_Request (addressees named at most once, note at most 2,000), Attachment metadata (title 1 to 255, caption at most 2,000, Origin 1 to 5,000) and `submissionReadiness(files)` (no file uploading, failed, or invalid), Disclosure_Line (kind 1 to 100, dated to year, month, or day, at most 20 Party labels, note at most 200), edit marks and reasons (1 to 1,000), Outside_Submission fields and the licence agreement, Removal_Request statements (1 to 5,000)
    - _Requirements: 12.2, 12.4, 12.9, 12.11, 17.2, 22.2, 22.9, 23.5, 31.2, 33.1, 41.8, 41.15, 42.17, 46.23, 46.33_
  - [x] 4.4 Write property test for the validators
    - **Property 27: Validators accept exactly the valid inputs**
    - **Validates: Requirements 3.1, 3.7, 4.7, 5.5, 5.8, 6.6, 7.1, 7.8, 7.9, 8.9, 9.5, 10.6, 10.7, 10.8, 12.2, 12.4, 12.9, 12.11, 16.9, 17.2, 20.14, 20.25, 22.2, 22.9, 28.12, 31.2, 33.1, 34.8, 39.5, 41.8, 41.15, 42.17, 44.15, 46.13, 46.23, 46.28, 46.33**

- [x] 5. Create the D1 schemas, migrations, seeds, and the guarded batch helper
  - [x] 5.1 Write the `rf-core` identity, configuration, and Project tables in `packages/db/src/schema/core/identity.ts`
    - `members` (unique `email_lc`, status, `created_at` as the invitation time, `invite_email_state`), `sessions`, `roles`, `role_permissions`, `profiles` (unique `display_name_key`), `profile_specialties`, `profile_affiliations`, `notification_prefs`, `muted_projects`, `config_values`, `methods_terms`, `settings`, `counters`, `projects` (unique name key, slug, and position; `slug_fixed_at`, accent, level, Disclosure_Line, `rev`, `updated_seq`); no column stores a password, password hash, or one-time PIN
    - _Requirements: 1.2, 2.2, 3.1, 39.4, 39.7_
  - [x] 5.2 Write the `rf-core` unit, link, and review tables in `packages/db/src/schema/core/units.ts`
    - `units` (with the Drizzle definition and indexes from the design), `research_items` (unique `item_identifier`, unique `import_row_key` when set), `journal_entries`, `je_members`, `entry_sections`, the kind tables, `run_counts` (digit strings), `correspondence_parties` (Consent_Status), `replies` (`is_group_note`), `attachments` (unique `supersedes_unit_id`), `dissent_notes`, `identifiers` (never deleted), `deletions`, `external_parties` (`name_fold`), `cross_links` (partial unique index over links that are not removed; index on `target_id`), `review_requests`, `review_addressees`
    - _Requirements: 13.3, 15.2, 15.6, 15.7, 23.1, 34.1, 34.4, 39.1_
  - [x] 5.3 Write the `rf-core` history, activity, and notification tables in `packages/db/src/schema/core/activity.ts`
    - `revisions` with a `BEFORE UPDATE` trigger that refuses every change, `policy_pages`, `policy_sections`, `submissions`, `flags`, `views`, `activity`, `activity_tags`, `notification_events`, `notifications`, `email_batches` (unique open batch per Member and group key), `outgoing_emails`
    - _Requirements: 18.1, 19.6, 20.1, 22.1, 22.11, 46.27_
  - [x] 5.4 Write the `rf-core` work, outside, and guard tables in `packages/db/src/schema/core/work.ts`
    - `outbox`, `staging_rows`, `uploads`, `jobs`, `import_rows`, `exports`, `outside_sessions`, `outside_submissions`, `outside_files`, `outside_responses`, `moderation_decisions` (rows never updated), `response_links` (token hashes); guard tables `_g_rev`, `_g_evidence`, `_g_superseding`, `_g_last_admin`, `_g_chain_tip`, `_g_decision_open`, `_g_preview_fresh`, `_g_log_summary_owner`, `_g_dissent_unique`, `_g_frozen`, each with one column `x INTEGER NOT NULL`
    - _Requirements: 4.1, 12.8, 31.3, 32.13, 46.20_
  - [x] 5.5 Write the `rf-search` and `rf-public` schemas in `packages/db/src/schema/search.ts` and `packages/db/src/schema/public.ts`
    - `search_docs`, the external-content FTS5 table `search_fts` (tokenizer `unicode61 remove_diacritics 2`, prefixes 2, 3, and 4) with sync triggers, `search_credits`; `public_views` (versioned, `valid_from_at` and `valid_to_at`), `search_forward`, `site_files`, `publish_runs`
    - _Requirements: 21.1, 21.3, 24.5, 35.2_
  - [x] 5.6 Generate the migrations and write the seed migration
    - Drizzle-kit migrations for the three databases, with the FTS5 table and triggers in raw SQL
    - `packages/db/src/seed/`: the built-in Roles and their Permissions; every value set with its initial values, locked values, and publication marks; a Public_Description for every initial Methods_Term (`methods-descriptions.ts`); the default settings from the settings registry; the six Policy_Pages with their fixed list of Policy_Sections and non-empty initial text for each required section (`policy-sections.ts`, holding `STATE_MAILBOX_RESIDUAL_COPIES = false` and naming Microsoft 365 and Workers AI in "Services that process data"); the change counter
    - _Requirements: 2.4, 2.5, 33.6, 46.12, 46.18, 46.32_
  - [x] 5.7 Implement the guarded batch helper and request accountant in `packages/db/src/batch.ts` and `packages/db/src/accountant.ts`
    - Builder that places guard statements (`INSERT INTO _g_<code>(x) SELECT NULL WHERE NOT (…)`), the change-counter increment as the second statement, `updated_seq` and `actor_id` stamping, Revision rows, outbox rows, and `json_each` bulk inserts into one `batch()`; refuses batches above 40 statements
    - Maps a NOT NULL failure on a guard table to its rule code for the API; the accountant sums `meta.rows_read` and `meta.rows_written` per request
    - _Requirements: 1.7, 4.1, 4.5, 28.3, 28.13_
  - [x] 5.8 Write integration tests for guards, the Revision trigger, and the schema
    - In the workers pool: a failing guard aborts the whole batch and names its rule; `UPDATE` on `revisions` is refused; a schema scan finds no password, password hash, or PIN column
    - _Requirements: 1.2, 4.1, 22.11_

- [x] 6. Build the privacy kernel in `packages/kernel`
  - [x] 6.1 Implement Effective_Disclosure in `packages/kernel/src/effective.ts`
    - `DNode`, `ancestors(n)` (Parent chain to the Root_Item, then the Project), and `effective(n)` as the design defines it: Unclassified units are Not_Published, any non-Public ancestor makes a unit Not_Published, and Entry_Sections, Replies, and Dissent_Notes also need a Full_Content Root_Item
    - _Requirements: 23.1, 23.3, 24.5, 26.5_
  - [x] 6.2 Implement the Public_View projection in `packages/kernel/src/project.ts`
    - `project(input)` returning a `PublicView` only for Public and Withheld units, with the fields of the design's view table for each unit type; Withheld views hold only the Disclosure_Line; Summary_Only views have no slot for Entry_Sections, Replies, Log_Summaries, or other free text; no view has a slot for review state, flags, Submitter addresses, or Consent_Status
    - Cross_Links presented by the other end's view (link, Disclosure_Line, or omitted), supersession notices for the last later Public version, withdrawal notices, first-public dates, Credits as display names (outside and imported Credits as the design states), Elimination_Scope with every Eliminated status, and non-withdrawn Dissent_Notes under Full_Content
    - _Requirements: 6.3, 8.3, 24.1, 24.2, 24.3, 24.4, 24.8, 24.9, 24.10, 24.13, 24.14, 29.2, 29.3, 29.4, 29.11, 29.12, 40.1, 40.5, 40.7, 42.8, 42.14_
  - [x] 6.3 Implement substitutions, profile projection, and invariant checks in `packages/kernel/src/substitute.ts`
    - Generic_Label in every Party field of an External_Party marked Do_Not_Name, including Disclosure_Line Party labels; `prefillCorrespondenceLine` for automatic and manual Withheld Correspondences
    - Every registered Member email address, matched ignoring letter case, replaced by "[email address removed]", with the positions of each replacement returned for previews; `projectProfile` returning exactly display name, Specialties, affiliations, and biography
    - Defensive projection as Withheld, with an `invariantBreaches` list for a System_Alert, for a Public Correspondence without Granted consent or a Public Attachment whose Rights_Status does not permit publication
    - _Requirements: 9.4, 33.4, 34.2, 34.5, 46.5, 46.9_
  - [x] 6.4 Implement preview diffs and publication gates in `packages/kernel/src/preview.ts`
    - `diffViews(before, after)`: every unit whose Public_View differs, every Party name those views show, every non-withdrawn Dissent_Note on a presented Log_Summary or Public_Summary whose resulting Effective_Disclosure is not Public, and each credited Member's Licence_Agreement state
    - `checkGates(change, state)`: rights, consent, licence agreements, Disclosure_Line validity, and the 1,000-unit limit, each failure naming the unit, the reason, and whether Withheld is offered
    - _Requirements: 23.5, 23.6, 23.14, 23.16, 26.14, 33.4, 34.2, 34.9, 39.13, 46.16, 46.17_
  - [x] 6.5 Write property test for Effective_Disclosure
    - **Property 1: Effective_Disclosure follows the ancestor rule**
    - **Validates: Requirements 23.1, 23.3, 24.5, 26.5, 47.9**
  - [x] 6.6 Write property test for public output confinement
    - Build `workspaceStateArb` in `packages/testing/src/workspace.ts` with a unique canary token in every field of every unit, Member, Party, and Outside_Submission
    - Build the public-channel registry `packages/testing/src/public-channels.ts`, register the kernel's view output as its first channel, and write the test so it checks every registered channel; later tasks register their channels here
    - **Property 5: Public outputs contain only Public_View content**
    - **Validates: Requirements 17.7, 20.6, 24.5, 24.6, 24.13, 30.10, 31.7, 31.9, 35.2, 40.6, 41.12, 42.8, 42.15, 51.5**
  - [x] 6.7 Write property test for preview diffs
    - **Property 14: Disclosure previews are exact diffs**
    - **Validates: Requirements 23.6, 23.16, 34.9, 39.13**

- [x] 7. Build Markdown rendering, the Journal_Parser and Journal_Printer, and the migration dry-run
  - [x] 7.1 Implement Markdown parsing, rendering, and mathematics in `packages/markdown/src/render.ts` and `packages/markdown/src/math.ts`
    - micromark and mdast with source positions, the GFM table extension, and a math extension that applies the delimiter rules of Requirement 45.15 outside code spans and code blocks
    - Temml MathML output at render time; an expression that fails shows its source with delimiters; HTML output escapes only `<`, `>`, `&`, and quotes and never normalizes text
    - _Requirements: 45.13, 45.15_
  - [x] 7.2 Implement the label and language overlay in `packages/markdown/src/overlay.ts`
    - Split text nodes at span boundaries; Quote as `<q>` with a visible "Quote · {source}" label or a same-page footnote for long spans; Paraphrase and Source_Reported as marked spans with visible labels and no quotation marks; `lang` on language-marked spans; one marked segment per block for spans that cross blocks
    - Output is the neutral element tree of `packages/domain/src/tree.ts`, so the Design_System's string renderer and React adapter render the same marks
    - _Requirements: 11.5, 11.6, 45.6_
  - [x] 7.3 Write property test for mathematics delimiters
    - **Property 93: Mathematics delimiters follow the rules**
    - **Validates: Requirements 45.15**
  - [x] 7.4 Implement the Journal_Parser in `packages/markdown/src/journal/parse.ts`
    - `ParsedEntry` and `ParsedSection` as the design defines them; one entry per top-level level-3 Phase_Heading with phase identifier, heading text, raw heading line, and 200-character title; a front-matter entry for blocks before the first Phase_Heading with the import key `front-matter` and the title rule of Requirement 27.2
    - One section per top-level block, per list item, per table body row, and one for each table header with its delimiter row; exact source slices with `sepBefore` and `trailing` separators; any non-whitespace text outside every block becomes an `unassigned` section with its line numbers
    - _Requirements: 26.1, 27.1, 27.2, 27.3, 27.4_
  - [x] 7.5 Implement the Journal_Printer and the rendered comparison in `packages/markdown/src/journal/print.ts` and `packages/markdown/src/journal/compare.ts`
    - Print each entry's heading line (stored raw line, or `### ` and the heading text when edited), each section after its separator whatever its Disclosure_Level, and the trailing text; separators for Member-added sections as the design states
    - `compareRendered(a, b)`: render both with the same renderer and settings, collapse whitespace runs outside code, ignore leading and trailing whitespace, and report per-entry mismatches with titles and source line ranges
    - _Requirements: 27.5, 27.6, 27.7, 27.8_
  - [x] 7.6 Implement attachment reference resolution in `packages/markdown/src/journal/attachments.ts`
    - `resolveAttachmentParent(entries, file)`: the first entry in source order whose content references the file by a link or image destination, an autolink, or a path token in text or a code span that equals the site path or ends with `/{file name}`; this function is the only place the rule lives
    - `unreferencedFiles(entries, files)` listing files that no entry references
    - _Requirements: 26.2, 26.12_
  - [x] 7.7 Write property test for the journal round trip
    - Use `journalMarkdownArb` in `packages/testing/src/journal.ts`: a synthetic block grammar with Phase_Headings, other headings, paragraphs, nested lists, tables, fenced code, math, HTML, link definitions, stray text, varied blank lines, and Unicode
    - **Property 66: Journal print and parse round trip**
    - **Validates: Requirements 27.5, 27.6**
  - [x] 7.8 Write property test for journal parsing completeness and rendering
    - **Property 67: Journal parsing loses nothing and preserves rendering**
    - **Validates: Requirements 26.1, 27.1, 27.2, 27.3, 27.4, 27.7**
  - [x] 7.9 Implement the migration dry-run tools
    - `tools/export-attachment-metadata.ts`: read the current site's attachment metadata module from a path given on the command line and write JSON with title, kind, credit, credit line, caption, size label, Origin, and site path
    - `tools/migration-dry-run.ts`: parse a journal Markdown file and the metadata JSON from given paths, and print the number of entries and sections, unassigned spans by line range, the printer comparison result, each attachment's Parent phase identifier, metadata entries that no entry references, and referenced files without metadata; the output holds only counts, phase identifiers, line ranges, and file names, never journal text
    - Neither tool copies the journal or its attachments into the repository
    - _Requirements: 26.2, 26.12, 27.4, 27.7, 27.8_
  - [x] 7.10 Run the dry-run on the existing journal and report the unreferenced attachments
    - Ask the user for the paths to the journal Markdown, the attachment folder, and the metadata module, run both tools, and report to the user the counts and the names of attachments that no entry references (the design measured 6) and of referenced files without metadata, so the user can answer design open question 4 before the import is built
    - _Requirements: 26.2, 26.12_

- [x] 8. Build the Design_System foundations in `packages/design`
  - [x] 8.1 Define the design tokens in `packages/design/src/tokens.css` and `packages/design/src/tokens.ts`
    - CSS custom properties for colours in light and dark schemes switched by `prefers-color-scheme` without stored state, the type scale, spacing, radii, and breakpoints; eight Project_Accents and the default accent; the token list exported for validation of accent choices
    - _Requirements: 45.1, 45.3, 45.16, 45.22_
  - [x] 8.2 Implement both renderers in `packages/design/src/render-string.ts` and `packages/design/src/react.ts`
    - Over the neutral element tree of `packages/domain/src/tree.ts`: `renderToString` producing escaped HTML for static outputs, and `toReact` producing React elements for the Workspace from the same tree and classes
    - _Requirements: 45.1, 45.13_
  - [x] 8.3 Write the fixed texts and the copy lint
    - `packages/design/src/fixed-texts.ts`: the Group_Statement, the About status section, the footer copyright statement (at most 3 sentences with the Content_Licence name and link as parameters), the People affiliation and no-profile statements, the Licence statement, the Corrections Response_Target statement, and the Privacy Responsible_Person statement template, each with a version date and typographic quotation marks and apostrophes
    - `tools/lint-copy.ts` wired into `npm run lint`: refuse straight quotation marks in fixed and generated text, and any email address, telephone number, postal address, donation, payment, or fundraising wording in fixed texts and templates
    - _Requirements: 45.14, 46.1, 46.2, 46.3, 46.6, 46.10, 46.15, 46.21, 46.35_
  - [x] 8.4 Implement the presentational components in `packages/design/src/components/`
    - Header with the ResearchForce link, footer (Group_Statement, copyright statement, links to the six Policy_Pages and the form), navigation, buttons, form fields with labelled errors, notices, status labels and companion-field blocks, label marks, citation block, Attachment list, tables, pagination, Disclosure_Line block, Dissent_Note block; 24 by 24 CSS pixel targets and visible focus
    - _Requirements: 29.10, 45.1, 45.2, 45.5, 46.2_
  - [x] 8.5 Add the self-hosted typefaces in `packages/design/fonts/` and `packages/design/src/fonts.css`
    - Fraunces, Inter, JetBrains Mono, STIX Two Text, and STIX Two Math under the SIL Open Font License, split by `unicode-range`, with `font-display: swap` and `size-adjust` fallback faces, and the licence notices collected for exports
    - _Requirements: 45.8, 45.13, 45.17, 45.20_
  - [x] 8.6 Write unit tests for font coverage and accent contrast
    - Read every font file's character map and check that each graphic character of the blocks Requirement 45.13 lists is covered in each stack; check every Project_Accent for at least 4.5:1 text and 3:1 interface contrast in both schemes
    - _Requirements: 45.4, 45.13, 45.22_
  - [x] 8.7 Write property test for label rendering
    - **Property 39: Labels render exactly over their characters**
    - **Validates: Requirements 11.5, 11.6**

- [x] 9. Build the public renderers in `packages/public-render`
  - [x] 9.1 Implement the public address scheme in `packages/public-render/src/paths.ts`
    - `/r/{Item_Identifier}`, `/a/{Item_Identifier}`, `/p/{slug}/…` with kind listings, `log`, `withheld`, `search`, and `submit`; pagination paths; no slug equal to a reserved name defined with the Project schema of task 4.1; every address built only from the identifier or slug and fixed text
    - `sitemap.xml` with Public and Withheld addresses only, and `robots.txt`
    - _Requirements: 24.5, 29.6, 29.7, 29.8, 39.5, 40.3, 40.8_
  - [x] 9.2 Implement the page frame and metadata in `packages/public-render/src/frame.ts` and `packages/public-render/src/meta.ts`
    - `lang="en"`, header, footer, the Project_Accent on Project_Section pages and on the pages of the Project's Items and Attachments only, times in UTC marked "UTC", `data-url` for print
    - `citation_title`, one `citation_author` per Credit name in page order, `citation_publication_date`, Open Graph tags (description only when a Public_Summary is set), and JSON-LD, all taken from the page's own view or fixed text; none of the citation tags or JSON-LD on Withheld pages
    - _Requirements: 29.10, 45.2, 45.3, 45.10, 45.11, 45.23, 46.2_
  - [x] 9.3 Implement the Research_Item and Attachment page templates in `packages/public-render/src/item-page.ts` and `packages/public-render/src/attachment-page.ts`
    - All fields of Requirements 24 and 29 for each view, companion fields in one block, the withdrawal notice, the Project link, the Citation_Line with an access-date placeholder, Public Attachments with Rights_Status, rights holder, terms, and licence coverage, the download address on `files.researchforce.org`, supersession notices, and Cross_Links as the views present them
    - Under Full_Content: the fields of the kind, the Log_Summary, Entry_Sections in order, the Reply tree, and Dissent_Notes after the Log_Summary; Withheld units and children as their Disclosure_Lines; Credit names linked to Public_Profiles while shown; every status, rating, Source_Kind, Rights_Status, relation label, label kind, Withheld label, field label, and notice linked to its Methods page entry
    - _Requirements: 8.3, 24.1, 24.2, 24.3, 24.4, 24.8, 24.9, 24.10, 24.13, 24.14, 24.15, 29.2, 29.3, 29.4, 29.9, 29.11, 29.12, 42.14, 46.8, 46.14_
  - [x] 9.4 Implement the listing, Project, and home page templates in `packages/public-render/src/listings.ts` and `packages/public-render/src/projects.ts`
    - Kind listings, the public Project_Log (Log_Summary and Dissent_Notes under Full_Content, Public_Summary under Summary_Only), and the Disclosure_Line listing, each in the specified order with 50 entries per page and previous and next links
    - The home page with Featured_Projects in Project_Order (Withheld ones as Disclosure_Lines without link or slug) or the no-featured notice, the projects listing, the Project page with its links, and the Withheld Project page showing only its Disclosure_Line; the Design_System `404.html`
    - _Requirements: 24.7, 29.1, 29.5, 29.13, 29.14, 40.1, 40.2, 40.3, 40.4, 40.5, 40.6, 40.7, 40.11_
  - [x] 9.5 Implement the Policy_Page and form page templates in `packages/public-render/src/policy.ts` and `packages/public-render/src/forms.ts`
    - About (status section, "About the group"), People (optional Introduction, profiles sorted ignoring case and diacritics, fixed statements, form link), Methods (sections, then every Methods_Term with its Public_Description under the specified headings, leaving out retired values no page presents), Licence, Privacy (Responsible_Person statement, sections, Retention_Table, removal link), and Corrections, each with its last-updated date
    - Static form pages `/submit`, `/p/{slug}/submit`, `/submit/general`, `/submit/correction`, `/submit/removal`, `/submit/removal/general`, and `/respond` with the preselections of Requirements 31.13, 46.18, and 46.21 built in
    - Register every page template of tasks 9.2 to 9.5 in `packages/testing/src/public-channels.ts`
    - _Requirements: 31.1, 31.13, 46.1, 46.5, 46.6, 46.10, 46.11, 46.15, 46.18, 46.21, 46.29, 46.35_
  - [x] 9.6 Write property test for complete public pages
    - **Property 16: Public pages are complete**
    - **Validates: Requirements 24.1, 24.2, 24.3, 24.9, 24.10, 24.14, 24.15, 29.9, 29.10, 29.11, 29.12, 45.2, 46.2, 46.8**
  - [x] 9.7 Write property test for public listings
    - **Property 18: Public listings are exact, ordered, and paged**
    - **Validates: Requirements 29.1, 29.5, 29.13, 29.14, 40.1, 40.2, 40.4, 40.11**
  - [x] 9.8 Write property test for page metadata
    - **Property 20: Page metadata derives from the page**
    - **Validates: Requirements 45.10, 45.11**
  - [x] 9.9 Write property test for the Methods page and term links
    - **Property 96: Methods page and term links**
    - **Validates: Requirements 46.11, 46.14**

- [x] 10. Build the static public search index and query engine in `packages/search-public`
  - [x] 10.1 Implement the index builder in `packages/search-public/src/build.ts`
    - One document per Public or Withheld Research_Item and Attachment from views only: a Research_Item's text in display order including its Entry_Sections, Replies, and non-withdrawn Dissent_Notes under Full_Content; an Attachment's title, caption, Origin, and Credit; a Withheld unit's Disclosure_Line only, with result kind Withheld
    - `/idx/manifest.json`, term buckets by 2-character prefix (split to 3 above 256 KB, 1-character terms in `_1`) with postings and positions, and 64 document shards with content-hashed names; register the index files in `packages/testing/src/public-channels.ts`
    - _Requirements: 30.1, 30.4, 30.9, 30.10, 30.12, 30.13_
  - [x] 10.2 Implement the browser query engine in `packages/search-public/src/engine.ts`
    - Validation through the shared search-text module; bucket fetches; whole-word and word-start matching for terms of two or more characters, whole words for one-character terms, and consecutive positions for phrases; filters by kind (including Withheld), inclusive date range on the displayed date, and Project; title-match-first then newest-first ranking; pages of 20
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.11, 30.12_
  - [x] 10.3 Implement excerpts in `packages/search-public/src/excerpt.ts`
    - Cut at most 300 characters around the first match in a result page's main content with its label markup and highlighted terms; Withheld results show only the Disclosure_Line and address with highlights; each Public result names its Project
    - _Requirements: 30.5, 30.9, 30.13_
  - [x] 10.4 Implement the public page scripts in `apps/site-shell/src`
    - `search.ts`: the search form running the engine in a Web Worker, limited by default to the Project when opened from its Project_Section; `citation-date.ts`: a script of about 1 KB that fills in the Visitor's local access date, with "accessed [date of access]" as the text without scripts
    - _Requirements: 29.9, 30.6, 30.12_
  - [x] 10.5 Write property test for public search
    - **Property 62: Public search returns exactly the matching Public_Views**
    - **Validates: Requirements 30.1, 30.2, 30.3, 30.4, 30.9, 30.12**

- [x] 11. Write the privacy-core property tests across the kernel, renderers, and public search
  - [x] 11.1 Write property test for Withheld units
    - **Property 6: Withheld units appear only as their Disclosure_Line**
    - **Validates: Requirements 24.4, 29.5, 30.9, 40.1, 40.2, 40.7, 45.11**
  - [x] 11.2 Write property test for Summary_Only presentation
    - **Property 8: Summary_Only exposes only the allowed fields**
    - **Validates: Requirements 24.13, 40.5, 40.6**
  - [x] 11.3 Write property test for Do_Not_Name substitution
    - **Property 10: Do_Not_Name substitution**
    - **Validates: Requirements 9.4, 34.5**
  - [x] 11.4 Write property test for Member email addresses
    - **Property 11: Member email addresses never appear publicly**
    - **Validates: Requirements 46.9, 46.34**
  - [x] 11.5 Write property test for public Cross_Links
    - **Property 17: Public Cross_Links follow the other end's view**
    - **Validates: Requirements 24.8**
  - [x] 11.6 Write property test for the public index and non-public text
    - **Property 63: Non-public text leaves the public index unchanged**
    - **Validates: Requirements 30.10**

- [x] 12. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [x] 13. Build the Worker foundation and the Authentication_Service in `rf-app`
  - [x] 13.1 Create the Hono API skeleton, error shape, and logging in `apps/app/src/api/app.ts`, `apps/app/src/api/errors.ts`, and `apps/app/src/log.ts`
    - `/api/v1` router; error responses `{ error, fields?, details? }` with the codes and HTTP statuses of the design's error table; `DAILY_LIMIT` mapping for D1 daily-limit errors
    - Structured logs of route, status, CPU time, and D1 rows from the accountant; a redactor that removes `Authorization` headers, token-shaped strings, email addresses, and bodies, and hashes Member ids
    - _Requirements: 20.20, 28.3, 28.9, 28.13_
  - [x] 13.2 Implement Access JWT verification in `apps/app/src/auth/jwt.ts`
    - Read `Cf-Access-Jwt-Assertion`; verify with `jose` against the team key set (RS256, `aud`, `iss`, `exp`, `iat` no more than 24 hours ago); cache keys in isolate memory and the Cache API for one hour and refetch once for an unknown `kid`; respond 401 before any data access when no valid key set is available
    - _Requirements: 1.3, 1.5, 1.8_
  - [x] 13.3 Implement sessions and Member_Status checks in `apps/app/src/auth/session.ts`
    - Session key as the SHA-256 of the assertion; one query joining `sessions` and `members`; a new hash looks up the Member by lower-cased verified email, activates a Pending Member, and inserts the session with `established_at = iat`; 403 without any write for an email of no Pending or Active Member; refusal of ended sessions and Revoked Members
    - `POST /api/v1/session/logout` marks the session ended and redirects to `/cdn-cgi/access/logout`; handlers read the acting Member only from the session context
    - _Requirements: 1.1, 1.4, 1.6, 1.7, 1.8, 1.9, 2.3, 2.9, 2.12_
  - [x] 13.4 Implement CSRF, Origin, and CORS checks in `apps/app/src/api/csrf.ts`
    - State-changing requests need the `X-RF-CSRF` header and an `Origin` of `https://app.researchforce.org`; CORS allows only the Workspace origin; `GET` routes have no side effects
    - _Requirements: 14.6_
  - [x] 13.5 Write property test for identity assertions
    - Use `jwtArb` in `packages/testing/src/jwt.ts` with test signing keys and mutations
    - **Property 21: Identity assertions gate every Workspace request**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.8, 2.9**
  - [x] 13.6 Write unit tests for logout and log redaction
    - Logout ends the session for that browser; logged lines contain no `Authorization` header, token, email address, or body text
    - _Requirements: 1.9, 20.20_

- [x] 14. Build access control, Members, and the `rf-ops` access sync
  - [x] 14.1 Create the `rf-ops` RPC entrypoint with Access list sync in `apps/ops/src/index.ts` and `apps/ops/src/access.ts`
    - A `WorkerEntrypoint` with no `fetch` route and methods `addMember(email)`, `removeMember(email)`, and `revokeSessions(email)` against the `rf-members` Access list and Access's revoke-user-sessions endpoint
    - `packages/testing/src/fake-ops.ts`: an in-memory fake of `rf-ops` for tests
    - _Requirements: 2.1, 2.9_
  - [x] 14.2 Enforce Permissions in handlers and add the Roles API in `apps/app/src/auth/authorize.ts` and `apps/app/src/api/routes/roles.ts`
    - Every handler checks all Permissions it needs with `canAll` before running any statement and refuses the whole request otherwise; read routes allow every active Member in every Role
    - `GET/POST /roles` with built-in Roles fixed and added Roles limited to existing Permissions; every Role picker lists all Roles
    - _Requirements: 2.3, 2.6, 2.7, 2.8_
  - [x] 14.3 Implement invitations in `apps/app/src/api/routes/members.ts`
    - `POST /members/invite`: validate, upsert the Member as Pending with the selected Role and `created_at` set to the invitation time, call `rf-ops.addMember`, and queue an `outgoing_emails` invitation row for the Mailer in the same batch as the Member change
    - _Requirements: 2.1, 2.2, 2.13_
  - [x] 14.4 Implement Role changes and revocation in `apps/app/src/api/routes/members.ts`
    - `PATCH /members/{id}/role` and `POST /members/{id}/revoke` with the `last_admin` guard inside the batch; revocation sets Revoked, calls `rf-ops.removeMember` and `revokeSessions`, and leaves every record's attribution unchanged
    - _Requirements: 2.9, 2.10, 2.11_
  - [x] 14.5 Write property test for Permission decisions
    - **Property 23: Permission decisions match the Role_Permission_Map**
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.2, 13.8, 34.10, 41.3, 41.4, 42.5, 42.6, 44.13, 45.22, 46.16, 46.39**
  - [x] 14.6 Write property test for the last active Administrator
    - **Property 24: At least one active Administrator remains**
    - **Validates: Requirements 2.11**
  - [x] 14.7 Write property test for Member identity
    - **Property 25: Member identity invariants**
    - **Validates: Requirements 2.1, 2.2, 2.13**

- [x] 15. Build Profiles, preferences, mutes, and Licence_Agreements
  - [x] 15.1 Implement the Profile API in `apps/app/src/api/routes/profile.ts`
    - `GET /me`, `PATCH /me/profile` (own Profile only, schema checks, retired Specialties refused), `GET /members/{id}/profile` with the 20 most recent Submissions and links, `PUT /me/preferences` (initially in-app On and email Immediate for every Event_Type; Daily_Digest hour initially 08:00), `PUT /me/mutes`, and `POST /me/licence-agreement` recording the UTC date and the Content_Licence name, with no route that withdraws one
    - Public_Profile changes to On return the `projectProfile` preview and apply only on confirmation; Profile changes write a `member:{id}` outbox row
    - _Requirements: 3.1, 3.2, 3.4, 3.7, 19.8, 19.9, 20.13, 39.10, 46.4, 46.16_
  - [x] 15.2 Implement the incomplete-Profile gate in `apps/app/src/auth/profile-gate.ts`
    - Respond `profile_incomplete` (428) to every Workspace route except the Profile routes while the display name, a Specialty, or the time zone is missing
    - _Requirements: 3.6_
  - [x] 15.3 Write property test for the Profile gate
    - **Property 26: Incomplete Profiles gate the Workspace**
    - **Validates: Requirements 3.6**

- [x] 16. Build the save pipeline and Projects
  - [x] 16.1 Implement the save pipeline in `apps/app/src/records/pipeline.ts`
    - Validate with the domain schemas, load the current revision, run data checks, build one guarded batch with the `rev` guard, the change counter, the writes, `revisionsFor(change)` (one Revision per Revision_Kind with the previous value of each changed field), automatic consequences, and outbox rows, then commit
    - Content edits require a Minor_Edit or Correction mark with no default and a reason for a Correction, except Restorations and saves that only change status, withdrawal, or disclosure fields; a 409 lists the Revisions saved since with Member and time
    - A label-only change is an edit of the field that contains it, with the same Permission checks and a Revision whose previous values include the old spans; the server confirms the text is unchanged
    - _Requirements: 4.1, 4.5, 4.9, 11.7, 11.8, 22.1, 22.2, 22.9, 22.10, 28.13_
  - [x] 16.2 Implement Projects in `apps/app/src/records/projects.ts` and `apps/app/src/api/routes/projects.ts`
    - Create (Not_Published, not featured, last in the Project_Order, creator and time recorded), edit with validation, refusal of a whole save that changes a fixed Project_Slug, featured toggle, `move-position` rewriting the positions between the old and new places in one batch, and Project_Accent set or clear from the palette by Administrators only
    - A Revision for every change (Disclosure_Change for level and Disclosure_Line, Minor_Edit otherwise), `GET /projects/{id}/history` with before and after values, and `project:{id}` outbox rows
    - _Requirements: 39.4, 39.5, 39.6, 39.7, 39.8, 39.18, 45.3, 45.4, 45.22_
  - [x] 16.3 Write property test for the Project_Order
    - **Property 76: Project_Order stays a permutation**
    - **Validates: Requirements 39.7**
  - [x] 16.4 Write property test for Project_Accents
    - **Property 94: Project_Accents apply only to their Project and only from the palette**
    - **Validates: Requirements 45.3, 45.22**

- [x] 17. Build Submissions, identifiers, Cross_Links, and External_Parties
  - [x] 17.1 Implement Submissions and identifier issue in `apps/app/src/records/submissions.ts`
    - Every unit carries `submission_id`; a normal Submission sets `completed_at` in the batch that creates its units; `visibleTo(memberId)` filters every Workspace query to completed Submissions; Item_Identifiers are inserted into `identifiers` with a retry on collision
    - A Research_Item needs an existing Project, with the preselection rule of Requirement 39.2 and the "an Administrator must first create one" message when none exists
    - _Requirements: 15.1, 15.6, 18.2, 18.11, 39.1, 39.2, 39.3_
  - [x] 17.2 Implement Cross_Links and Backlinks in `apps/app/src/records/links.ts` and `apps/app/src/api/routes/links.ts`
    - `POST /links` and `DELETE /links/{id}` recording origin, target, optional relation label, Member, and time whatever the levels and withdrawal states; refusal of self-links, missing or deleted ends, unknown or retired labels, and duplicates; removal by the adder or an Administrator recorded in the origin's history
    - Backlinks from the `target_id` index, 100 per page with no upper bound; each end shows the relation label, kind, title, Item_Identifier (the Root_Item's for Entry_Sections and Replies), and a withdrawal notice; citing evidence for a Finding records an Evidence_Link
    - _Requirements: 5.2, 15.2, 15.3, 15.4, 15.5, 15.7_
  - [x] 17.3 Implement External_Parties in `apps/app/src/records/parties.ts` and `apps/app/src/api/routes/parties.ts`
    - A new External_Party whose case- and diacritic-folded name equals an existing one needs confirmation; one Do_Not_Name flag and one Generic_Label per External_Party; any Member may turn the flag on with a valid Generic_Label; a non-Administrator turning it off is refused; changes write `party:{id}` outbox rows
    - _Requirements: 9.2, 34.4, 34.8, 34.10_
  - [x] 17.4 Write property test for Cross_Links and Backlinks
    - **Property 42: Cross_Links are unique and Backlinks complete**
    - **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.7**
  - [x] 17.5 Write property test for External_Party duplicate detection
    - **Property 99: External_Party duplicate detection ignores case and diacritics**
    - **Validates: Requirements 9.2**

- [x] 18. Build the Research_Item kinds with the Log_Summary and the Group_Note
  - [x] 18.1 Implement Journal_Entries in `apps/app/src/records/kinds/journal.ts`
    - Title, optional Campaign_Status from the set, phase identifier, start and end dates, related Members, and 1 to 5,000 ordered Entry_Sections; edits that add, change, reorder, or remove sections keep each surviving section's Disclosure_Level, Classification_State, Revisions, and Cross_Links, with the growth rule for entries larger than the caps
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8_
  - [x] 18.2 Implement Findings in `apps/app/src/records/kinds/finding.ts`
    - Default Finding_Status Open; the `evidence` guard for Confirmed and the `superseding` guard for Superseded, counting links saved in the same change; removal of the last such link refused with "change the Finding_Status first"; Withdrawn at submission needs a reason
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.8, 5.9_
  - [x] 18.3 Implement Sources and Runs in `apps/app/src/records/kinds/source.ts` and `apps/app/src/records/kinds/run.ts`
    - Source fields with the recoverer as a Member or External_Party, rights fields defaulting to Unknown, and partial document dates stored as given; Run fields, start time to the second with a zone, end time, Resume_Point, notes, and up to 20 counts stored as digit strings and never converted to numbers
    - _Requirements: 6.1, 6.2, 6.4, 6.6, 6.7, 7.1, 7.2, 7.3, 7.5, 7.8, 7.9, 33.1, 33.2_
  - [x] 18.4 Implement Hypotheses in `apps/app/src/records/kinds/hypothesis.ts`
    - Start Open; Eliminated needs a non-blank Elimination_Scope and an Evidence_Link with a Run or Finding, re-checked on edits and link removals; reopening by the Owner or an Administrator needs a reason and records a Status_Change with the previous Elimination_Scope; an Elimination_Scope change while Eliminated must be a Correction
    - _Requirements: 8.1, 8.2, 8.4, 8.6, 8.7, 8.9_
  - [x] 18.5 Implement Correspondences in `apps/app/src/records/kinds/correspondence.ts`
    - Title, date, channel, direction, content, at least two Parties, and one Consent_Status per External_Party per Correspondence, initially Not_Asked
    - Automatic consequence in the same batch: a Public Correspondence that gains a non-Granted External_Party or loses a Granted consent becomes Withheld with `prefillCorrespondenceLine`, with a Disclosure_Change attributed to the saving Member
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.6, 34.1, 34.3_
  - [x] 18.6 Implement Archival_Requests and Topics in `apps/app/src/records/kinds/archival.ts` and `apps/app/src/records/kinds/topic.ts`
    - Archive or desk and contact as Parties; the Sent and Replied rules; reply date and content as fields separate from the Thread; `isFollowUpDue(request, interval, ownerZone)`; Topics with title and body
    - _Requirements: 10.1, 10.2, 10.6, 10.7, 16.1_
  - [x] 18.7 Implement the Log_Summary and the Group_Note in `apps/app/src/records/log-summary.ts`
    - Log_Summary required at submission for every kind except Journal_Entry and Topic; the `log_summary_owner` guard refuses any change by another Member, even inside a request that changes other fields; an edit that empties an existing Log_Summary is refused with "a Log_Summary can be changed but not removed"; changes are Revisions with previous text and labels
    - A non-empty Group_Note is posted in the same Submission as a Reply flagged `is_group_note`, owned and credited by the submitter, placed first in the Thread
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8, 41.15_
  - [x] 18.8 Implement the Item routes in `apps/app/src/api/routes/items.ts`
    - `POST /items/{kind}`, `GET /items/{id}`, and `PATCH /items/{id}`; the item response carries the Owner's display name and current Specialties, the Credit, the Project name, and each unit's Disclosure_Level and Effective_Disclosure computed with the kernel over the loaded ancestors
    - _Requirements: 3.5, 23.9, 39.15_
  - [x] 18.9 Write property test for Journal_Entry edits
    - **Property 32: Journal_Entry edits preserve surviving sections and their order**
    - **Validates: Requirements 4.4, 4.8**
  - [x] 18.10 Write property test for the acting Member
    - **Property 22: The acting Member is the session Member**
    - **Validates: Requirements 1.7, 2.10**

- [x] 19. Build staged commits and the value-set and settings APIs
  - [x] 19.1 Implement staged commits in `apps/app/src/records/stages.ts` and `apps/app/src/api/routes/stages.ts`
    - Retain the stage routes and add the logical-field fragment protocol from 57.3: split inside a single Entry_Section or its spans, measure the full encoded JSON envelope against 512,000 bytes, and validate complete manifests, offsets, digests, totals and base revisions before commit.
    - A staged commit atomically installs complete immutable field-version references and old-version Revision references for the whole save; no request, staging row, field row, Revision or aggregate JSON may exceed the physical budget. Failed/lost responses reconcile the original operation key.
    - Test one 600,000-character ASCII section, one 600,000-emoji section, two million code points, span boundaries, oversized JSON escaping and crash/retry at every part. Existing journal round trips and identities must remain exact.
    - _Requirements: 4.1, 4.4, 4.10, 4.11, 11.10, 28.3, 28.10, 60.2_
  - [x] 19.2 Implement the value-set API in `apps/app/src/api/routes/value-sets.ts`
    - `GET/POST/PATCH /value-sets` applying the domain rules to every configurable set, Public_Description edits for Methods_Terms, and `value:{set}:{id}` outbox rows
    - _Requirements: 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12, 46.13_
  - [x] 19.3 Implement the settings API in `apps/app/src/api/routes/settings.ts`
    - `GET/PUT /settings` with each setting's validator, refusing out-of-range values with the allowed range shown
    - _Requirements: 2.5, 10.8, 20.14, 20.25, 28.12, 44.15_

- [x] 20. Build the transactional outbox consumers, cron, and sliced jobs
  - [x] 20.1 Implement the outbox reader and kicks in `apps/app/src/outbox.ts`
    - Per-topic reading in `seq` order with `done_at` marking; after a committed batch the handler sends a best-effort kick to the owning Durable Object with `ctx.waitUntil`
    - _Requirements: 4.1, 21.6, 24.12_
  - [x] 20.2 Implement the scheduled handler in `apps/app/src/cron.ts`
    - The every-minute trigger kicks every owner; the hourly trigger runs a list of sweeps, starting with deletion of staging rows older than 24 hours
    - _Requirements: 28.3_
  - [x] 20.3 Implement the sliced job runner in `apps/app/src/do/jobs.ts`
    - A `Jobs` Durable Object that processes one slice of about 5 ms per alarm, stores its cursor and progress in its SQLite storage and the `jobs` table, sets the next alarm while work remains, and pauses on a daily-limit error until after 00:00 UTC
    - _Requirements: 26.13, 28.3, 36.10_
  - [x] 20.4 Write integration tests for the outbox and the job runner
    - A lost kick is picked up by the next cron run; a job stopped by a simulated daily-limit error resumes from its cursor without repeating work
    - _Requirements: 26.13, 36.10_

- [x] 21. Build the Workspace SPA foundation and the record screens
  - [x] 21.1 Create the SPA shell in `apps/app/web/src/main.tsx`, `apps/app/web/src/routes.tsx`, and `apps/app/web/src/api.ts`
    - react-router routes; an API client that sends `X-RF-CSRF`, handles the error shape, reloads through Access on 401, and shows "saving is unavailable until 00:00 UTC" on every page after a `daily_limit` error or the platform's limit response; the "saving is paused for a backup" notice for `frozen`; the Profile form for `profile_incomplete`; the ResearchForce header link to the start page
    - _Requirements: 1.1, 3.6, 28.9, 28.13, 45.2_
  - [x] 21.2 Implement unsent-input persistence in `apps/app/web/src/persist.ts`
    - Mirror every editor's and form's field values into `sessionStorage` for the tab until the input is sent or discarded, restore them after a reload, and state that the input was not saved after a failure
    - _Requirements: 28.10, 28.13_
  - [x] 21.3 Build the rich-text editor in `apps/app/web/src/editor/`
    - CodeMirror 6 on the Markdown source with label and language-mark decorations and dialogs, span mapping through `applyEdit`, and a picker that inserts Mentions of active Members and non-retired Specialties as atomic ranges
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.9, 16.8, 45.6_
  - [x] 21.4 Build the submission and edit forms in `apps/app/web/src/items/forms/`
    - One form per Research_Item kind with the Project choice and preselection, the Log_Summary and Group_Note fields, field errors from 422 responses, the Minor_Edit or Correction choice with no default and the reason field, and the conflict view for 409 responses that keeps the input
    - _Requirements: 4.9, 22.2, 22.10, 39.2, 39.3, 41.2, 41.7_
  - [x] 21.5 Build the item pages in `apps/app/web/src/items/page.tsx`
    - Fields with their companion fields in the same section (Finding_Status and Scope_Caveat with every claim, the superseding Finding link, Source_Kind and reliability, the Resume_Point or its absence, the Elimination_Scope right after an Eliminated status), the Owner and Credit linked to Profiles, the Project name, Disclosure_Level and Effective_Disclosure, Cross_Links and Backlinks with their notices, the Log_Summary section with its author or "no Log_Summary recorded", and the Group_Note label
    - _Requirements: 3.5, 5.6, 5.10, 6.3, 7.4, 8.3, 15.3, 23.9, 39.15, 41.9_
  - [x] 21.6 Build the Profile and Member screens in `apps/app/web/src/people/`
    - Own Profile form, Profile view with recent Submissions, Notification_Preferences, digest hour, Muted_Projects, the Licence_Agreement checkbox (never preselected), and the Public_Profile preview and confirmation; for Administrators, invitations, Role changes, and revocations
    - _Requirements: 2.1, 3.1, 3.4, 19.8, 20.13, 39.10, 46.4, 46.16_
  - [x] 21.7 Build the Project screens in `apps/app/web/src/projects/`
    - Create and edit with the reserved slug names shown, the slug-fixed indicator, the featured toggle, order moves with buttons as well as dragging, the accent picker limited to the palette, and the Project history
    - _Requirements: 39.4, 39.5, 39.7, 39.18, 45.4, 45.5_

- [x] 22. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [x] 23. Build the History_Service
  - [x] 23.1 Implement history reconstruction and the history API in `packages/domain/src/history.ts` and `apps/app/src/api/routes/history.ts`
    - Pure `stateAt(current, revisions, point)` that undoes later Revisions from the current state
    - `GET /items/{id}/history` listing the creation and every Revision of the Item and its Entry_Sections, newest first, with Member, time, Revision_Kind, and reason, and the state immediately after a selected point
    - _Requirements: 22.1, 22.3, 22.11_
  - [x] 23.2 Implement comparisons in `packages/domain/src/compare.ts` and `GET /items/{id}/compare`
    - Field-by-field comparison of two points with both values, and word diffs (`diffWordsWithSpace`) that mark added and removed words, including label differences
    - _Requirements: 22.4_
  - [x] 23.3 Implement Restoration in `packages/domain/src/restore.ts` and `POST /items/{id}/restore`
    - Pure `restoreFields` returning content and fields at the chosen point, except the fields that Status_Changes, Withdrawals, and Disclosure_Changes set, and except the Log_Summary when the restorer is not the Owner or the point had none
    - The Owner or an Administrator restores; Entry_Sections added back get Not_Published; the Restoration Revision names the point and intermediate Revisions stay
    - _Requirements: 2.4, 22.5, 23.15, 41.14_
  - [x] 23.4 Implement Withdrawal in `POST /items/{id}/withdraw`
    - Reason of 1 to 1,000 characters; the Item, its history, and its Disclosure_Level stay; withdrawn date and reason shown to Members; a Finding becomes Withdrawn with a Withdrawal Revision; a preview response states whether the Public_Site will show the reason (Effective_Disclosure Public)
    - _Requirements: 5.5, 22.6, 22.9, 24.10_
  - [x] 23.5 Implement permanent deletion in `apps/app/src/jobs/deletion.ts` and `DELETE /items/{id}`
    - Administrators confirm by typing the Item_Identifier and give a reason of 1 to 1,000 characters; a `Jobs` object removes the content, fields, and Revisions of the Item and every element under it, deletes their R2 objects within 24 hours, keeps the `identifiers` rows, and writes the Deletion record with kind, Item_Identifier, Administrator, time, and reason
    - A deleted Reply leaves a placeholder at its position with the deletion date and its children in place; Cross_Links on remaining ends show the deleted end's kind, Item_Identifier, and deletion date from the Deletion record
    - _Requirements: 15.8, 16.10, 22.7, 22.9_
  - [x] 23.6 Build the history screens in `apps/app/web/src/history/`
    - History list, state at a point, comparison with marked words, the restore dialog, the withdrawal dialog with its public-reason statement, and the deletion confirmation
    - _Requirements: 22.3, 22.4, 22.5, 22.6, 22.7_
  - [x] 23.7 Write property test for status rules
    - **Property 30: Status rules hold under all operation sequences**
    - **Validates: Requirements 5.3, 5.4, 5.9, 8.2, 8.4, 8.6, 8.7**
  - [x] 23.8 Write property test for history reconstruction
    - **Property 33: History reconstructs every past state**
    - **Validates: Requirements 11.8, 22.1, 22.3, 22.6, 39.8, 41.6, 42.7**
  - [x] 23.9 Write property test for Restoration
    - **Property 34: Restoration changes only content fields**
    - **Validates: Requirements 22.5, 23.15, 41.14, 42.5**
  - [x] 23.10 Write property test for comparisons
    - **Property 35: Comparisons mark exactly the changed words**
    - **Validates: Requirements 22.4, 42.9**

- [x] 24. Build discussion and Review_Requests
  - [x] 24.1 Implement Topics, Replies, and Threads in `apps/app/src/discussion/replies.ts`, `apps/app/src/api/routes/discussion.ts`, and `packages/domain/src/thread.ts`
    - `POST /topics` and `POST /replies` with a Parent that is a Research_Item, an Attachment, or a Reply at any depth, withdrawn or not
    - Pure `buildThread(replies)`: each Reply under its Parent, siblings oldest first by posting time, the Group_Note first, and placeholders for deleted Replies
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.9, 16.10, 41.7_
  - [x] 24.2 Implement Mention detection in `apps/app/src/discussion/mentions.ts`
    - Compare the Mention spans of the previously saved and the newly saved text of Research_Item fields, Entry_Sections, and Replies; return newly mentioned active Members, plus active holders of newly mentioned Specialties not already included, without the author
    - _Requirements: 16.6, 16.7, 16.8_
  - [x] 24.3 Implement Review_Requests in `apps/app/src/reviews/reviews.ts` and `apps/app/src/api/routes/reviews.ts`
    - `POST /reviews` within a Submission or later, with addressees (active Members, non-retired Specialties, Roles, each once) and an optional note; refusal without an Eligible_Reviewer keeps the Submission unsubmitted
    - `POST /reviews/{id}/complete` by an Eligible_Reviewer on a Needs_Review request with an optional note; refusals state the reason; Publication_Requests cannot be completed this way; `GET /reviews/queue` oldest first; item responses list every request of the Item and its Entry_Sections and carry the pending-review marker, which no public view has
    - _Requirements: 3.8, 17.1, 17.2, 17.3, 17.5, 17.7, 17.8, 17.9, 17.10, 17.11_
  - [x] 24.4 Build the discussion and review screens in `apps/app/web/src/discussion/` and `apps/app/web/src/reviews/`
    - Thread tree, reply composer with Mentions, Topic form, review request form, review queue, the item page's request list, and the pending-review marker
    - _Requirements: 16.4, 17.7, 17.8, 17.11_
  - [x] 24.5 Write property test for Threads
    - **Property 47: Threads are trees in posting order**
    - **Validates: Requirements 16.3, 16.4, 41.7**

- [ ] 25. Build the Activity_Service: flags, views, badges, and the Activity_Feed
  - [x] 25.1 Implement New_Flags in `apps/app/src/activity/flags.ts`
    - The batch that completes a Submission inserts a `new` flag on each of its Items for every other Member who is Active or Pending, whose account was created before completion, and who Can_Read the Item's Research_Item, with `INSERT … SELECT` joined to the `canRead` fragment from task 52.2; every flag insert, feed read, and badge count in this task uses that fragment
    - _Requirements: 18.1, 18.2, 18.6, 47.4, 47.5_
  - [x] 25.2 Implement Updated_Flags in `apps/app/src/activity/flags.ts`
    - A Correction, Withdrawal, or Status_Change on an Item or one of its Entry_Sections inserts an `updated` flag for every other active Member with a `views` row for the Item, in the batch of the Revision
    - _Requirements: 18.4_
  - [x] 25.3 Implement views and flag clearing in `apps/app/src/api/routes/activity.ts`
    - `POST /views` deletes the viewer's flags on the given units and upserts `views`; the SPA calls it only when a Research_Item page opens, an Attachment opens or downloads, or a page shows a Reply, and a failed call leaves the page displayed and the flags in place
    - _Requirements: 18.3, 18.12_
  - [x] 25.4 Implement the Activity_Feed in `apps/app/src/activity/feed.ts` and `apps/app/src/api/routes/feed.ts`
    - One `activity` row per Submission, Correction, Withdrawal, Status_Change, and Disclosure_Change, with up to 10 Item references or per-kind counts, and `activity_tags` for Root_Item kinds and Projects
    - `GET /feed` in keyset pages of 50 with filters by kind, acting Member, the acting Member's current Specialty, an inclusive date range in the viewer's time zone, and Project; the feed-open time; `POST /feed/mark-seen` clearing flags on matching entries' Items set no later than that time
    - Muted_Projects never change flags or which feed entries a Member sees
    - _Requirements: 18.5, 18.8, 18.9, 39.14, 39.17_
  - [x] 25.5 Implement badge counts in `GET /me/badges`
    - Counts of the viewer's flags per Research_Item kind, Attachment, and Reply over units that are not deleted, in one indexed query
    - _Requirements: 18.7_
  - [x] 25.6 Build the activity screens in `apps/app/web/src/activity/`
    - Badge counts on every page, new and updated marks in listings, search results, Threads, and Attachment lists as the flags stood when the page opened, and the feed page with filters and "mark all as seen"
    - List entries of Restricted Research_Items show `RestrictedMark` from `apps/app/web/src/access/access.tsx`, and listings offer bulk access changes through its `useSelection` and `BulkAccess` (R47.11, R47.14)
    - _Requirements: 16.4, 18.5, 18.7, 18.8, 18.10_
  - [x] 25.7 Write property test for New_Flags
    - **Property 49: New_Flags mark exactly the unseen Items of others' Submissions**
    - **Validates: Requirements 18.1, 18.3, 18.6, 39.17**
  - [x] 25.8 Write property test for Updated_Flags
    - **Property 50: Updated_Flags mark changes after a view**
    - **Validates: Requirements 18.4**
  - [x] 25.9 Write property test for Submission visibility
    - **Property 51: Submissions become visible all at once**
    - **Validates: Requirements 18.2, 18.11**
  - [x] 25.10 Write property test for mark-all-seen
    - **Property 53: Mark-all-seen clears exactly the matching, older flags**
    - **Validates: Requirements 18.5**

- [ ] 26. Build the Notification_Service
  - [x] 26.1 Implement the event fan-out in `apps/app/src/notifications/fanout.ts`
    - Done as `notify*` functions in `fanout.ts` that add their events and settle the Notifications once at commit (`GuardedBatch.defer`); a Submission of only Replies makes Reply events, not New_Submission events. Tasks 27, 32, 33, 34, 36, 42, 46 and 54 call the functions there for their events: `notifyAdministrators`, `notifyOwner`, `notifySystemAlert`, `notifyAdministratorsReminder`, and the Outside_Submission and Dissent events still to add.
    - One rule per Event_Type from the design's table, written with `INSERT … SELECT` in the batch of the causing action: New_Submission, Item_Update (Owner and Thread posters), the Administrator Item_Updates for automatic downgrades and for a non-Administrator's save that alters a Public_View, Reply, Mention (from task 24.2), Review_Requested, Review_Completed, and System_Alert; rules for Outside_Submission, Reminder, and Dissent events are added by the tasks that introduce them
    - The acting Member is excluded except for System_Alerts; Muted_Projects remove only New_Submission, Reply, and ordinary Item_Update events; each event stores the recipient's email mode at creation
    - Every rule about a Research_Item or anything under it joins the `canRead` fragment, so no event goes to a Member who cannot read it; rules for Publication_Proposals, Confidentiality_Holds, and Dual_Approvals are added by task 54, and Access_Change events written by task 52 before this task get their fan-out here
    - _Requirements: 9.6, 16.6, 16.7, 17.4, 17.6, 19.1, 19.2, 19.3, 19.4, 19.8, 23.13, 34.3, 39.9, 47.5_
  - [x] 26.2 Implement Notifications and the Notification_Centre in `apps/app/src/notifications/centre.ts` and `apps/app/src/api/routes/notifications.ts`
    - All events that one Submission causes for one recipient with in-app On form one Notification, added in the same batch; `GET /notifications` newest first with Event_Types, actor, time, read state, and what it concerns; `POST /notifications/{id}/read`; deleted Root_Items shown by kind and the Deletion record's time and reason; Group_Note indication; the unread count added to `GET /me/badges`
    - _Requirements: 19.5, 19.6, 19.7, 19.11, 19.12, 19.13, 41.11_
  - [x] 26.3 Implement Follow_Up_Due Reminders in `apps/app/src/notifications/reminders.ts`
    - The hourly sweep creates a Reminder for the Owner within 24 hours after an Archival_Request becomes Follow_Up_Due in the Owner's time zone, and again after each further Follow_Up_Interval
    - _Requirements: 10.3, 10.4_
  - [x] 26.4 Build the notification screens in `apps/app/web/src/notifications/`
    - The Notification_Centre, the unread count on every Workspace page, and opening a Notification at its Root_Item, its list of Root_Items, or the Group_Note scrolled into view
    - _Requirements: 19.7, 19.11, 19.12, 41.10_
  - [x] 26.5 Write property test for Mentions
    - **Property 40: Mentions are explicit and notify once**
    - **Validates: Requirements 16.6, 16.7, 16.8**
  - [x] 26.6 Write property test for counts
    - **Property 52: Counts match flags and Notifications**
    - **Validates: Requirements 18.7, 19.12**
  - [x] 26.7 Write property test for Notification grouping
    - **Property 55: One Notification per Submission per recipient**
    - **Validates: Requirements 19.6**

- [ ] 27. Build the Mailer and email pipeline
  - [x] 27.1 Implement the email templates in `packages/public-render/src/email/`
    - Plain-text-first structure with an HTML version from the Design_System email components using only token typefaces and colours; sender name ResearchForce; subjects starting with "ResearchForce:"; every link's visible text is its full address; a Notification_Preferences link in every Member email
    - Items described only by their current Public_View, kind, Event_Type, actor display name, and time in the recipient's zone, with `https://app.researchforce.org/go/{ref}` login links; Outside_Submissions by Event_Type, Submission_Type, time, and days since receipt for Reminders; Elimination_Scope after Eliminated statuses; Group_Note links and views; Log_Summaries followed by their Dissent_Notes' views
    - Register the email outputs in `packages/testing/src/public-channels.ts`
    - Done as `compose.ts` (the structure and HTML) and `views.ts` (an entry from a Public_View, which the `notification emails` channel uses); `apps/app/src/mail/compose.ts` builds the entries from the database at send time. `/go/{ref}` is a new web route that redirects to the Item, or to a Reply with `~{replyId}`. Kinds of `outgoing_emails` other than the invitation have no composer yet: task 32 adds them, and task 42 adds the Log_Summary and Dissent_Note views.
    - _Requirements: 8.3, 20.6, 20.7, 41.12, 42.15, 45.21_
  - [x] 27.2 Implement batching in `apps/app/src/mail/batching.ts`
    - Group keys `root:`, `sub:`, `os:`, and `alert`; a window starts at the first event and copies the Email_Batch_Window length in force; events after the window end open a new batch; closed batches are queued within 2 minutes of the window end
    - _Requirements: 20.1, 20.2, 20.3, 20.12_
  - [x] 27.3 Implement Daily_Digests in `apps/app/src/mail/digest.ts`
    - A quarter-hour check finds Members whose local digest hour has passed since their last digest and queues one email of their unlisted Daily_Digest events from before that hour, grouped by Root_Item, or nothing when none qualifies
    - _Requirements: 20.4, 20.5, 20.13_
  - [x] 27.4 Implement the `Mailer` Durable Object in `apps/app/src/do/mailer.ts`
    - One sending queue for invitations, notification emails, and Submitter emails, oldest first; an attempt log enforcing at most 30 attempts per 60 seconds and the Recipient_Cap in force over 24 hours, holding emails until both allow; the recipient of a notification email must be an active Member at each attempt and still Can_Read every Root_Item it describes (items the recipient can no longer read are left out, and an email left with nothing is dropped); composition from the current Public_Views at send time; the configured provider read at each attempt
    - Done in `mail/mailer.ts` (the queue, testable without the Durable Object) and `do/mailer.ts` (the alarm and the attempt log in SQLite storage). Migration 0008 adds the queue columns. Held time is recorded when the limits stop a pass (the predicted wait), so a wake that comes late may count a little less.
    - Retries at about 2, 10, 25, and 50 minutes, honouring `Retry-After` on 429; after the final failure a System_Alert for every Administrator unless the email held only System_Alerts; a failed invitation sets `invite_email_state` until a later invitation succeeds; queue time recorded so time limits exclude it
    - _Requirements: 2.1, 2.14, 20.8, 20.9, 20.10, 20.11, 20.15, 20.16, 20.17, 20.18, 47.5_
  - [x] 27.5 Implement the Microsoft Graph provider in `apps/app/src/mail/providers/graph.ts`
    - The `send(message)` Email_Provider interface; client-credentials tokens from `login.microsoftonline.com` with a certificate assertion signed by WebCrypto, held only in the `Mailer` instance's memory; `POST /v1.0/users/{Sending_Address}/sendMail` with one recipient, an HTML body, and `saveToSentItems: false`; `BODY_MODE = 'html-with-exchange-conversion'` as the one place the plain-text strategy is chosen; credentials, tokens, and Graph responses never logged or stored
    - _Requirements: 20.11, 20.19, 20.20, 20.21, 20.22, 20.24, 45.21_
  - [x] 27.6 Write property test for companion fields
    - **Property 9: Companion fields are rendered together**
    - **Validates: Requirements 5.6, 5.10, 6.3, 7.4, 8.3, 29.2, 29.3, 29.4, 43.3**
  - [x] 27.7 Write property test for email batching
    - **Property 56: Email batching partitions events correctly**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.12**
  - [x] 27.8 Write property test for Daily_Digests
    - **Property 57: Daily_Digests list each event once**
    - **Validates: Requirements 20.4, 20.5**
  - [x] 27.9 Write property test for the sending queue
    - **Property 58: The sending queue respects every limit**
    - **Validates: Requirements 20.8, 20.9, 20.10, 20.15, 20.16, 20.17, 20.18, 32.11, 32.12**
  - [x] 27.10 Write property test for email branding
    - **Property 59: Emails carry the brand and full-address links**
    - **Validates: Requirements 20.7, 45.21**
  - [x] 27.11 Write integration tests for the Mailer with a mocked Graph endpoint
    - 429 and 5xx retries, a provider change between attempts, the invitation-failure state, and a request body with `saveToSentItems: false` and one recipient
    - _Requirements: 2.14, 20.9, 20.11, 20.24_

- [ ] 28. Build Member search
  - [x] 28.1 Implement the search indexer in `apps/app/src/search/indexer.ts`
    - A permanent `Jobs` instance named `indexer` draining the `search` outbox topic within seconds; one document per Item and Entry_Section, with Research_Item free-text and name fields, Attachment title, Item_Identifier, caption, Origin, and file name (never file contents), Dissent_Note documents pointing at their Research_Item with author and withdrawal marker, withdrawn and superseded markers, incomplete Submissions flagged, deleted Items removed, and creation sort keys
    - Done as `search/read.ts` (documents of a Research_Item read from rf-core), `search/indexer.ts` (rf-search writes, keyed by creation time), and the `indexer` role of `Jobs`. Outbox rows are `unit:`, `root:`, or `submission:` scopes and re-index the whole Research_Item, so saves, replies, access resets, and `completeSubmission` add a `search` row beside their `publish` row. Tasks 30, 37, and 42 add rows where they write units. The Credit filter covers Members; outside and imported Credit names are searchable text only.
    - _Requirements: 21.1, 21.5, 21.6, 42.13_
  - [x] 28.2 Implement queries in `apps/app/src/search/query.ts` and `GET /search`
    - Shared validation; FTS5 expressions with `"word"*` terms, quoted phrases, and "ß"/"ss" expansion capped at 16 alternatives; own-title matches first, then the rest, newest first, in pages of 20; filters by root kind, Credit person, current Specialty holders, own Disclosure_Level, Projects, and an inclusive creation date range in the viewer's zone
    - Results with kind, title (the Root_Item's for sections and Replies), Credit, creation date, markers, Disclosure_Level and Effective_Disclosure, Project name, and excerpts of at most 300 characters located in the stored text with their labels and highlighted terms; Dissent_Note matches marked with the author; "no result matched" when empty
    - Matches are filtered with the `canRead` fragment on each document's Research_Item before ranking and paging, so no result, count, or excerpt reveals a Restricted Research_Item to a Member outside its Access_List; Restricted results show the Restricted mark
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 21.7, 21.8, 21.9, 23.9, 39.14, 39.15, 42.13, 47.4, 47.11_
  - [x] 28.3 Build the search screen in `apps/app/web/src/search/`
    - Done with one change: results carry the viewer's flag (read from `flags` for the Item), so `useRecordViews` is not called on the search page; opening a result records its view. Flags: show `FlagMark` from `apps/app/web/src/activity/activity.tsx` on entries, read as the page opened them with `useFlagSnapshot`, and call `useRecordViews` with the Items the page opens.
    - Query form and filters; after 10 seconds without a response, "search is unavailable", with the 00:00 UTC note for daily limits; query and filters kept as entered
    - Restricted results show `RestrictedMark` from `apps/app/web/src/access/access.tsx`, and result lists offer bulk access changes through its `useSelection` and `BulkAccess` (R47.11, R47.14)
    - _Requirements: 21.9, 21.10_
  - [x] 28.4 Write property test for Member search
    - **Property 60: Member search returns exactly the matching units**
    - **Validates: Requirements 21.1, 21.3, 21.4, 21.5, 21.8, 42.13**
  - [x] 28.5 Write property test for search excerpts
    - **Property 61: Search excerpts are bounded, highlighted, and labelled**
    - **Validates: Requirements 21.7, 30.5, 30.13**

- [x] 29. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.
  - Done 2026-10-28 in the cloud workspace: lint and `tsc -b` clean; 945 of 946 tests pass with `--testTimeout=180000`. `p42-cross-links` takes about 24 s there against its own 200 ms-per-run limit (20 s at 100 runs) and also did on the commit before Task 25, so it is slow on that machine rather than broken.

- [ ] 30. Build files: uploads, Attachments, versions, previews, Download_Links, and `rf-dl`
  - Reopened by the 27 October review: the earlier CI/build evidence remains valid for its tested cases, but 30.6–30.8 still need reload persistence, bounded streaming previews, and listing-versus-view flag corrections. Real R2/CORS rehearsal is mandatory in task 48; no completed code is discarded.
  - [x] 30.1 Implement uploads in `apps/app/src/files/uploads.ts` and `apps/app/src/api/routes/uploads.ts`
    - `POST /uploads` with name, size, and browser-computed SHA-256, refusing files above the Attachment_Size_Limit and the 101st file of a Submission before any transfer, naming the file and the limit
    - SigV4 presigned PUT URLs to `rf-private` signing `content-length` and `x-amz-checksum-sha256` for files up to 64 MiB, and multipart uploads with 16 MiB parts each signing its SHA-256 (`POST /uploads/{id}/parts`); `POST /uploads/{id}/complete` compares the stored size and checksum with the declared values; no file content passes through a Worker request body
    - _Requirements: 12.4, 12.5, 12.9, 12.10_
  - [x] 30.2 Implement Attachments in Submissions in `apps/app/src/files/attachments.ts`
    - One Attachment per completed file on a Research_Item or Reply that the Submission adds or that already exists, with title (default the file name), file kind, original file name preserved exactly, size, Credit, caption, Origin, and upload completion time; rights fields with limits, Unknown by default, or copied from a Source Parent with Unknown in place of a retired value
    - Hourly sweep deleting objects of uploads started more than 24 hours earlier that belong to no completed Submission
    - _Requirements: 6.4, 7.3, 12.1, 12.2, 12.8, 16.5, 33.1, 33.2, 33.3_
  - [x] 30.3 Implement Attachment versions in `apps/app/src/files/versions.ts`
    - A new version is a new Attachment on the same Parent with `supersedes_unit_id`, last in the Version_Chain, Not_Published, with Rights_Status Unknown; the `chain_tip` guard refuses a version of a superseded Attachment and names the last version so the dialog can offer it; adding a version needs edit Permission on the target; the superseded Attachment stays unchanged and usable
    - Chain data for every Attachment (positions from 1, upload time, Owner, viewed and last marks) and supersession notices with the successor's upload time and link
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_
  - [x] 30.4 Implement Download_Link issue in `apps/app/src/files/links.ts` and `POST /files/{id}/link`
    - Tokens `base64url(objectKey, memberId, issuedAt, purpose)` with an HMAC-SHA-256 under a Workers secret, issued only to active Members who Can_Read the file's Research_Item, at `https://dl.researchforce.org/t/{token}` for files and `/x/{token}` for package volumes
    - _Requirements: 14.9, 25.1, 25.5, 47.4_
  - [x] 30.5 Implement the `rf-dl` Worker in `apps/dl/src/index.ts`
    - Accept a token only with a valid signature, at most 15 minutes after issue, for an Active Member at request time, and for an Administrator when the purpose is an Internal_Backup; support `Range` and `HEAD`; serve with `Content-Disposition: attachment`, `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-site`, and CORS limited to the Workspace origin
    - Every refusal returns the same 404 response as an unknown path; register `rf-dl` responses to non-Members in `packages/testing/src/public-channels.ts`
    - _Requirements: 14.6, 25.1, 25.2, 25.5, 25.6, 35.9, 36.2_
  - [ ] 30.6 Build the upload screen in `apps/app/web/src/files/upload.tsx`
    - Keep incremental file/per-part SHA-256 in the Web Worker and per-file whole-number XHR progress at least once per second; fail only the affected file on a 60-second stall, storage error, checksum mismatch or sweep removal, with unlimited retry/removal.
    - Persist title, caption, Origin, rights choices, upload/group IDs and operation key in same-tab storage before transfer and on edit. Reload revalidates completed uploads and restores metadata; an expired/interrupted local File requires name/size/hash-matching reselection while all other fields survive. Explicit server drafts integrate in task 64.
    - Submit remains blocked with file-specific reasons for uploading/failed/invalid metadata, including form submission by keyboard. Browser tests reload after completion and failure, reselect a file, retry/remove one file while preserving others, and reconcile a lost completion/save response.
    - _Requirements: 12.6, 12.7, 12.11, 28.10, 57.3, 60.2_
  - [ ] 30.7 Build the inline previews in `apps/app/web/src/files/preview/`
    - Fetch bytes only through current Member-bound Download_Links; use a self-hosted PDF.js build without scripting/eval/interactive annotation actions, range transport and bounded caches; retain page n of N, previous/next/go-to controls. Decode only magic-byte-verified supported raster types, with fit, zoom through 400%, and keyboard/pointer panning.
    - Text logs use Range for the first decimal MB. CSV streams through Papa Parse with 1,000 complete data rows and one-row lookahead, cancels retrieval when sufficient, and enforces 32 MiB scanned/256 KiB record/2 MiB buffering. Distinguish known-more, end-of-file and budget-limited unknown remainder; never buffer the entire CSV or show a truncated quoted cell as a complete row.
    - Keep pure truncation helpers; name damaged, password-protected, mismatched, unavailable and resource-limited causes while metadata/full download remain. Browser tests assert bounded allocation/transfer, abort/cleanup, range-link refresh, malformed/very long CSV records and malicious/polyglot files. Rendering in the SPA is controlled rendering in the Workspace, not origin isolation by itself.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.9, 14.10_
  - [ ] 30.8 Build the Attachment screens in `apps/app/web/src/files/attachment-page.tsx`
    - Keep metadata, Original_Name, Origin, rights and publication flag, protected full download, preview, Version_Chain positions/Owner/time/viewed/last marks, and supersession notices on Attachment and Cross_Link/Backlink displays.
    - Show FlagMark from the opening snapshot. Do not call useRecordViews from Attachment metadata lists, chain lists, search or feed entries; record a view only for the actual opened/previewed/downloaded file. A browser regression test loads a Parent listing and proves unread file flags remain until that file is opened.
    - Extend the screens with citations and derivations in task 62; listing those relationships must not implicitly open their target or broaden access.
    - _Requirements: 13.4, 13.6, 14.5, 18.13, 33.7_
  - [x] 30.9 Write property test for Version_Chains
    - **Property 43: Version_Chains stay linear**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.7**
  - [x] 30.10 Write property test for Download_Links
    - **Property 45: Download_Links authorize one file for 15 minutes**
    - **Validates: Requirements 25.1, 25.5, 35.9, 36.2**
  - [ ] 30.11 Write property test for preview truncation
    - Reopened for R14.10: extend the owning property with bounded CSV streaming, oversized quoted records, read cancellation and accurate unscanned/truncation reporting; retain text prefix cases.
    - **Property 46: Previews truncate exactly**
    - **Validates: Requirements 14.3, 14.4, 14.10**
  - [x] 30.12 Write integration tests for uploads
    - Local R2 refuses a part or object with a wrong checksum; completion with a mismatched size fails the file; the sweep deletes only abandoned uploads
    - _Requirements: 12.7, 12.8, 12.10_

- [ ] 31. Build disclosure changes, previews, classification, Publication_Requests, rights and consent rules, and item moves
  - [ ] 31.1 Implement projection input loading and the preview API in `apps/app/src/kernel-input.ts` and `apps/app/src/disclosure/preview.ts`
    - `loadProjectionInput(roots)`, the only code that turns `rf-core` rows into kernel input, including Parties, Do_Not_Name flags, registered Member emails, consent, rights, Licence_Agreements, and Cross_Link neighbours
    - It reads `research_items.access_level` into the `restricted` flag that task 52.5 added to the kernel input; the access preview of task 52.4, which until then lists the units whose level a restriction resets, then also renders the Public_Views the restriction removes with `diffViews`
    - `POST /disclosure/preview` for levels, presentations, Public_Summaries, and Disclosure_Lines of one unit or up to 1,000, a Project's level, a Project move, or turning Do_Not_Name off; returns `diffViews` and `checkGates` output and a preview token that is an HMAC over the change set and its dependency rows' `updated_seq`; previews of more than a few hundred units run in a `Jobs` object with progress and paging
    - _Requirements: 23.6, 23.16, 26.7, 33.7, 34.7, 34.9, 39.13, 46.16_
  - [ ] 31.2 Implement the apply API in `apps/app/src/disclosure/apply.ts`
    - `POST /disclosure/apply`: the `preview_fresh` guard comparing every dependency's `updated_seq` in one `json_each` statement, rights and consent guards, the values written, Classified set on exactly the selected Unclassified units with Administrator and time, one Disclosure_Change per unit, Owner Item_Update events, one Activity_Feed entry (a Project change as one entry naming the Project with a link to its history), `slug_fixed_at` when a Project first becomes Public or Withheld, `first_public_at`, and a publish outbox row; any failure applies nothing and lists each unit with its reason
    - _Requirements: 23.2, 23.4, 23.5, 23.7, 23.14, 26.5, 26.6, 26.7, 26.14, 39.6, 39.11_
  - [ ] 31.3 Implement the classification and public-overview lists in `apps/app/src/api/routes/disclosure.ts`
    - `GET /disclosure/unclassified` with counts per Root_Item, per import, and per accepted Outside_Submission; `GET /disclosure/public-units` listing every Public or Withheld unit with kind, Effective_Disclosure, Project, Root_Item, Rights_Status, and the time of the last projection, filterable by Effective_Disclosure and Project
    - _Requirements: 23.8, 26.8, 33.7, 39.14_
  - [ ] 31.4 Implement Publication_Request proposal, apply, and decline in `apps/app/src/reviews/publication.ts`
    - A Contributor's proposal creates a Review_Request addressed to the Administrator Role with the proposed level and optional Public_Summary, Public_Presentation, or Disclosure_Line within limits; applying pre-fills the disclosure change, runs the same preview and checks, and marks it Reviewed with outcome Applied and the applied values; a consent refusal leaves it Needs_Review; declining needs a note of 1 to 2,000 characters and changes no disclosure value
    - A proposal for the proposer's own Disclosure_Units also records the proposer's Publication_Consent for the proposed values (task 54.3 adds the consent rows and the check on edited values)
    - _Requirements: 17.5, 23.10, 23.11, 23.12, 23.21, 34.2_
  - [ ] 31.5 Implement the rights and consent rules in `apps/app/src/disclosure/rights.ts`
    - A save that sets a non-permitting Rights_Status on a Public Attachment makes it Withheld in the same batch with a Disclosure_Line of only file kind and upload date, a Disclosure_Change by the saving Member, and an Administrator Item_Update; marking a Rights_Status value as not permitting shows the count of affected Public Attachments, then downgrades them all in one batch with a Disclosure_Change each and one Item_Update per Administrator listing them
    - Making an Attachment Public with a non-permitting Rights_Status, or a Correspondence Public while any consent is not Granted, is refused with Withheld offered; turning Do_Not_Name off goes through the preview
    - _Requirements: 33.4, 33.5, 33.8, 34.2, 34.6, 34.9_
  - [ ] 31.6 Implement item moves in `apps/app/src/records/move.ts` and `POST /items/{id}/move`
    - Update `project_id` on the Research_Item and every element under it in one statement, leaving everything else unchanged (including its Access_Level and Access_List), and record a Revision holding the previous Project (Disclosure_Change when a Public_View changes, Minor_Edit otherwise); a move that alters a Public_View needs a confirmed, fresh preview
    - Extend Property 101 (`apps/app/test/properties/p101-access-changes.test.ts`) with moves, checking that a moved Research_Item keeps its Access_Level and Access_List (R47.12)
    - The same batch removes every Question_Group entry that names the moved Research_Item or anything under it from Research_Questions of the old Project, recording the removal in each Research_Question's history (task 55.2 supplies the shared helper)
    - _Requirements: 23.3, 39.12, 39.13, 47.12, 50.7_
  - [ ] 31.7 Build the disclosure screens in `apps/app/web/src/disclosure/`
    - The disclosure dialog with the preview (changed views, Party names, Dissent_Notes that will not be Public, Licence_Agreement states, gate failures with Withheld offers), set selection up to 1,000 units, the Public_Summary editor pre-filled from the Log_Summary when empty or from a Publication_Request being applied, the Unclassified list, the public overview, Publication_Request apply and decline, the move dialog, and Consent_Status, Do_Not_Name, and Generic_Label on Correspondence pages and previews
    - _Requirements: 23.6, 23.8, 23.11, 23.12, 26.8, 34.7, 41.13_
  - [ ] 31.8 Write property test for independent Disclosure_Levels
    - **Property 2: Own Disclosure_Levels are independent of ancestors**
    - **Validates: Requirements 4.8, 9.3, 23.3, 39.12**
  - [ ] 31.9 Write property test for Unclassified units
    - **Property 4: Unclassified units stay Not_Published and classification is selective**
    - **Validates: Requirements 26.5, 26.6, 26.7**
  - [ ] 31.10 Write property test for publication gates
    - **Property 12: Publication gates reject the whole change**
    - **Validates: Requirements 23.5, 23.14, 26.7, 26.14, 33.4, 34.2, 46.17**
  - [ ] 31.11 Write property test for rights and consent invariants
    - **Property 13: Rights and consent invariants hold after every save**
    - **Validates: Requirements 9.6, 33.3, 33.5, 33.8, 34.1, 34.3**
  - [ ] 31.12 Write property test for public addresses
    - **Property 19: Public addresses are stable and content-free**
    - **Validates: Requirements 29.6, 29.7, 29.8, 39.6, 40.3, 40.8**
  - [ ] 31.13 Write property test for the Review_Request state machine
    - **Property 48: Review_Requests follow their state machine**
    - **Validates: Requirements 17.3, 17.4, 17.5, 17.8, 17.9, 17.10**
  - [ ] 31.14 Write property test for item moves
    - **Property 77: Moving a Research_Item changes only its Project**
    - **Validates: Requirements 39.1, 39.12**
  - [ ] 31.15 Write property test for Log_Summary rules
    - **Property 79: Log_Summary rules**
    - **Validates: Requirements 41.1, 41.2, 41.5, 41.13**

- [ ] 32. Build the Publisher and the public site deployment
  - [ ] 32.1 Implement the `rf-ops` site deployment in `apps/ops/src/deploy.ts`
    - Implement deploySite(manifest, epoch, operationId) with the existing Direct Upload protocol, resumable upload token and assets-only version. rf-ops serializes promotion and requires the expected authoritative publication epoch before and after it; an obsolete operation cannot reopen a contained host.
    - Record operation identity, exact Worker version/manifest and verified status for ambiguous API responses, reconcile before retry, and maintain precreated independent containment controls from task 59.
    - _Requirements: 24.7, 24.11, 24.12, 24.16, 24.17, 28.6, 28.16, 60.2_
  - [ ] 32.2 Implement the Publisher projection step in `apps/app/src/do/publisher.ts`
    - Retain dirty-scope expansion and versioned Public_Views, but give runs leases/generations and a publication epoch. Urgent invalidations preempt older addition work at the next bounded slice; every copy/render/deploy transition checks the epoch and may not resurrect suppressed output.
    - Read logical fields through bounded version readers from task 57; retain versions required by release/citation/backup leases and only prune eligible unreferenced derived history. Restore remains quarantined until the current suppression and public-launch preflight pass.
    - _Requirements: 24.11, 24.12, 24.16, 24.17, 34.6, 36.16, 46.7, 46.34, 59.3_
  - [ ] 32.3 Implement planning and rendering in `apps/app/src/publisher/plan.ts` and `apps/app/src/publisher/render.ts`
    - Map changed views to every affected output (unit, Parent, and root pages; every page of affected listings, Project_Logs, and Disclosure_Line listings; Project, home, and projects pages; Research_Question pages and the Project page's Research_Question part from task 55.4; People and Policy pages; search index files; file operations), render with `public-render` and `search-public`, include the `site-shell` build, `robots.txt`, `sitemap.xml`, and `_headers`, hash each file as the Direct Upload API specifies, store new content under `rf-private/build/{hash}`, and keep the manifest in `rf-public.site_files`; alert at 16,000 files
    - No file is rendered for a Not_Published Project's addresses or for any address of a Withheld Project other than its page, so those addresses get the same `404.html` as unknown ones; Policy_Pages, metadata, print styles, fonts, scripts, and images ship only as static assets
    - _Requirements: 24.1, 24.2, 24.4, 24.5, 28.16, 29.1, 30.7, 30.8, 40.4, 40.9, 40.10, 45.4_
  - [ ] 32.4 Implement public file copies in `apps/app/src/publisher/files.ts`
    - Copy an Attachment that becomes Public to `rf-public` at `f/{Item_Identifier}` with a server-side `CopyObject` before any page links to it, with a content type from the file kind (`application/octet-stream` for script-capable types) and `Content-Disposition` naming `{Item_Identifier}.{ext}`; delete copies first for removals and retry failed deletions each slice
    - _Requirements: 24.3, 25.2, 25.3, 25.4, 28.6_
  - [ ] 32.5 Implement urgency, deployment, and verification in `apps/app/src/publisher/deploy.ts`
    - Urgent removals interrupt addition work; addition batching remains 30 seconds quiet/5 minutes maximum. Fence all deploy/file effects against the current epoch, reconcile ambiguous promotion results and retain containment across stale retries.
    - Verify pages, files, static index generations, public release outputs and controlled caches. At four minutes unconfirmed, initiate independent edge containment and alerting; by five minutes verify removal or containment where provider controls are available. If both fail, report an unconfirmed confidentiality incident and never claim success.
    - Do not uncontain after a restore until fresh validation, known post-snapshot suppressions and a new authorized generation pass. Tests interleave a hold with a long run, failed deploy, old retry and resource exhaustion.
    - _Requirements: 24.11, 24.12, 24.16, 24.17, 25.3, 25.7, 30.7, 30.8, 36.9, 36.16, 42.8, 46.30, 46.38, 59.3_
  - [ ] 32.6 Write property test for Publisher convergence
    - **Property 15: Publisher convergence**
    - **Validates: Requirements 24.1, 24.2, 24.4, 24.11, 24.12, 25.2, 25.3, 29.1, 30.7, 30.8, 36.9, 40.4, 46.7, 46.30**
  - [ ] 32.7 Write integration tests for publication timing and alerts
    - A stubbed `HEAD` that keeps answering 200 raises the System_Alert of Requirement 25.7; urgent runs deploy before add-only runs; a restore in progress pauses the Publisher
    - _Requirements: 24.11, 25.7, 36.9_

- [ ] 33. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 34. Build the `Budget` Durable Object and the public submission API in `rf-submit`
  - [ ] 34.1 Implement the `Budget` Durable Object in `apps/app/src/do/budget.ts` and `apps/app/src/budget/status.ts`
    - Use 59.3's profile-aware reserve/settlement and provider-level accounting helpers for per-UTC-day Public_Traffic requests, rows read, and rows written with `admit()` and `report(rows)`; when a counter reaches the Public_Traffic_Budget minus a 2% margin, refuse further public requests with a fixed "unavailable until 00:00 UTC" response that uses no D1 query, ask `rf-ops` to enable the WAF block rule for `submit.researchforce.org`, and rewrite `files.researchforce.org/status.json`; `PUBLIC_SEARCH_FOLLOWS_BUDGET = false` in `status.ts` keeps static search available; dynamic form and addressed-view status are separate
    - The 00:00 UTC cron resets the counters, disables the WAF rule, and rewrites `status.json`; network-address counters stored only as HMAC-SHA-256 under a daily key with hourly counts, deleted with the key within 24 hours; an AI Neuron ledger of reservations and settlements; Recipient_Cap usage reported by the `Mailer`
    - _Requirements: 28.5, 28.6, 28.7, 28.11, 46.20_
  - [ ] 34.2 Implement the WAF switch in `apps/ops/src/waf.ts`
    - `setSubmitBlock(enabled)` toggling the pre-created custom rule that blocks `submit.researchforce.org` at the edge
    - _Requirements: 28.5, 28.6_
  - [ ] 34.3 Implement submission sessions and files in `apps/submit/src/index.ts` and `apps/submit/src/sessions.ts`
    - Every request passes the `Budget` gate first; `POST /v1/sessions` verifies a Turnstile token with `siteverify` (one use, 300 seconds) and opens a 128-bit session that expires after 2 hours; `POST /v1/sessions/{id}/files` checks the Public_Upload_Size_Limit, 10 files and 500 MB per Outside_Submission, and 1 GB per day, then returns a presigned PUT to `rf-private/outside/{session}/{file}` signing length and SHA-256; `…/complete` confirms size and checksum
    - Hourly sweep deleting uploaded files that are not part of a complete Outside_Submission 24 hours after upload
    - _Requirements: 31.3, 31.4, 31.8, 31.10, 31.12_
  - [ ] 34.4 Implement the submit endpoint in `apps/submit/src/submit.ts`
    - Validate the fields, the licence agreement for types other than Removal_Request, and the Project or General_Choice (a nonexistent and a non-Public Project get the same refusal); count 5 complete Outside_Submissions per hour per hashed network address, 3 per day per email address, and 20 per day in total; require every added file to be complete; store the Outside_Submission with its page reference as text that is never looked up and the chosen Project or General_Choice in one batch
    - Respond within 5 seconds with the Submission_Reference and time, queue the acknowledgement (stating the Response_Target for Corrections and Removal_Requests), and create Outside_Submission events for every Administrator, plus one for the Responsible_Person on a Removal_Request, with the shared builder in `packages/db/src/events/outside.ts`
    - Compose every response only from fixed text, the reference, the time, the Visitor's own validation results and limits, and confirmed Administrator text; register `rf-submit` responses in `packages/testing/src/public-channels.ts`
    - _Requirements: 31.2, 31.4, 31.5, 31.6, 31.7, 31.9, 31.12, 31.14, 32.1, 32.3, 32.17, 46.20, 46.22, 46.36_
  - [ ] 34.5 Implement the public form scripts in `apps/site-shell/src/form.ts` and update `apps/site-shell/src/search.ts`
    - Submission_Type choice, the licence agreement checkbox (never preselected, absent for Removal_Request), the Project list of Public Projects in Project_Order plus the General_Choice with the page's preselection, Turnstile in managed mode, uploads with progress, retry, and removal, every field and fully uploaded file kept after a refusal or failure, unsent input in `sessionStorage`, and the confirmation with reference and time
    - The form script reads its admission status and shows "unavailable until 00:00 UTC" when exhausted; the search script retains static search and treats confidentiality containment separately
    - _Requirements: 28.10, 28.11, 31.1, 31.10, 31.11, 31.13, 45.5, 45.18_
  - [ ] 34.6 Write property test for Outside_Submission limits
    - **Property 88: Outside_Submission limits**
    - **Validates: Requirements 31.4, 31.12**

- [ ] 35. Build the Moderation_Service
  - [ ] 35.1 Implement the Moderation_Queue API in `apps/app/src/moderation/queue.ts` and `apps/app/src/api/routes/moderation.ts`
    - `GET /moderation` for active Members only, with Submission_Reference, type, Project or General_Choice, state, text, Submitter details, files, referenced page, receipt time, and for Corrections and Removal_Requests the receipt date and the Response_Target end date (receipt plus 14 days) in the viewer's zone with an overdue mark while undecided; no network address appears; Project filters
    - _Requirements: 2.8, 32.1, 32.2, 32.17, 39.14, 46.20, 46.24_
  - [ ] 35.2 Implement Moderation_Decisions in `apps/app/src/moderation/decide.ts`
    - Every decision returns the exact email text first and applies only after confirmation; messages and reasons up to 5,000 characters; the `decision_open` guard refuses a decision after an Accepted or Rejected one and shows the recorded decision; decision rows are never changed and record Administrator, time, text, and created Items; emails go only to the address in that Outside_Submission
    - Accept for Material, Correction, or Comment creates the selected Items (at least one; Research_Items with Log_Summaries, Replies, or Attachments on existing or newly created Parents), credited to the Submitter's name and affiliation, Not_Published and Unclassified, in the Outside_Submission's Project unless another is chosen (a choice is required for the General_Choice), all-or-nothing, as one Submission by the accepting Administrator
    - Removal_Requests need a statement of 1 to 5,000 characters, record the elements named as changed, and create no Item; More_Information_Requested sends the message and a Response_Link valid for 30 days; Reject and an accepted Removal_Request store the dates for deleting files within 24 hours and erasing the email address 90 to 91 days later; outcome emails go through the `Mailer`, and a finally failed Submitter email shows on the Outside_Submission
    - _Requirements: 32.4, 32.5, 32.6, 32.9, 32.10, 32.11, 32.12, 32.13, 32.15, 32.16, 32.18, 41.2, 46.23, 46.33_
  - [ ] 35.3 Implement Response_Links in `apps/submit/src/respond.ts` and `apps/site-shell/src/respond.ts`
    - The token travels in the URL fragment; `POST /v1/respond/check`, Turnstile sessions, files, and submit; refusal on a failed Bot_Check, the size or Outside_Submission limits counted as one Outside_Submission, expiry after 30 days, an earlier response, or an Accepted or Rejected decision; an accepted response is attached with its receipt time and creates Outside_Submission events for every Administrator, plus the Responsible_Person on a Removal_Request
    - _Requirements: 32.7, 32.14, 46.36_
  - [ ] 35.4 Implement Response_Target Reminders in `apps/app/src/moderation/reminders.ts`
    - The hourly sweep creates a Reminder for every Administrator 10, 14, 21, 28, and every further 7 days after receipt of an undecided Correction or Removal_Request, stating the Submission_Type and the days since receipt and opening the Outside_Submission
    - _Requirements: 46.24, 46.25_
  - [ ] 35.5 Implement the moderation retention sweeps in `apps/app/src/moderation/retention.ts`
    - Delete the files of rejected Outside_Submissions and accepted Removal_Requests, including Response_Link files, within 24 hours; erase Submitter email addresses on their stored dates; delete Response_Link token hashes 30 days after expiry
    - _Requirements: 32.8, 46.26_
  - [ ] 35.6 Build the moderation screens in `apps/app/web/src/moderation/`
    - The queue with filters and overdue marks, the Outside_Submission view with the Attachment previews, decision forms with the email text confirmation, the acceptance builder for Items, Parents, Projects, and Log_Summaries, the Removal_Request statement with changed elements, and failed-email notices
    - _Requirements: 14.8, 32.10, 32.17, 46.23, 46.24_
  - [ ] 35.7 Write property test for not-found responses
    - **Property 7: Not_Published and nonexistent are indistinguishable**
    - **Validates: Requirements 24.7, 25.6, 31.6, 31.14, 40.10**
  - [ ] 35.8 Write property test for Project choice
    - **Property 78: Project choice and preselection**
    - **Validates: Requirements 31.13, 32.18, 39.2, 39.3**
  - [ ] 35.9 Write property test for Response_Links
    - **Property 89: Response_Link validity**
    - **Validates: Requirements 32.14**
  - [ ] 35.10 Write property test for Moderation_Decisions
    - **Property 90: Moderation decisions are final, credited, and append-only**
    - **Validates: Requirements 32.4, 32.13, 32.16, 46.23**
  - [ ] 35.11 Write integration tests for moderation flows
    - Acceptance creates one Submission with flags and New_Submission events; More_Information_Requested emails a Response_Link; decisions apply only after confirmation; rejection schedules file deletion and email erasure
    - _Requirements: 32.5, 32.6, 32.8, 32.9, 32.10_
  - [ ] 35.12 Implement Contact_Reviews and submitter corrections in `apps/app/src/moderation/contact-review.ts`
    - Store `contact_review_due_at` on acceptance of an Outside_Submission other than a Removal_Request (acceptance plus 12 months, from the retention constants in `packages/domain`); the hourly sweep marks due Outside_Submissions whose email is still held, and once a day creates one Reminder per Administrator listing those that became due that day, marks those due for 30 days or more as overdue, and repeats their Reminder every 30 days until a Contact_Review is recorded
    - `POST /moderation/{id}/contact-review` with Keep and a reason of 1 to 1,000 characters (next due date 12 months later) or Erase (erasure within 24 hours), appended to `contact_reviews` and never changed; both keep the Submitter_Attribution and the submitted text
    - `POST /moderation/{id}/contact` corrects the Submitter_Attribution or the Submitter_Contact, or erases the Submitter_Contact, at any time, with a reason, appending to `submitter_corrections` with the previous values except an erased contact; a corrected Submitter_Attribution becomes the Credit of every Item created from the Outside_Submission, with a Minor_Edit Revision on each
    - Register the Reminder in `fanout.ts`; include `contact_reviews` and `submitter_corrections` in the Internal_Backup table list of task 38.4; update `retentionRows()` with the separate attribution and contact rows
    - _Requirements: 32.19, 32.20, 32.21, 32.22, 46.19_
  - [ ] 35.13 Build the Contact_Review screens in `apps/app/web/src/moderation/contact-review.tsx`
    - The due and overdue marks and filter in the Moderation_Queue, the Contact_Review form with Keep and Erase, the correction form on the Outside_Submission view, and the history of Contact_Reviews and corrections
    - _Requirements: 32.19, 32.20, 32.21, 32.22_

- [ ] 36. Build the journal and attachment migration service
  - [ ] 36.1 Implement the journal import job in `apps/app/src/jobs/journal-import.ts` and `POST /imports/journal`
    - The server re-validates every parsed entry it receives; a `Jobs` object commits one Journal_Entry with all its Entry_Sections per batch in the P1030680 Project, with phase identifier, dates, and Campaign_Status where the journal states them, Owner the importing Administrator, every unit Not_Published and Unclassified, the Access_Level chosen for the import (Restricted with an empty Access_List, or Whole_Team) on every Research_Item, and no Findings or labels
    - Re-imports skip entries matched by phase identifier or the `front-matter` key and leave them unchanged; at the end one Activity_Feed entry with the counts, no New_Flags, and no Notification_Events; the import report (created, skipped, and failed entries and files with reasons, the Journal_Printer output as a downloadable Markdown file, the comparison result, and failing entries with titles and line ranges) is stored under `rf-private/imports/{job}/`
    - _Requirements: 26.1, 26.4, 26.9, 26.10, 26.11, 26.13, 27.4, 27.8, 47.13_
  - [ ] 36.2 Implement the attachment import in `apps/app/src/jobs/journal-import.ts`
    - Verify each stored file's size and checksum against the source values before creating its Attachment; Parent from `resolveAttachmentParent`; keep title, original file name, file kind, size label, caption, and Origin (or the fixed text "No origin recorded in the source journal", flagged in the report); Credit from the crediting contributor; Rights_Status Unknown; skip files matched by original file name
    - A file that no entry references (`resolveAttachmentParent` returns `undefined`) becomes an Attachment of the Project's Unassigned_Attachments_Source, created once per Project under the import key `unassigned-attachments` as the Source "Unassigned legacy attachments" (Primary, reliability Unknown, Rights_Status Unknown, Not_Published, Unclassified, with the import's Access_Level); the file's Origin is its metadata Origin followed by, or in its absence, "Not referenced in the source journal; provenance unknown"; a re-import reuses the Source; the report lists these files as unassigned
    - A file that cannot be read or stored, or whose copy mismatches, gets no Attachment, has any stored copy deleted, and is listed as failed with the reason
    - _Requirements: 26.2, 26.3, 26.10, 26.12, 26.15_
  - [ ] 36.3 Build the journal import screen in `apps/app/web/src/imports/journal.tsx`
    - Select the journal file, the attachment folder, and the metadata JSON; parse, print, and compare in a Web Worker; show the report preview (entries, sections, unassigned spans, attachments with Parents, files that will go to the Unassigned_Attachments_Source); choose the Access_Level for the import, with Restricted preselected and the statement that the importing Administrator, as Owner, and every Administrator can read Restricted items; hash and upload the files; start the job and show progress and the report with the access choice
    - _Requirements: 26.1, 26.3, 26.11, 26.15, 27.7, 27.8, 47.13_
  - [ ] 36.4 Write integration tests for the journal import
    - The import sets no flags and creates no events but adds one feed entry; an interrupted import leaves no partial Journal_Entry and resumes; a re-import skips everything; unreferenced files land in one Unassigned_Attachments_Source per Project; every Research_Item gets the chosen Access_Level
    - _Requirements: 26.9, 26.10, 26.13, 26.15, 47.13_

- [ ] 37. Build the Bulk_Import with the Manifest_Parser and Manifest_Printer
  - [ ] 37.1 Implement the Manifest_Parser in `packages/manifest/src/parse.ts`
    - CSV decoded with `TextDecoder('utf-8', { fatal: true })` after an optional byte order mark, RFC 4180 records with LF or CRLF and kept line breaks inside quotes; XLSX through SheetJS from the first worksheet using each cell's formatted text, listing other worksheets with non-empty cells; values kept exactly; empty rows skipped; spreadsheet row numbers with the header as row 1
    - Header errors (missing required column, repeated name, unnamed column with a value, by position), row errors (empty or repeated Row_Key, invalid kind, Rights_Status that is not current), missing kind-specific columns naming the column and kind, and encoding or quoting errors naming the starting row, each returning no rows
    - _Requirements: 33.10, 37.1, 38.1, 38.2, 38.3, 38.6, 38.7, 38.8, 38.9_
  - [ ] 37.2 Implement the Manifest_Printer in `packages/manifest/src/print.ts`
    - CSV in UTF-8 with a byte order mark, CRLF line ends, the header in the original column order, and every field quoted with inner quotes doubled, so that parsing the output gives back the same rows
    - _Requirements: 38.4, 38.5_
  - [ ] 37.3 Write property test for the manifest round trip
    - Use `manifestArb` and `csvBytesArb` in `packages/testing/src/manifest.ts` with Unicode values, quotes, commas, line breaks, spaces, empty cells, byte order marks, invalid UTF-8, and unclosed quotes
    - **Property 68: Manifest round trip**
    - **Validates: Requirements 38.4, 38.5**
  - [ ] 37.4 Write property test for manifest parsing and validation
    - **Property 69: Manifest parsing is exact and validation is complete**
    - **Validates: Requirements 33.10, 37.1, 37.2, 37.3, 37.8, 37.16, 38.1, 38.2, 38.3, 38.6, 38.7, 38.9**
  - [ ] 37.5 Implement Bulk_Import validation in `apps/app/src/jobs/bulk-validate.ts`
    - Re-run the parser and row rules on the server, then check Party, archive or desk, and contact names against at most one Member or External_Party; files that exist, are named by one row only, and fit the Attachment_Size_Limit; version marks without branches or cycles that name only the row's files; kind-specific columns filled for the row's kind and empty otherwise, with the date column empty for Findings, Hypotheses, and Topics; each row's values against the kind's schema with the Log_Summary checked only for length; an Origin of 1 to 5,000 characters for rows with files
    - The optional `access_level` (`whole_team` or `restricted`) and `access_members` columns: names in `access_members` are matched against exactly one Pending or Active Member like Party names, and `access_members` filled with `access_level` other than `restricted` is a row error; a `research_question` kind is a row error (R50.8)
    - Any error creates no Item and the report lists every error with row, column, file name, and reason; folder files that no row names are listed as not imported without being errors
    - _Requirements: 33.10, 37.2, 37.3, 37.4, 37.8, 37.16, 47.13, 50.8_
  - [ ] 37.6 Implement the Bulk_Import job in `apps/app/src/jobs/bulk-import.ts` and `POST /imports/bulk`
    - In the chosen Project, one batch per row: a Research_Item of the row's kind (Findings and Hypotheses Open) with the mapped values, an Attachment per file with the row's Origin, caption, Credit, and rights, the row's rights on a Source, Parties linked by name or created as External_Parties, and Version_Chains in the declared order; every unit Not_Published and Unclassified; the row's own Access_Level and Access_List when its access columns are filled, otherwise the access choice made for the import
    - A Row_Key already used by an earlier or concurrent Bulk_Import skips the row through the unique index; a file that fails to store or match fails the whole row; writes are metered against the daily import allowance and the job pauses until the next UTC day when it is used
    - The final step writes New_Flags and New_Submission events in chunks, both joined to the `canRead` fragment, and sets the Submission complete in one statement; the report lists created, skipped, and failed rows and Attachments with row number, Row_Key, and reason, and states the access choice
    - _Requirements: 33.9, 37.5, 37.6, 37.7, 37.9, 37.10, 37.11, 37.12, 37.13, 37.14, 37.15, 37.17, 37.18, 47.5, 47.13_
  - [ ] 37.7 Build the Bulk_Import screen in `apps/app/web/src/imports/bulk.tsx`
    - Choose the Project and the Access_Level for rows that do not set their own (Restricted preselected, with the statement of who can read Restricted items), select the manifest and folder, show the browser-side validation report, hash and upload the files, start the job, and show progress and the report
    - _Requirements: 37.3, 37.11, 37.17, 47.13_
  - [ ] 37.8 Write property test for import idempotency and mapping
    - **Property 70: Imports are idempotent and map rows and files correctly**
    - **Validates: Requirements 26.2, 26.10, 26.12, 26.15, 33.9, 37.6, 37.7, 37.12, 37.15, 37.18, 47.13**
  - [ ] 37.9 Write property test for import reports
    - **Property 71: Import reports account for every input**
    - **Validates: Requirements 26.11, 37.4, 37.11**
  - [ ] 37.10 Write property test for atomic saves
    - **Property 28: Saves are all-or-nothing**
    - **Validates: Requirements 4.1, 4.5, 26.13, 28.13, 32.15, 37.13**
  - [ ] 37.11 Write property test for budget gates
    - **Property 81: Budget gates admit only what the budget allows**
    - **Validates: Requirements 28.5, 37.14**

- [ ] 38. Build the Export_Service: Public_Archive_Exports, Internal_Backups, and restore
  - [ ] 38.1 Implement the export templates and data files in `packages/public-render/src/export/`
    - The public templates with relative links; an index page with start time, Export_Scope, and links to everything; the About, Methods, and Licence pages as of the start time with last-updated dates; CSS, fonts, and their licence notices under `assets/`; no search page
    - `data/archive.json` with every value each view shows, character for character, ISO 8601 dates at recorded precision, presented Cross_Links, each Research_Item's Project, and each child's Parent and position; `data/research-items.csv` and `data/attachments.csv`; `LICENSE.txt`; `MANIFEST.json` and `SHA256SUMS`; register the outputs in `packages/testing/src/public-channels.ts`
    - _Requirements: 35.1, 35.3, 35.4, 35.12, 45.12, 45.20_
  - [ ] 38.2 Implement the Public_Archive_Export job in `apps/app/src/jobs/export.ts`, `POST /exports`, and `GET /exports`
    - Build the package under `rf-private/exports/{id}/` from the views valid at the start time for the Export_Scope, with server-side copies of Public Attachment files; mark it complete only when every manifest entry has its size and checksum, otherwise incomplete with each missing or mismatched file listed; a System_Alert for every Administrator (scheduled) or the requester (requested) when incomplete or not complete within 24 hours
    - The cron starts the scheduled export at 00:07 UTC on the first day of each month; keep the 3 most recent complete scheduled exports and delete older ones; delete requested exports 7 days after their start
    - Store each package's index of units with exported levels, named External_Parties, and email-like strings; label packages holding material no longer public, a Party now marked Do_Not_Name, or a registered Member's address, and offer deletion; list the packages that contain elements removed by a permanent deletion and delete the selected ones within 24 hours, stating that copies outside R2 are unaffected
    - _Requirements: 22.8, 35.1, 35.2, 35.5, 35.6, 35.7, 35.8, 35.10, 35.11, 42.18, 46.34_
  - [ ] 38.3 Implement package volume streaming in `apps/dl/src/tar.ts`
    - Stream packages as POSIX tar volumes with pax headers for UTF-8 names and at most 900 objects per volume, only through Download_Links
    - _Requirements: 28.8, 35.9, 36.2_
  - [ ] 38.4 Implement the Internal_Backup job in `apps/app/src/jobs/backup.ts` and `POST /backups`
    - Use the renewable freeze/read-retention lease helpers from 58.3 for the consistent bounded snapshot; every API/cron/raw SQL/outbox writer checks the shared live lease. Snapshot expiry/overrun invalidates the package and permits safe writers; never leave a bare frozen counter indefinitely.
    - Back up the versioned authoritative table inventory and field/file manifests: research, identity, policy, access/holds/approvals/permission evidence, Question/work/decision/citation/derivation/compute/release objects, author-scoped drafts and navigation, and retained idempotency result identities. Exclude derived flags/views, notifications/events, mail queues/sessions, transient staging and network counters; never replay pending external sends.
    - Seal the authenticated format/schema/version/count/hash manifest defined in 58.1, copy immutable files under read leases or invalidate when deletion supersedes the lease, and report every missing/mismatched element. Independent schedules, encryption/copy verification and retention are task 58.2; requested staging packages expire after seven days, not the independent retained recovery points.
    - _Requirements: 28.8, 36.1, 36.2, 36.3, 36.6, 36.7, 36.11, 36.12, 36.13, 36.14, 47.15, 48.11, 49.7, 60.1_
  - [ ] 38.5 Implement restore in `apps/app/src/jobs/restore.ts` and `POST /restores`
    - Use 58.4 preflight to authenticate/decrypt the manifest and verify schema/format, all bytes, references/counts, destination eligibility and bootstrap identity before inserting research; browser hashes are supplementary. Accept the current and two prior released formats where available through explicit transforms.
    - Insert with restore-owned key/payload-hash checkpoints, skipping only identical rows already installed by the same restore; any other conflict fails with a report. Reconcile a temporary Administrator sharing an email but not an ID without losing the original Member IDs or attribution; never use unconditional INSERT OR IGNORE.
    - Resume each bounded stage after crashes without duplicate research or external sends. Remain quarantined with the Publisher paused until counts, hashes, references, current credentials/permissions and independent suppression ledger pass; rebuild derived data and require explicit authorized release of containment.
    - _Requirements: 36.4, 36.5, 36.8, 36.9, 36.10, 36.11, 36.13, 36.15, 36.16, 60.2, 60.5_
  - [ ] 38.6 Build the export and backup screens in `apps/app/web/src/exports/`
    - Request an export with its scope; list exports with state, staleness labels, missing files, and deletion offers; Download_Links for volumes; backups and restores for Administrators only, with browser-side hashing of uploaded packages
    - _Requirements: 35.7, 35.9, 35.10, 36.2, 36.8_
  - [ ] 38.7 Write property test for Item_Identifiers
    - **Property 41: Item_Identifiers are well-formed, unique, and never reused**
    - **Validates: Requirements 15.1, 15.6**
  - [ ] 38.8 Write property test for the export JSON round trip
    - **Property 72: Export JSON round trip**
    - **Validates: Requirements 35.4**
  - [ ] 38.9 Write property test for export snapshots
    - **Property 73: Exports contain exactly the snapshot and are self-contained**
    - **Validates: Requirements 35.1, 35.2, 35.3, 35.12**
  - [ ] 38.10 Write property test for backup and restore
    - **Property 74: Backup and restore round trip**
    - **Validates: Requirements 36.1, 36.4, 36.5, 36.8, 36.10, 36.11**
  - [ ] 38.11 Write property test for package retention and staleness
    - **Property 75: Package retention and staleness labels**
    - **Validates: Requirements 35.6, 35.7, 35.10, 36.6, 46.34, 36.3, 36.12**
  - [ ] 38.12 Write property test for retention sweeps
    - **Property 86: Retention sweeps act on time**
    - **Validates: Requirements 12.8, 31.8, 32.8, 32.19, 32.20, 32.21, 35.11, 36.3, 46.20, 46.26**
  - [ ] 38.13 Write property test for character preservation
    - **Property 92: Characters and digit strings survive storage and output**
    - **Validates: Requirements 7.2, 45.13**

- [ ] 39. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 40. Build the Project_Log and the Workspace lists
  - [ ] 40.1 Implement the Project_Log in `apps/app/src/projects/log.ts` and `GET /projects/{id}/log`
    - Every Research_Item of the Project except those of incomplete Submissions, newest first by Log_Date then creation time, or reversed; ordered by a UTC key with neighbouring entries within one day read and the exact viewer time-zone order applied before the page is cut; pages of 50 with links that keep order and filters; the "no entries" notice; the first Project in the Project_Order when none is chosen
    - Entries with kind, Item_Identifier, title, Log_Date, Owner, Credit, status, Journal_Entry phase identifier and dates, withdrawal mark with date and reason, link, and the Log_Summary in full with labels or the "no Log_Summary recorded" notice; a deleted Research_Item appears as its Deletion record dated at the deletion, matching only the kind filter
    - Filters by kind, Member (Owner or Credit), current Specialty, and an inclusive Log_Date range, with an end-before-start range refused while the previous results stay; data read live on each page load
    - _Requirements: 43.1, 43.2, 43.3, 43.4, 43.5, 43.6, 43.7, 43.8_
  - [ ] 40.2 Implement the Workspace lists in `apps/app/src/lists/` and `apps/app/src/api/routes/lists.ts`
    - The Findings ledger (newest first, filters by Finding_Status, Credit person, and Specialty), Runs (newest start first with the listed columns and filters), Hypotheses (statement and status, status filter), Correspondences (newest date first, filters by Party, direction, and date range), Archival_Requests (Follow_Up_Due marks, filters by status and archive or desk), and the Projects list with every field of Requirement 39.16; every list applies the visibility gate with the `canRead` fragment, filters by one or more Projects, names each Research_Item's Project, and shows the Restricted mark; the Project_Log of 40.1 and the Projects list's counts apply the same fragment, so no entry or count reveals a Restricted Research_Item to a Member outside its Access_List
    - _Requirements: 5.7, 7.6, 8.5, 9.7, 10.4, 39.14, 39.15, 39.16, 47.4, 47.11_
  - [ ] 40.3 Build the Project_Log and list screens in `apps/app/web/src/lists/` and `apps/app/web/src/projects/log.tsx`
    - Flags (Task 25): show `FlagMark` from `apps/app/web/src/activity/activity.tsx` on entries, read as the page opened them with `useFlagSnapshot`, and call `useRecordViews` with the Items the page opens.
    - The Project_Log with Project switcher, order toggle, filters, and page links; after 10 seconds without a page, "the Project_Log is unavailable", with the 00:00 UTC note for daily limits, keeping Project, order, and filters; the list pages and the Projects list
    - _Requirements: 39.16, 43.1, 43.6, 43.8, 43.9_
  - [ ] 40.4 Write property test for query and date-range validation
    - **Property 64: Query and date-range validation**
    - **Validates: Requirements 21.9, 30.11, 43.8**
  - [ ] 40.5 Write property test for Workspace lists
    - **Property 65: Workspace lists filter by conjunction and page losslessly**
    - **Validates: Requirements 3.4, 5.7, 7.6, 8.5, 9.7, 10.4, 18.8, 18.9, 23.8, 26.8, 39.14, 39.16, 43.1, 43.2, 43.4, 43.5**

- [ ] 41. Build Dissent_Notes
  - [ ] 41.1 Implement the Dissent_Note API in `apps/app/src/dissent/dissent.ts` and `apps/app/src/api/routes/dissent.ts`
    - `POST /dissent` by an active Member other than the Owner on a Research_Item with a Log_Summary, withdrawn or not, recording text, author, time, and a snapshot of the Log_Summary's text and labels, Not_Published, with the `dissent_unique` guard; `PATCH /dissent/{id}` and `POST /dissent/{id}/withdraw` by the author only, with marks and reasons, a new snapshot on each text change, and refusal when the Log_Summary or the note changed since the editor opened, returning the current Log_Summary and the changes since
    - `DELETE /dissent/{id}` by Administrators with a reason, removing text, values, and Revisions and leaving a Deletion record; disclosure changes through the disclosure API; Restorations and Log_Summary changes never touch notes; Activity_Feed entries naming the Research_Item; the Dissent event rule in `fanout.ts`; search and publish outbox rows; package lists for deletions through the export indexes
    - _Requirements: 42.1, 42.2, 42.4, 42.5, 42.6, 42.7, 42.11, 42.12, 42.16, 42.17, 42.18_
  - [ ] 41.2 Implement Dissent_Note display in `apps/app/src/dissent/display.ts` and update `apps/app/src/projects/log.ts`
    - Non-withdrawn notes directly after the Log_Summary, oldest first, with text, author, and last-saved time in the viewer's zone on the item page, in the Project_Log, previews, Publication_Requests, and the Owner's Log_Summary editor; their count with a link where only an excerpt is shown; the earlier-wording mark with a link to the word comparison while the current Log_Summary differs from the snapshot of the author's last save
    - Withdrawn notes only on the item page and in history, with date and reason; Deletion records in place of deleted notes; the item history includes each note's creation and Revisions
    - _Requirements: 42.3, 42.8, 42.9, 42.10, 43.3_
  - [ ] 41.3 Build the Dissent_Note screens in `apps/app/web/src/dissent/`
    - Attach, edit, and withdraw forms with marks and reasons, the earlier-wording mark and comparison, the conflict view, and Administrator deletion and disclosure controls
    - _Requirements: 42.3, 42.9, 42.16, 42.17_
  - [ ] 41.4 Write property test for new Disclosure_Units
    - **Property 3: New Disclosure_Units start Not_Published**
    - **Validates: Requirements 13.5, 23.2, 23.15, 26.4, 32.4, 33.2, 37.5, 39.4, 42.1**
  - [ ] 41.5 Write property test for permanent deletion
    - **Property 36: Permanent deletion removes the subtree and leaves only a tombstone**
    - **Validates: Requirements 15.8, 16.10, 22.7, 22.8, 42.11, 42.18, 43.7**
  - [ ] 41.6 Write property test for event recipients
    - **Property 54: Recipients follow the event rules**
    - **Validates: Requirements 17.4, 17.6, 19.1, 19.2, 19.3, 19.4, 19.8, 23.7, 23.13, 32.3, 39.9, 39.10, 42.4, 46.36**
  - [ ] 41.7 Write property test for Dissent_Notes
    - **Property 80: Dissent_Notes stay attached to the wording they concern**
    - **Validates: Requirements 42.1, 42.2, 42.3, 42.8, 42.9, 42.14**

- [ ] 42. Build AI drafting
  - [ ] 42.1 Implement the AI draft API in `apps/app/src/ai/drafts.ts`, `GET /ai/status`, and `POST /ai/drafts`
    - Check the AI_Drafting_Setting, the Permission for the field, and that the requesting Member Can_Read the Research_Item (R47.4); select the input in Workspace display order (Research_Item fields, Entry_Sections, Group_Note, Attachment metadata, never file contents), using the editor's unsaved text where open; cut it to the AI_Input_Limit and flag left-out text; send nothing for empty input
    - Reserve the worst-case Neurons in `Budget` and refuse when used plus reserved would exceed 10,000 minus a 300-Neuron margin; `GET /ai/status` offers drafting only while the remaining Neurons cover one worst-case draft at the current limit; call `@cf/google/gemma-4-26b-a4b-it` (fallback `@cf/meta/llama-3.1-8b-instruct-fp8-fast`) through the `AI` binding with an allow-list of Cloudflare-hosted models and no AI Gateway, logging, caching, or batch API, a fixed system prompt, `max_tokens` 800 or 200, and a 30-second deadline; settle the reservation with the reported usage; store and log neither prompts nor drafts; refuse Public_Traffic, imports, and restores
    - _Requirements: 28.14, 28.15, 44.1, 44.2, 44.3, 44.4, 44.9, 44.10, 44.11, 44.12, 44.13, 44.17, 44.18, 47.4_
  - [ ] 42.2 Implement draft output shaping in `packages/domain/src/ai-output.ts`
    - Cut drafts at the last sentence or word boundary within 2,000, 100, or 200 characters, remove Markdown headings, add no label, return only kind and note for Disclosure_Line drafts, and flag the quotation-mark notice when a listed quotation mark stands at the start or after a space, line break, or opening bracket
    - _Requirements: 44.2, 44.7, 44.8, 44.14_
  - [ ] 42.3 Record AI provenance on save in `apps/app/src/records/pipeline.ts`
    - The client sends the model id and version and the SHA-256 of the last placed draft for each field; the creation or Revision records them with whether the saved text differs; history views show these details
    - _Requirements: 44.6_
  - [ ] 42.4 Build the editor draft controls in `apps/app/web/src/editor/ai-draft.tsx`
    - The request control only when the status allows, with the "turned off" or "resumes at 00:00 UTC" notice otherwise; the draft held only in the tab's editor memory and shown apart from the field; accept places the text, asks before replacing, and leaves the field unsaved; discard or a new draft removes the old one; the quotation-mark notice next to the draft and then the field until saved; "no AI_Draft was produced" on errors, empty output, or timeout, with late answers discarded
    - _Requirements: 44.4, 44.5, 44.8, 44.10, 44.11, 44.12, 44.16, 44.17_
  - [ ] 42.5 Write property test for the AI allocation
    - **Property 83: AI requests never exceed the allocation**
    - **Validates: Requirements 28.14, 44.10, 44.11, 44.17**
  - [ ] 42.6 Write property test for AI input and output
    - **Property 84: AI input selection and output shaping**
    - **Validates: Requirements 44.1, 44.2, 44.3, 44.7, 44.8, 44.14, 44.18**
  - [ ] 42.7 Write property test for AI provenance
    - **Property 85: AI provenance is recorded on save**
    - **Validates: Requirements 44.6**

- [ ] 43. Complete the Design_System and build Policy_Page editing
  - [ ] 43.1 Implement Policy_Section editing in `apps/app/src/policy/policy.ts` and `GET/PUT /policy/{page}`
    - Preview the page exactly as the Public_Site renders it and apply only on confirmation; record a Revision with Minor_Edit or Correction and reason; refuse a missing mark, an invalid reason, an empty required section, more than 20,000 characters, or a conflicting Revision, keeping the input and listing Revisions since; no route adds, removes, renames, or reorders sections; one Activity_Feed entry linking to the page's history; a publish outbox row; history and comparisons as for Items
    - _Requirements: 46.27, 46.28, 46.30, 46.31, 46.32_
  - [ ] 43.2 Implement the Responsible_Person designation and alert in `apps/app/src/policy/responsible.ts`
    - Administrators designate only an active Member, others are refused with no Revision; the change is a Minor_Edit Revision of the Privacy page holding the previous person, an Activity_Feed entry, and an urgent publish; while the Responsible_Person is Revoked, the quarter-hour cron check sends every Administrator a System_Alert within 15 minutes and every 7 days
    - _Requirements: 46.35, 46.37, 46.38, 46.39, 46.40_
  - [ ] 43.3 Implement Policy_Page generated content and last-updated dates in `apps/app/src/publisher/policy-pages.ts`
    - People page input from active Members with Public_Profile On through `projectProfile`, the Methods list from the value sets and Methods_Terms, the Licence page's Content_Licence name, the Retention_Table from `retentionRows()`, and the Responsible_Person's display name; each page's last-updated date is the UTC date of the latest section change, fixed-text version date, or change of generated content detected by hash comparison
    - _Requirements: 46.5, 46.6, 46.7, 46.11, 46.19, 46.29, 46.38_
  - [ ] 43.4 Build the policy, settings, and value-set screens in `apps/app/web/src/admin/`
    - Policy_Page editors with preview and confirmation, history and comparisons, the Responsible_Person setting, the settings screen with allowed ranges, and the value-set screens with retire, rename, publication marks, and Public_Descriptions
    - _Requirements: 19.2, 33.8, 46.13, 46.27, 46.37_
  - [ ] 43.5 Write the print stylesheet in `packages/design/src/print.css`
    - Hide navigation, the search box, pagination, buttons, and form fields; keep link texts; wrap wide tables, code, and display mathematics within the page; print the page address in full from `data-url`; keep the footer statements; always use the light scheme on A4 and US Letter
    - _Requirements: 45.9_
  - [ ] 43.6 Complete accessibility and layout across `packages/design` and `apps/app/web`
    - Landmarks and a skip link, focus never hidden by sticky headers, button alternatives to every drag action including Entry_Section reordering, consistent help placement, no re-entry of information within a process, labelled errors with suggestions, reduced motion, MathML, and keyboard-operable preview controls; fluid layout from 320 to 2,560 CSS pixels with wide tables, code, mathematics, and previews scrolling inside their own containers
    - _Requirements: 45.5, 45.7_
  - [ ] 43.7 Write the Playwright presentation tests in `tests/presentation/`
    - axe-core on every page type in both colour schemes; a viewport sweep from 320 to 2,560 pixels with no horizontal page scroll, overlap, or clipping; print to PDF on A4 and US Letter compared with the page text; colour-scheme switching without reload; a privacy crawl recording network requests and cookies or storage; visual regression of every component through both renderers
    - _Requirements: 45.1, 45.5, 45.7, 45.9, 45.16, 45.17, 45.18_
  - [ ] 43.8 Configure Lighthouse CI in `lighthouserc.json`
    - 20 loads per representative public page under the Reference_Mobile_Profile with an empty cache, asserting the 75th percentiles of Largest Contentful Paint, Cumulative Layout Shift, and Interaction to Next Paint
    - _Requirements: 45.8_
  - [ ] 43.9 Write property test for concurrent saves
    - **Property 29: Concurrent saves from one base are serialized**
    - **Validates: Requirements 4.9, 22.10, 32.16, 42.16, 46.28**
  - [ ] 43.10 Write property test for reminder and alert schedules
    - **Property 87: Reminder and alert schedules**
    - **Validates: Requirements 10.3, 35.5, 36.7, 46.24, 46.25, 46.40**
  - [ ] 43.11 Write property test for the People page and Responsible_Person statement
    - **Property 95: People page and Responsible_Person statement**
    - **Validates: Requirements 46.5, 46.6, 46.35, 46.38**
  - [ ] 43.12 Write property test for last-updated dates
    - **Property 98: Policy_Page last-updated dates**
    - **Validates: Requirements 46.29**

- [ ] 44. Build usage monitoring and System_Alerts
  - [ ] 44.1 Implement the analytics queries in `apps/ops/src/analytics.ts`
    - `usage()` querying the Cloudflare GraphQL Analytics API for Worker requests, D1 rows read and written and storage per database, R2 storage and Class A and B operations, and Workers AI Neurons
    - _Requirements: 19.10_
  - [ ] 44.2 Implement usage alerts in `apps/app/src/usage/alerts.ts`
    - Every 15 minutes combine the analytics with the `Budget` figures for the Public_Traffic_Budget, the AI_Allocation, and the Recipient_Cap; a state machine per allowance and period raises one System_Alert for every Administrator, naming the allowance and the percentage, each time usage rises from below 80% to 80% or more
    - _Requirements: 19.10, 28.2_
  - [ ] 44.3 Write property test for usage alerts
    - **Property 82: Usage alerts fire on upward crossings**
    - **Validates: Requirements 19.10**

- [ ] 45. Add security headers and hardening checks
  - [ ] 45.1 Implement the Workspace security headers in `apps/app/src/api/security-headers.ts` and `apps/app/web/public/_headers`
    - The Workspace Content-Security-Policy from the design, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, HSTS with preload, `X-Content-Type-Options: nosniff`, and a minimal `Permissions-Policy`
    - _Requirements: 14.6, 45.17_
  - [ ] 45.2 Implement the Public_Site headers in `packages/public-render/src/headers.ts`
    - Generate `_headers` with the public Content-Security-Policy, the additions for form pages only (`submit.researchforce.org`, the R2 S3 endpoint, `challenges.cloudflare.com`), `Referrer-Policy: strict-origin-when-cross-origin`, HSTS, `nosniff`, and `Permissions-Policy`; no header or script sets a cookie
    - Cloudflare Web Analytics stays off at launch through `WEB_ANALYTICS = false` in the same module; turning it on adds only its cookieless beacon to the policy, and the Privacy page must then name the service
    - _Requirements: 45.17, 45.18, 45.19_
  - [ ] 45.3 Write security tests in `tests/security/`
    - Run browser tests against actual rf-dl/public-file delivery and previews with HTML, SVG, PDF and polyglots, checking no script or accepted cross-origin request runs as the Member, including CSP and resource-limit failure paths; test Member-bound link expiry, revocation, current restricted access, wrong object and purpose.
    - Exercise the real channel adapters with generated canaries; a registered constant refusal alone is not evidence. These tests are mandatory for the team-file and public-release gates.
    - _Requirements: 14.6, 14.10, 25.5, 25.6, 60.4_
  - [ ] 45.4 Write the CI smoke checks in `tools/smoke/`
    - No route accepts file bodies and none returns renditions; the AI model allow-list holds only Cloudflare-hosted models and no AI Gateway is configured; no secret appears in the repository; every font and icon has a licence that allows self-hosting and export; the Policy_Section list matches Requirement 46.32
    - _Requirements: 12.5, 14.9, 20.20, 44.9, 45.20, 46.32_

- [ ] 46. Add observability
  - [ ] 46.1 Implement metrics and the operations status endpoint in `apps/app/src/metrics.ts` and `GET /api/v1/ops/status`
    - Structured metric events per route (requests, CPU time, D1 rows), Publisher lag from save to deploy and to verified removal, Mailer queue depth, held time, and delays against the time limits, AI Neurons per day, and Public_Traffic_Budget use; an Administrator-only summary endpoint
    - _Requirements: 24.11, 28.2, 28.3_
  - [ ] 46.2 Write the performance test harness in `tests/perf/`
    - Certify the selected Resource_Profile against the Reference_Archive and worst-case Unicode/spans/chunks, 100-file submissions, draft/proposal graphs, common-term 50 MB search with large result pages, 1,000-unit previews, publisher epochs/removal, and retained/transient export/backup/release copies.
    - Measure CPU, binding calls, statements, encoded bytes, peak memory, D1 growth and full transfer size, distinguishing provider limits from chosen safety margins. Reproduce 1/3/5-year growth scenarios and the 30-minute distributed invalid-download/public-API Abuse_Profile with concurrent authorized saves/downloads and a removal.
    - Record maxima, percentile data, profile/version/assumptions and pass/fail evidence; keep <=24-hour verified independent RPO and <=8-hour reference restore evidence. A profile that fails cannot be advertised or deployed for that scope.
    - _Requirements: 21.2, 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.15, 28.17, 30.6, 36.17, 60.7_
- [ ] 47. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 48. Prepare deployment configuration and the setup checklists
  - [ ] 48.1 Write the Cloudflare resources as code in `infra/cloudflare/resources.ts` and `infra/cloudflare/provision.ts`
    - D1 databases; R2 buckets with CORS (PUT from the Workspace and apex origins with checksum headers), the lifecycle rule that aborts multipart uploads after one day, `r2.dev` off, and the `files.researchforce.org` custom domain; the `www` redirect, the "bypass cache" rule and response header rule on `files`, the disabled WAF block rule for `submit`, and the rate-limiting rule for `submit` and `dl`; Bot Fight Mode and Always Online off; Worker custom domains; the Access application (24-hour session, cookie settings, one-time PIN, Google, and GitHub, the `rf-members` list and allow policy); the managed-mode Turnstile widget
    - `provision.ts --dry-run` prints the planned API calls without account access; `infra/secrets.ts` lists every secret per Worker and `tools/check-secrets.ts` reports missing ones
    - _Requirements: 1.1, 1.3, 25.2, 25.3, 28.5, 31.3, 45.18_
  - [ ] 48.2 Write the Microsoft 365 setup script in `infra/m365/Setup-ResearchForceMail.ps1`
    - Create the shared mailbox named ResearchForce at the Sending_Address; register the app with a certificate credential and no organization-wide Mail.Send consent; create the Exchange service principal, a management scope matching only the mailbox, and the "Application Mail.Send" role assignment with that scope, then run `Test-ServicePrincipalAuthorization`; turn single item recovery off, set the shortest deleted-item retention, and apply no holds; add a transport rule that rejects inbound mail to the address with an explanation of how to respond
    - _Requirements: 20.19, 20.21, 20.24, 45.21_
  - [ ] 48.3 Write the DNS records and their check in `infra/dns/records.ts` and `tools/check-email-dns.ts`
    - SPF `v=spf1 include:spf.protection.outlook.com -all`, the DKIM CNAMEs as DNS-only records, and DMARC `p=none` with reports to an address other than the Sending_Address; the check resolves and validates all three
    - _Requirements: 20.22, 20.23_
  - [ ] 48.4 Write the deployment and bootstrap scripts in `scripts/deploy.ts`, `tools/bootstrap.ts`, and `.github/workflows/ci.yml`
    - Implement the explicit compatible rollout: additive expansion, compatible Worker deployment, bounded backfill/verification, switch read paths, contraction only after old consumers and the recovery window end. Record Worker/schema/backup compatibility and safe rollback or forward-recovery versions; CI runs all mandatory evidence for the selected scope, not npm run ci alone.
    - Bootstrap validated installation identity, origins, initial Project and Responsible_Person. Consume task 48.10’s validated `Installation_Public_Copy`, record its version/digest in bootstrap and site-build state, initialize “About the group” from its configured prose, and refuse a partial or changed-without-release bundle.
    - Require the owner-configured Content_Licence before publication/agreement collection; require an approved Operating_Profile/budget, independent recovery destination/key custody, initial fresh restore and containment capability for the applicable production gates. Provisioning does not infer permission to buy plans, publish research, or select a content licence.
    - Use task 67 compatibility manifests and task 68 launch-gate checks; this script is built before operator setup and calls the completed gate checker at execution. A Workspace-only deployment must have public dynamic endpoints disabled until their own gate passes.
    - _Requirements: 2.2, 26.1, 40.12, 46.37, 46.41, 46.42, 28.1, 28.4, 36.12, 36.17, 60.3, 60.4, 60.5_
  - [ ] 48.5 Write the staging verification suites in `tests/staging/` and `infra/m365/Verify-ResearchForceMail.ps1`
    - Make real staging verification mandatory for its deployment scope: Access redirects and scoped bearer exceptions; real single/multipart R2 checksum/CORS behavior; Graph least privilege, credential rotation, SPF/DKIM/DMARC, acceptance versus delivery, MIME/plain text and residual provider retention; Turnstile and addressed snapshots.
    - Certify public change timing and independently verified containment across pages/index/files/People/policy/release assets; inject deploy/quota failures and old-generation retries; run the distributed Abuse_Profile while Members save/download and compare measured resource/spend reserve.
    - Rehearse independent encrypted backup/key recovery and fresh restore with bootstrap identity conflict, older schema, crash/resume and a later suppression. Keep sanitized evidence; missing operator infrastructure blocks the applicable gate rather than skipping tests.
    - _Requirements: 1.1, 1.3, 12.10, 20.19, 20.21, 20.22, 20.24, 20.26, 24.11, 24.12, 24.16, 24.17, 28.1, 28.2, 28.6, 28.7, 28.17, 36.17, 45.21, 60.4, 60.9_
  - [ ] 48.6 User setup checklist (needs Cloudflare account access)
    - Prepare and dry-run the scripts first; use account access already authorized, or ask the operator for the missing account action to run `provision.ts` for staging and production; set every secret listed in `infra/secrets.ts`; confirm that `workers.dev` and preview URLs are off and Bot Fight Mode is off; and report the results
    - _Requirements: 1.3, 28.1, 45.18_
  - [ ] 48.7 User setup checklist (needs Microsoft 365 administrator access)
    - The user runs `Setup-ResearchForceMail.ps1`, waits 30 minutes to 2 hours, re-runs `Test-ServicePrincipalAuthorization`, checks the "Tenant Outbound External Recipients" report and sets the Recipient_Cap below the tenant's shared external limit, and stores the Graph tenant, client id, and certificate key as Workers secrets
    - _Requirements: 20.16, 20.19, 20.20, 20.25_
  - [ ] 48.8 User setup checklist (needs DNS access for researchforce.org)
    - The user publishes the SPF, DKIM, and DMARC records, enables DKIM signing for researchforce.org in Microsoft 365, and runs `tools/check-email-dns.ts`
    - _Requirements: 20.22, 20.23_
  - [ ] 48.9 Activate only production scopes with passing launch evidence
    - After 48.12, run the 68.4 checker on the complete version/configuration-bound evidence. Bootstrap production with the explicit installation/profile/budget/recovery inputs and operator-selected content licence; run the production import only after the team-archive gate passes, creating everything Not_Published and Unclassified.
    - Before enabling the public site, compare the rendered production home and About pages with `docs/instance/researchforce-org-content.md`: exact masthead/strapline, Mission paragraph, three About paragraphs, seven Principles and their order; verify their configured version/digest is in the deployed site manifest and a copy-only release invalidates every affected output.
    - Enable public research only after the public gate and normal content approvals, and enable outside submissions/emailed grants/AI only after their provider/privacy gates and configured settings. Verify production deny controls and independent health/recovery alerts. No setup step infers permission to buy a service or publish particular research.
    - _Requirements: 26.4, 26.11, 27.7, 28.17, 36.12, 36.17, 40.12, 46.41, 46.42, 60.3, 60.4, 60.5, 60.9_
  - [ ] 48.10 Prepare the reusable source release and independent-installation guide
    - Add a typed, versioned and digest-addressed `Installation_Public_Copy` and wire it through the public header/home/About renderers, metadata, page last-updated inputs, site-build manifest input and policy-page export. Validate a complete masthead name, strapline, Mission statement, About prose and ordered Principles. ResearchForce.org uses `docs/instance/researchforce-org-content.md` verbatim; fixtures and other installations provide different complete bundles, with no ResearchForce.org fallback.
    - Document installation configuration, migration and upgrade steps, and the separate software/content licensing boundaries; include the MIT licence and required third-party notices in software distributions.
    - Verify the shared configuration and renderers with a synthetic second installation whose domain, identity, masthead, strapline, Mission, About prose, Principles, policy statements, first Project, and chosen content licence differ from ResearchForce.org; verify missing/partial public copy or content-licence configuration refuses site generation, publication and agreement collection, and verify no ResearchForce.org organizational wording leaks into its rendered pages or export.
    - Check release material for real research, personal data, secrets, backups, and instance state; do not include them or publish a repository as part of this preparation
    - _Requirements: Introduction (product and installation scope), 23.2, 29.10, 33.4, 40.12, 46.16, 46.17, 46.41, 46.42_
  - [ ] 48.11 Bootstrap an isolated staging installation for provider verification
    - After operator resource/mail/DNS setup, deploy the completed compatible code to staging with public research and outside features denied by default. Configure a visibly synthetic public identity/editorial bundle as well as synthetic installation/profile/licence inputs, independent recovery destination and custodians, alert routes and containment controls; obtain credentials through secrets, never source or reports. Verify a copy-only release refreshes the home/About pages and leaves ResearchForce.org wording absent.
    - Establish Access/R2/Graph/edge-control connectivity and record the deployed versions and resource bindings. This is test infrastructure readiness, not approval for production or sole-copy custody; use synthetic data until the protected import rehearsal in 48.12.
    - _Requirements: 1.1, 1.3, 28.17, 36.12, 60.4, 60.5, 60.6_
  - [ ] 48.12 Execute and retain complete staging and team acceptance evidence
    - Run 48.5's real provider suites, 58.5's independently keyed fresh restore, 59.4's distributed abuse/failed-removal scenarios, 46.2's measured profile certification and R60.9's team walkthroughs against the deployed staging versions; record all results and failures in the gate manifest.
    - Rehearse the journal import using the operator's protected source paths without adding research to Git or output reports; retain counts and authorized sanitized verification only. Verify production configuration equivalence and independent recovery/containment capability. Missing licence, provider inputs or passing evidence leaves the affected launch gate blocked.
    - _Requirements: 20.24, 24.16, 24.17, 26.4, 26.11, 28.17, 36.17, 60.4, 60.6, 60.7, 60.9_

- [ ] 49. Final checkpoint - Ensure all tests pass
  - Require the selected R60.4/68.4 gate evidence, compatible upgrade/recovery manifest and current operator inputs in addition to `npm run ci`; no required test is skipped and no public/custodial launch proceeds on unit results alone.

- [x] 50. Add a local development environment
  - [x] 50.1 Add the local runner and synthetic seed data in `scripts/dev.ts` and `tools/dev-seed.ts`
    - `npm run dev` applies the D1 migrations to local databases (`wrangler d1 migrations apply --local`), starts `rf-app` with `wrangler dev` in local mode (Miniflare, no remote bindings, storage under `.wrangler/`), and starts the Vite dev server for the Workspace with `/api` proxied to the Worker
    - `tools/dev-seed.ts` fills the local databases and R2 buckets with synthetic Members, Profiles, Projects, and Research_Items of every kind; `npm run dev:reset` deletes the local state and seeds again
    - _Requirements: none (developer tooling)_
    - Acceptance: `docs/acceptance/task-evidence.json` records the local Wrangler/Vite startup, proxy, reset/reseed and shutdown checks plus executed migration/seed/isolation tests. Usage and boundaries are documented in `README.md`; the runner has no local-auth bypass.
  - [x] 50.2 Add a development-only sign-in in `apps/app/src/auth/dev.ts`
    - A local signer, like the test key server in `packages/testing/src/jwt.ts`, issues Access-shaped assertions for a chosen seeded Member; a small page lists the seeded Members to sign in as, and signing out clears the local session
    - It is enabled only by a variable in `.dev.vars`, which is ignored by git; `rf-app` refuses to start when that variable is set with non-local bindings, and `scripts/deploy.ts` refuses any configuration that sets it; tests check both refusals and that the sign-in routes answer 404 without the variable
    - _Requirements: none (developer tooling)_
    - Acceptance: `docs/acceptance/task-evidence.json` records executed local/runtime/deploy/HTTP-file-denial and UI tests plus live HTTP and browser sign-in, protected navigation, sign-out and reauthentication checks. Production builds and guarded Worker dry-run bundles passed; no deployment occurred.
  - [x] 50.3 Add local stand-ins for remote services
    - Stub the `OPS` service binding and Workers AI with deterministic responses; capture outgoing email in a local outbox page instead of calling Microsoft Graph; document in `README.md` what runs locally and what does not (Cloudflare Access, Workers AI, Microsoft 365)
    - Integrate stand-ins through the controlled local entrypoint and extend its explicit local-binding checks; retain production and deployment refusal of local-auth configuration.
    - _Requirements: none (developer tooling)_

    - Acceptance: `docs/acceptance/task-evidence.json` records native-worker, queue/capture, retention/paging, authorization and safe rendering tests plus browser invitation/AI/refusal and full-restart persistence checks. `README.md` documents emulation limits and the local outbox. Production builds and guarded dry-run bundles passed; nothing was deployed.

- [x] 51. Rename the stored Disclosure_Level `private` to `not_published`
  - [x] 51.1 Rename the value in the domain, database, and kernel
    - Replace `'private'` with `'not_published'` in the Disclosure_Level and classification types in `packages/domain`, the Drizzle schema in `packages/db/src/schema`, every column default, and `packages/kernel`
    - Add the next `rf-core` migration, which rebuilds `projects` and `units` (their level checks, their `'private'` defaults, and the check `units_unclassified_private`, renamed `units_unclassified_not_published`) with the new value, copies the rows with `'private'` mapped to `'not_published'`, and recreates their indexes and triggers; add the matching `rf-search` migration for `search_docs`; generate both with drizzle-kit and check them against local databases holding synthetic rows of every level
    - _Requirements: 23.1_
  - [x] 51.2 Rename the value in the API, the Workspace, and the tests
    - API request and response values, the Workspace labels ("Not published"), seed texts, and every test and fixture that uses `'private'` as a level; rename the titles of Properties 3, 4, and 7 in their test files' tag comments and `describe` names to the design's current titles
    - `rg -n "'private'"` over `apps` and `packages` finds no Disclosure_Level use afterwards
    - _Requirements: 23.1_

- [ ] 52. Build restricted access inside the team
  - Existing implementation and migration are present; task 57.1 reconciled acceptance individually. See `docs/acceptance/README.md` and the task-evidence ledger; 52.4–52.6 retain their preview/projection/list integration gaps. Do not recreate an already applied migration. Later kinds extend these privacy checks in their own tasks.
  - [x] 52.1 Add the access data and Permissions
    - The next migration adds `research_items.access_level` (`whole_team` or `restricted`, default `whole_team`), `access_grants (root_id, member_id, granted_by, granted_at)` with primary key (`root_id`, `member_id`), the guard table `_g_access_owner`, and the Revision_Kind `access_change`; add `access_owner` to `GUARD_CODES` in `packages/db/src/batch.ts`
    - Adding `access_change` changes the `revisions_kind_values` check, so the migration rebuilds `revisions` as task 51's migration rebuilt `units`, and recreates the `revisions_immutable` trigger from `0001_raw.sql`, which dropping the table removes; extend the migration test pattern of `apps/app/test/migration-not-published.test.ts` to check the rows, the indexes, and that the trigger still refuses updates
    - Add the Permissions `access.restrict`, `access.widen`, `hold.place`, `hold.lift`, `consent.give`, `consent.propose`, `dual.propose`, `dual.approve`, `dual.decline`, and `attachment.move` to the Role_Permission_Map in `packages/domain/src/permissions.ts` as the design's table assigns them, so that tasks 53 to 55 use them without changing the map again
    - _Requirements: 2.4, 2.5, 47.1_
  - [x] 52.2 Implement the `canRead` fragment and retrofit the existing read paths
    - `canRead(memberId, isAdmin, rootColumn)` in `packages/db/src/access.ts`, the SQL fragment of the design; join it into `visibleTo` in `apps/app/src/records/submissions.ts`, so that every read path from tasks 17 to 24 that uses the visibility gate applies it: item pages and sections, history and comparisons, Threads and Replies, Cross_Links and Backlinks, Mentions, Review_Request queues and responses, the Projects list counts, and Parties' item lists
    - A request that names an element the Member cannot read answers the shared `not_found` response; Activity_Feed entries already written keep only readable references when read (the feed itself arrives with task 25)
    - _Requirements: 2.8, 47.3, 47.4_
  - [x] 52.3 Apply access to Submissions, Mentions, and Review_Requests
    - Submissions accept `access: { level, members }` for each new Research_Item, with members limited to Pending or Active Members and the statement that the Owner and every Administrator can read Restricted items returned for display
    - Mentions and Review_Requests that name a Member who cannot read the Research_Item are refused with `rule: access_addressee` listing the Members, keeping the input; Specialty Mentions and Specialty or Role addressees reach only holders who Can_Read the Research_Item
    - _Requirements: 47.1, 47.2, 47.5, 47.10_
  - [ ] 52.4 Implement access changes in `apps/app/src/records/access.ts`
    - `POST /items/{id}/access` with `{ level, add, remove }`, `POST /access/bulk` for 1 to 1,000 Research_Items, and their preview endpoint, which lists the Members who would gain read access and, when restricting, every Public or Withheld unit whose own level the change resets, with the Public_Views removed
    - A change that only narrows needs `access.restrict`; a change that adds Members or lifts the restriction needs `access.widen` and the `access_owner` guard (task 54.5 adds the Dual_Approval path for a Revoked Owner); restricting writes, in the same batch, `not_published` on each listed unit, a Disclosure_Change per unit, Item_Update events for every Administrator, and a `publish` outbox row; every change writes an `access_change` Revision with the previous level and list; a bulk change applies to every Research_Item or none and states the reason
    - Item history (`apps/app/src/records/history.ts`, `packages/domain/src/history.ts`, and the history screen) lists Access_Change Revisions with the previous and new level and list; a Restoration never changes the Access_Level or Access_List, so add them to `ALWAYS_KEPT` beside the disclosure fields
    - _Requirements: 47.6, 47.7, 47.8, 47.14_
  - [ ] 52.5 Treat Restricted roots as Not_Published in the kernel
    - `loadProjectionInput` and the kernel input carry a `restricted` flag on Research_Items, and `effective()` treats a Restricted root like a Not_Published ancestor; `checkGates` refuses any change that sets a Public or Withheld level, a Public_Presentation, a Public_Summary, or a Disclosure_Line on a Restricted Research_Item, naming it as Restricted
    - _Requirements: 23.1, 47.9_
  - [ ] 52.6 Build the access screens in `apps/app/web/src/access/`
    - The access fields in the item form (Whole_Team or Restricted, a Member picker, and the statement of who can always read), the Restricted mark with the Owner and the Access_List on item pages, lists, and Thread headers, the access dialog with the preview and confirmation, and bulk selection on lists
    - _Requirements: 47.2, 47.7, 47.8, 47.11, 47.14_
  - [x] 52.7 Write property test for restricted reads
    - Generate Members, Administrators, Research_Items with access settings, and every element kind under them; check every read endpoint built so far and every per-Member insert
    - **Property 100: Members see nothing of Research_Items they cannot read**
    - **Validates: Requirements 2.8, 47.3, 47.4, 47.5, 47.10**
  - [x] 52.8 Write property test for access changes
    - **Property 101: Only the Owner widens access, and restricting unpublishes**
    - **Validates: Requirements 47.6, 47.7, 47.8, 47.12, 47.14**

- [ ] 53. Build Attachment moves
  - [ ] 53.1 Implement the move API in `apps/app/src/files/move.ts` and `POST /attachments/{id}/move`
    - Move the whole Version_Chain to the new Parent in one batch, updating `parent_id`, `root_id`, and `project_id` of each Attachment and everything under it while identifiers, files, rights, levels, Classification_States, holds, and Cross_Links stay unchanged; a Revision per moved Attachment holding the previous Parent (Disclosure_Change when a Public_View changes, Minor_Edit otherwise) and one Activity_Feed entry
    - A preview endpoint computes the views before and after; a move that widens a Public_View needs `disclosure.set`, a fresh preview token, and the disclosure gates; a move out of a Restricted Research_Item to a Root_Item that more Members can read needs `access.widen` on the source with the `access_owner` guard; Question_Group entries that would cross Projects are removed in the same batch through task 55.2's helper
    - _Requirements: 12.12, 12.13, 12.14, 12.15, 50.7_
  - [ ] 53.2 Build the move dialog in `apps/app/web/src/files/move.tsx`
    - Choose the new Parent (a Research_Item or Reply the Member Can_Read; editing the moved Attachment is required, editing the destination is not), show the preview with changed views and Members who gain read access, and confirm; offered on every Attachment page, including those of the Unassigned_Attachments_Source
    - _Requirements: 12.12, 12.14_
  - [ ] 53.3 Write property test for Attachment moves
    - **Property 105: Attachment moves keep identity and move whole Version_Chains**
    - **Validates: Requirements 12.12, 12.13, 12.14, 12.15**

- [ ] 54. Build Owner consent, Confidentiality_Holds, and Dual_Approvals
  - [ ] 54.1 Add the consent, hold, and approval data
    - The next migration adds `publication_consents`, `confidentiality_holds` with its partial unique index, and `dual_approvals` as the design defines them, the Review_Request type `proposal` (the existing `review_requests` checks allow an outcome only on Publication_Requests and only Applied or Declined, so the migration rebuilds `review_requests` with a request type column and outcomes Approved and Declined for proposals, mapping existing rows), and the guard tables `_g_consent_valid`, `_g_hold_free`, `_g_dual_open`, and `_g_dual_distinct`; add the codes to `GUARD_CODES`
    - _Requirements: 23.18, 48.1, 49.2, 23.23, 23.24, 49.8_
  - [ ] 54.2 Add the widening test and the new gates to the kernel and `loadProjectionInput`
    - Retain widens with actual and prospective-public ancestors and the hold/Restricted gates. Add canonical approved snapshot/dependency digests for content revisions, exact files, rights, naming, licence and other projection inputs; narrower output is omission of approved material, not a text substitution.
    - The apply batch rechecks the snapshot dependencies and unused/unwithdrawn consent, current coverage and holds before all writes. Owner approval of A followed by an Administrator edit to B requires new approval, even with identical summary/level. Retain the separate policy for an Owner editing their own already-public work.
    - _Requirements: 23.17, 23.20, 23.23, 23.24, 48.2, 48.4_
  - [ ] 54.3 Implement Publication_Proposals and consents in `apps/app/src/reviews/proposals.ts`
    - `POST /proposals` creates one Publication_Proposal per Consenting_Member with the proposed values, an optional note, and the resulting Public_Views, and a Review_Requested event; the addressee approves or declines with an optional note, writing one consent row per unit on approval and a Review_Completed event for the proposer; withdrawing an approval before it is used
    - A Publication_Request by the unit's Consenting_Member writes a consent row with source `request` while it is open; applying it with edited values needs a new consent for each value that the consent does not cover
    - _Requirements: 23.18, 23.19, 23.20, 23.21_
  - [ ] 54.4 Implement Confidentiality_Holds in `apps/app/src/disclosure/holds.ts`
    - `POST /items/{id}/holds` with a note and a preview that lists the units whose own levels the hold resets; the batch writes them as Not_Published with Disclosure_Changes, Item_Update events for every Administrator and the Owner, an `access_change` Revision, and a `publish` outbox row
    - Lifting by the placer or the Owner with an optional note, events for the placer and every Administrator, and no level change; any other lift is refused with an authorization error; holds shown on item pages, previews, Publication_Requests and Publication_Proposals, and the Unclassified list
    - _Requirements: 48.1, 48.2, 48.3, 48.5, 48.6, 48.7, 48.10_
  - [ ] 54.5 Implement Dual_Approvals in `apps/app/src/reviews/dual.ts`
    - Keep propose/approve/decline/withdraw for hold_override, departed-Owner access_widen and consent_on_behalf with immutable reasons/history. Store target/effect and approved content/dependency digests.
    - Inside the approving batch recheck both proposer and approver as different currently Active Administrators, the exact effect/snapshot, open state and every action precondition; lapse a changed or ineligible proposal. An active administrator count alone is insufficient.
    - Keep the existing recipient rules, one Activity_Feed entry on approval, disabled explanation with fewer than two Administrators, and read/commit access checks; no override may rewrite protected personal wording.
    - _Requirements: 23.22, 23.23, 23.24, 47.7, 48.8, 48.9, 49.1, 49.2, 49.3, 49.4, 49.5, 49.6, 49.7, 49.8_
  - [ ] 54.6 Build the consent, hold, and approval screens in `apps/app/web/src/disclosure/` and `apps/app/web/src/reviews/`
    - The consent failure in the disclosure dialog with the offer to send Publication_Proposals, the Consenting_Member's proposal page with the preview, approve, decline, and withdraw; the hold panel on item pages with place, lift, and the proposal of a Hold_Override; the open Dual_Approvals list with approve, decline, and withdraw; and holds and approvals in item history
    - _Requirements: 23.17, 23.18, 23.19, 48.5, 48.8, 49.2, 49.6, 49.7_
  - [ ] 54.7 Write property test for publication consent
    - **Property 102: Publication follows the Consenting_Member's consent**
    - **Validates: Requirements 23.17, 23.18, 23.19, 23.20, 23.21, 23.22, 23.23, 23.24**
  - [ ] 54.8 Write property test for Confidentiality_Holds
    - **Property 103: Confidentiality_Holds block publication until lifted or overridden**
    - **Validates: Requirements 48.1, 48.2, 48.3, 48.4, 48.6, 48.7, 48.10**
  - [ ] 54.9 Write property test for Dual_Approvals
    - **Property 104: Dual_Approvals need two different active Administrators**
    - **Validates: Requirements 23.22, 47.7, 48.8, 48.9, 49.1, 49.3, 49.4, 49.5, 49.6, 49.8**

- [ ] 55. Build Research_Questions
  - [ ] 55.1 Add the Research_Question kind
    - The kind in `packages/domain` (kind names, Item_Identifier prefix, the zod schema with the limits of R50.1), the next migration adding `research_questions`, `question_groups`, `question_entries`, and `projects.question_order`, and rebuilding `research_items` because its `research_items_kind_values` check lists the kinds; and the fixed relation label Addresses, seeded as locked, not offered for ordinary Cross_Links, and refused by `validateLinks` in `apps/app/src/records/links.ts` for any link that is not a Question_Group entry
    - _Requirements: 50.1, 50.2, 50.8_
  - [ ] 55.2 Implement Research_Questions in `apps/app/src/records/kinds/question.ts`
    - Create and edit through the records pipeline: each entry stored as an Addresses Cross_Link with its group and position; targets must be live Research_Items or Attachments of the same Project, at most once per Research_Question; no Log_Summary required; invalid input saves nothing and names each invalid value
    - A shared helper `removeQuestionEntries(targets, reason)` that removes entries in the caller's batch and records the removal in each Research_Question's history, called by item moves (task 31.6), Attachment moves (task 53.1), and permanent deletion
    - _Requirements: 41.2, 50.1, 50.2, 50.6, 50.7_
  - [ ] 55.3 Build the Research_Question screens in `apps/app/web/src/items/question/`
    - The form with groups and entries (add, remove, and reorder with buttons as well as dragging) and the page with question, introduction, and groups, omitting entries the viewer cannot read
    - _Requirements: 50.1, 50.3_
  - [ ] 55.4 Render Research_Questions on the Public_Site in `packages/public-render` and `apps/app/src/publisher/plan.ts`
    - The question page at `/r/{Item_Identifier}` with each entry rendered like the other end of a Cross_Link and the introduction under Full_Content; the Project page's Research_Question part before the listings in `question_order`, then newest first; a `questions` listing; `PATCH /projects/{id}` accepting `question_order` from Administrators; re-rendering through Cross_Link neighbour expansion
    - _Requirements: 29.1, 50.4, 50.5_
  - [ ] 55.5 Write property test for Research_Questions
    - Exercise 55.4's rendering only once it exists; until then the test checks the Workspace invariants and the public assertions are added with 55.4
    - **Property 106: Research_Question entries are valid and follow their targets**
    - **Validates: Requirements 50.1, 50.2, 50.4, 50.5, 50.6, 50.7**

- [ ] 56. Build emailed Consent_Requests
  - [ ] 56.1 Add the consent request data
    - The next migration adds `external_parties.contact_email`, `consent_requests`, `consent_request_items`, `consent_answers`, `consent_withdrawals`, and the guard table `_g_consent_link_open`; add the code to `GUARD_CODES`; add the Permissions `consent.request` and `party.contact` for Administrators
    - Contact_Email on the External_Party form and API (at most 254 characters, local-part@domain), shown only to Members, with erasure that records the Administrator and time but not the value
    - _Requirements: 2.5, 51.1_
  - [ ] 56.2 Implement sending in `apps/app/src/consent/requests.ts`
    - `POST /consent-requests/preview` runs the checks of R51.3 and renders each unit's Consent_Page snapshot with `public-render` and the kernel under the proposed values (the Party's name as it would appear for publication requests; public fields and file name but never the file for rights requests), returning the email text, the snapshots, and a preview token
    - `POST /consent-requests` stores the request, the items with snapshots and SHA-256 digests, the token hash, and the expiry; sets Consent_Status Requested unless Granted; and queues the email through the `Mailer` against the Recipient_Cap; `GET /consent-requests` and `POST /consent-requests/{id}/cancel`
    - The email template in `packages/public-render/src/email/consent.ts` with the subject "ResearchForce: request for permission to publish", registered in `packages/testing/src/public-channels.ts`
    - _Requirements: 51.2, 51.3, 51.4, 51.11_
  - [ ] 56.3 Implement answering and withdrawal in `apps/submit/src/consent.ts` and `packages/db/src/consent/answer.ts`
    - `POST /v1/consent/view` and `POST /v1/consent/change/view` return the stored snapshot and options for a usable token and the one fixed "no longer valid" response otherwise, writing nothing; `POST /v1/consent/answer` and `POST /v1/consent/change` need a Turnstile token and pass the `Budget` gate
    - The shared batch builder: `consent_link_open` guard, answer or withdrawal rows, Consent_Status, Do_Not_Name and Generic_Label, and Rights_Status changes with Revisions attributed to the requesting Administrator and naming the answer, the downgrades of R33.5 and R34.3, Item_Update events, a `publish` outbox row, and the confirmation email with a Change_Link valid for 12 months
    - Register the `rf-submit` consent responses in `packages/testing/src/public-channels.ts` as an addressed channel
    - _Requirements: 51.5, 51.6, 51.7, 51.8, 51.10, 51.12, 51.14_
  - [ ] 56.4 Build the Consent_Page and Change_Link page in `apps/site-shell/src/consent.ts`
    - Static shells at `/consent` and `/consent/change` with `noindex` and no caching; the token from the URL fragment; the snapshot for each element with its answer options, a one-answer-for-all control, the optional Generic_Label and comment, Turnstile in managed mode, and the confirmation; the "no longer valid" notice with a link to the Outside_Submission_Form
    - _Requirements: 51.5, 51.6, 51.10, 51.12, 51.14_
  - [ ] 56.5 Limit emailed consent to the content shown
    - Consent_Statuses and Rights_Statuses set through a Consent_Answer record the answer item; `checkGates` and the records pipeline refuse a change for which `widens(snapshotView, after, unit)` holds with every ancestor treated as Public, naming the element and the answer and offering a new Consent_Request; manual and emailed grants both use exact Permission_Evidence coverage; a status edit alone grants nothing
    - _Requirements: 51.9_
  - [ ] 56.6 Implement reminders, expiry, and token clean-up in `apps/app/src/consent/sweep.ts`
    - The hourly sweep sends the one reminder at 14 days, marks requests expired at 30 days without changing any status, and deletes Consent_Link and Change_Link token hashes 30 days after expiry; update `retentionRows()` with the Contact_Email and Consent_Request rows; add the consent tables to the Internal_Backup table list of task 38.4, without token hashes
    - _Requirements: 46.19, 51.11, 51.13_
  - [ ] 56.7 Build the Consent_Request screens in `apps/app/web/src/consent/`
    - The request dialog from a Correspondence, Source, Attachment, or External_Party page (Party, kind, elements, proposed values, message) with the email and Consent_Page preview and confirmation; the request list with states; and requests, answers, comments, and withdrawals on the External_Party's page and each element's page
    - _Requirements: 51.2, 51.13_
  - [ ] 56.8 Write property test for consent links
    - **Property 107: Consent links record only explicit answers and change exactly what was asked**
    - **Validates: Requirements 51.3, 51.4, 51.5, 51.6, 51.7, 51.8, 51.10, 51.11, 51.12**
  - [ ] 56.9 Write property test for consent coverage
    - **Property 108: Emailed consent covers only what the person was shown**
    - **Validates: Requirements 51.9**
  - [ ] 56.10 Write integration tests for Consent_Requests
    - A scanner-style GET of the link changes nothing; an answer sets the statuses and sends the confirmation; a refusal on a Public Correspondence withholds it; an expired, cancelled, or used link gets the fixed notice; a withdrawal through the Change_Link downgrades and keeps Do_Not_Name on
    - _Requirements: 51.5, 51.8, 51.10, 51.12_

- [ ] 57. Repair acceptance gaps and add bounded, retry-safe foundations
  - Retain existing code; complete the reopened acceptance work rather than recreating historical migrations or discarding tested behavior.
  - [x] 57.1 Reconcile task status and acceptance evidence in `tools/check-specs.ts` and `docs/acceptance/`
    - Inventory every leaf task, requirement criterion, property, source/test path and known correction. Verify existing task 52 code/migration/read-path tests and record evidence before checking its subtasks; a file existing is not acceptance and an applied migration is not rerun.
    - Implement graph/coverage validators for the canonical dependency graph below and milestone gates; preserve IDs and record why a task is reopened. Identify older tests that must be extended for new fields/kinds.
    - _Requirements: 60.1, 60.3, 60.4_
    - Acceptance: `docs/acceptance/task-evidence.json` records source/test fingerprints and `docs/acceptance/checks/local-tests.json` records the passing synthetic suites; `npm run check:specs` is required by CI. Historical checkboxes remain explicitly unverified.
  - [x] 57.2 Implement the versioned Resource_Profile in `packages/domain/src/resource-profile.ts` and `tools/certify-profile.ts`
    - Expose and validate Operating_Profile, separate provider versus chosen CPU/call/statement/byte/memory limits, logical text/spans, preview budgets, growth and Abuse_Profile versions; update domain settings and installation examples without enabling a paid service.
    - Include maximum encoded text/span/Revision payloads and a single large section in acceptance fixtures; publish the certified boundary/transfer limits to browser clients and bounded server validators.
    - _Requirements: 4.10, 4.11, 11.10, 14.10, 28.1, 28.3, 28.4, 28.17, 60.7_
    - Acceptance: strict shared contracts, boundary/large-field fixtures, authenticated profile API/client, installation examples and local certification/growth reports are verified in `docs/acceptance/task-evidence.json`. Production runtime/abuse/recovery certification remains 48.3; no plan is activated.
  - [x] 57.3 Add immutable logical field versions and bounded text/span storage
    - Implement `packages/domain/src/text-fragments.ts`, the next additive DB migration for field_versions/text_fragments/manifests, and shared readers in the records/markdown/kernel adapters. Keep logical IDs, exact text and global offsets; cap fragments and encoded envelopes per Resource_Profile.
    - Move bulky previous values into immutable version references, migrate existing fields without losing revisions, make FTS/logical phrase matching and excerpts cross chunk boundaries, and support bounded public continuation output, history/compare, printers, citations, drafts and backup/export readers.
    - Use version/ref/read leases for retention; retain old readers during migration and prove compatibility before contraction. Task 19.1 integrates the reopened inside-section transport and atomic commit after this foundation.
    - _Requirements: 4.1, 4.4, 4.8, 4.10, 4.11, 11.8, 11.10, 21.1, 21.3, 21.4, 22.1, 22.3, 22.5, 45.13, 60.5_
    - Acceptance: immutable storage, retained history, resumable legacy migration, scoped/leased readers, logical search and bounded output helpers are verified in `docs/acceptance/task-evidence.json` and documented in `docs/storage/logical-fields.md`. Task 19.1 retains the staged transport/atomic-save cutover; 57.6 retains end-to-end property ownership.
  - [x] 57.4 Implement actor-scoped mutation idempotency and uncertain-result reconciliation
    - Add `idempotency_results` and logical external-effect operation IDs with request digests and recorded results in the same GuardedBatch as every mutation; replay identical requests, conflict changed bodies, protect status reads from other actors and retain content-free result tombstones.
    - Extend `ApiClient`, persistence and every mutating API route, including uploads, stages, membership and mail queuing, to store operation keys before sending, reconcile a lost response through `GET /operations/{key}`, and distinguish refused/committed/pending/unknown without duplicating results or external actions.
    - External API timeouts keep a visible uncertain state and reconcile provider operation IDs/status where available. Never label accepted mail as confirmed delivery or promise exactly-once recipient delivery.
    - _Requirements: 20.26, 28.10, 28.13, 60.2, 60.8_
  - [x] 57.5 Exercise actual public delivery channels in privacy tests
    - Change the public-channel registry/test adapters to exercise real production projection/delivery responses with generated canaries. Use dependency injection from workerd tests to reach rf-dl rather than certifying a constant refusal; preserve package boundaries.
    - Initially cover actual implemented current-access/refusal/header behavior; extend emitted public HTML/index/files/email/export/release snapshots and containment responses in their owning feature tasks. The final gate rejects a missing channel adapter or a stub refusal. New fields and kinds extend the same generator and channel matrix.
    - _Requirements: 14.6, 24.5, 24.6, 24.7, 25.5, 25.6, 60.1, 60.4_
  - [ ] 57.6 Write property and regression tests for logical field fragments
    - Use independent models and fault injection in `apps/app/test/properties/p109-text-fragments.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 109: Logical text fragments preserve valid fields across storage and history**
    - **Validates: Requirements 4.10, 4.11, 11.10**
  - [ ] 57.7 Write property and regression tests for mutation retries and lost responses
    - Use independent models and fault injection in `apps/app/test/properties/p110-idempotent-mutations.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 110: Mutation retries preserve a single logical result**
    - **Validates: Requirements 28.10, 28.13, 60.2**
  - [ ] 57.8 Add browser regressions for the reopened file and large-text workflows
    - After 19.1 and 30.6–30.8, test reload with retained file metadata/upload IDs, expired upload and matching reselection, independent file retry/removal, keyboard blocking, bounded CSV stream cancellation/oversized quoted rows, and listing versus opening/download flags.
    - Keep the local R2 checksum/multipart cases and make the real R2/CORS rehearsal mandatory in 48.5; run the old item/history/search suites through the new field readers.
    - _Requirements: 4.10, 4.11, 12.7, 12.11, 14.4, 14.10, 18.13, 28.10, 60.4, 60.9_

- [ ] 58. Establish independent encrypted recovery and fault-safe restore
  - [ ] 58.1 Define versioned authenticated backup formats and encryption adapters
    - Implement the bounded codec/manifest interfaces in `packages/manifest/src/backup/`, a schema/table inventory registry and compatibility transforms, with authenticated root manifests, exact field/file hashes/counts and external trust fingerprints.
    - Select and pin a maintained implementation of a reviewed streaming authenticated-encryption format in an interoperability spike before freezing format v1; run independent decrypt/read vectors, browser/workerd/CLI memory tests and corruption tests. Do not invent a cryptographic protocol.
    - Define independent recovery custodian/key wrapping, rotation and restoration identifiers; document key custody outside production and forbid secrets in packages/logs. Current and two preceding released schema readers are supported where those releases exist.
    - _Requirements: 36.1, 36.8, 36.13, 36.16, 60.5_
  - [ ] 58.2 Implement automatic independent copies, verification and tiered retention
    - Add scheduled snapshots at least every 12 hours, authenticated encrypted transfer to an operator-configured independent account/destination, and an operator-run offline transfer option; only independent inventory plus decryption/integrity verification counts as an RPO point.
    - Keep 14 daily/8 weekly/12 monthly complete points with successor verification before expiry. Track the 18-hour warning and 24-hour RPO breach through independent alerts; include copies/transient data in the storage/spend model. Requested staging expiry remains seven days.
    - Require explicit destination, budget and recovery-key configuration plus an initial fresh restore before sole-copy research custody. Persist minimal authenticated suppression generations independently, with no deleted bodies.
    - _Requirements: 28.4, 28.8, 36.3, 36.7, 36.12, 36.13, 36.16, 60.6, 60.7_
  - [ ] 58.3 Implement leased freeze, watchdog and file retention pins
    - Add job-owned monotonic freeze/read leases and shared write predicates; renew a 30-second lease within 10 seconds and enforce the 120-second certified snapshot window. Inventory and retrofit API, cron, raw SQL, job and outbox writes so none bypass the live lease. Permit only the owning renewal/control/checkpoint exception and prove it cannot alter snapshotted research rows.
    - Mark a lost/overrun snapshot incomplete, release writers safely, and provide an independently authenticated recovery command with a reason/audit trail. Pin needed immutable files until copied or explicitly invalidate the snapshot for a higher-priority privacy deletion.
    - Inject crashes, missed heartbeats, quota exhaustion, failed R2 writes and deletion races after every snapshot page; no stale generation can claim completion.
    - _Requirements: 28.10, 36.6, 36.14, 60.2, 60.6_
  - [ ] 58.4 Implement restore preflight, bootstrap reconciliation and owned checkpoints
    - Build the codec/version/reference/hash/count preflight and current/two-prior schema transforms for task 38.5. Match the verified bootstrap Administrator to the intended backed-up Member identity before research insertion; reject conflicting email/ID mappings.
    - Checkpoint restore-owned canonical row hashes and insert-or-verify rather than insert-or-ignore; report conflicting destinations and unexpected duplicates. Quarantine restored data until validation and independently known suppressions pass, with no notification or external-send replay.
    - _Requirements: 36.4, 36.5, 36.8, 36.9, 36.10, 36.15, 36.16, 60.5_
  - [ ] 58.5 Write fresh-environment recovery tooling and rehearse RPO/RTO
    - Implement `tools/recovery/rehearse.ts` and the operator runbook using independent inventory, keys and replacement infrastructure; exercise loss of the production account, older format, different bootstrap ID with the same email, corruption, every checkpoint interruption, and a post-snapshot withdrawal.
    - Record sanitized manifests/counts/hashes, independent-copy age, elapsed restore time and failures against <=24-hour RPO/<=8-hour Reference_Archive RTO. Schedule quarterly and pre-breaking-change rehearsals; neither a package download nor an application-only alert is acceptance.
    - _Requirements: 36.12, 36.13, 36.15, 36.16, 36.17, 60.4, 60.6, 60.9_
  - [ ] 58.6 Write property and regression tests for independent recovery points
    - Use independent models and fault injection in `apps/app/test/properties/p111-independent-recovery.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 111: Independent recovery points satisfy retention and verification**
    - **Validates: Requirements 36.3, 36.7, 36.12, 36.13, 36.17**
  - [ ] 58.7 Write property and regression tests for freeze and restore crash safety
    - Use independent models and fault injection in `apps/app/test/properties/p112-freeze-restore.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 112: Freeze and restore recovery never accepts mixed state**
    - **Validates: Requirements 36.8, 36.14, 36.15, 36.16, 60.5**

- [ ] 59. Certify publication epochs, containment and bounded public abuse
  - [ ] 59.1 Implement durable publication epochs and fenced external operations
    - Increment the public invalidation epoch in the originating transaction; add job/deploy/file operation identities, generation guards, urgent preemption and rf-ops serialized expected-epoch checks used by tasks 32.1–32.5.
    - A late provider response or old retry cannot restore a suppressed file, promote stale assets unchecked, or reopen containment. Reconcile ambiguous version promotion against actual provider state and keep denial until the latest authorized generation verifies.
    - _Requirements: 24.11, 24.16, 24.17, 25.3, 30.7, 60.2, 60.6_
  - [ ] 59.2 Prepare independent edge containment and health/incident handling
    - Implement narrow rf-ops control methods, precreated public-host deny rules, an independently recoverable operator credential/runbook and out-of-band verification/alert adapters. Confirm actual plan capabilities; inability to provide required denial blocks public launch.
    - At four minutes unverified removal, initiate denial on public research hosts while leaving app available; verify by five minutes where provider controls are available. If neither removal nor denial is possible, report an unconfirmed confidentiality incident, not success. A reset/retry cannot clear active containment.
    - _Requirements: 24.16, 24.17, 28.6, 60.4, 60.6_
  - [ ] 59.3 Implement profile-aware admission, rejected-traffic accounting and shedding
    - Distinguish admitted public work, charged rejected/invalid-download invocations and provider/account totals; reserve bounded in-flight D1/work capacity before admission and settle actual use. Edge controls and profile headroom must include distributed syntactically valid but invalid-signature download tokens.
    - Keep static public search independent of optional API-budget status; dynamic forms and addressed views have separate admission. Retain the Member/removal reserve without representing an in-Worker check as preventing the invocation charge; do not auto-upgrade services.
    - _Requirements: 28.1, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.11, 28.17, 60.7_
  - [ ] 59.4 Write mandatory distributed abuse and removal-failure staging scenarios
    - Certify the initial 100 requests/second, 1,000-source, 30-minute distributed flood with ten Members saving/downloading and a hold during a long addition run. Measure the declared reserve, >=99.9% authorized interactive success and removal/containment under available control paths.
    - Inject provider outage, exhausted quotas, false HEAD results, stale job and late deploy response; prove fixed denial has no canaries and cannot block the app. A failed Free_Qualified profile disables that scope until an approved stronger profile/isolation passes.
    - _Requirements: 24.16, 24.17, 28.5, 28.6, 28.7, 28.17, 60.4, 60.7_
  - [ ] 59.5 Write property and regression tests for publication generations and suppression
    - Use independent models and fault injection in `apps/app/test/properties/p113-publication-epochs.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 113: Publication generations never reintroduce suppressed material**
    - **Validates: Requirements 24.16, 24.17, 59.3, 60.6**
  - [ ] 59.6 Write property and regression tests for certified reserve accounting
    - Use independent models and fault injection in `apps/app/test/properties/p114-certified-admission.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 114: Admission and shedding preserve the certified reserve**
    - **Validates: Requirements 28.1, 28.3, 28.4, 28.5, 28.6, 28.7, 28.8, 28.11, 28.17, 60.7**

- [ ] 60. Build work coordination and the Research_Question lifecycle
  - [ ] 60.1 Add Work_Item and Question lifecycle schemas, storage and Permissions
    - Add Work_Item kind throughout domain names/schemas, Research_Item kind checks, identifiers, adapters, kernel input/views, filters and export formats; add work_items/assignees/dependencies/outcomes and Question lead/state/assessment/uncertainty/next-action storage with bounded logical fields.
    - Add work.assign/edit/progress/accept permissions with own/authorized-editor versus responsible/accepted-assignee versus self scopes. Keep ownership, Log_Summary and access widening separate; assignees and Question leads must currently Can_Read. Migrate built-in and configurable Role behavior deliberately.
    - Work_Item initial Log_Summary is optional, like a Topic; acceptance of progress never edits another Owner's summary. Bulk_Import v1 rejects interactive Work_Item/Decision_Record kinds with a clear error until a versioned mapper exists.
    - _Requirements: 2.4, 2.5, 2.15, 41.2, 50.9, 52.1, 52.2, 60.1_
  - [ ] 60.2 Implement work assignment, dependencies and outcome APIs
    - Implement the design route/state contracts with idempotency, current-access guards, explicit self acceptance/decline and transactional graph-cycle protection; validate all bounds and names on every edit.
    - Done requires result versions or a no-result statement; cancel/reopen needs a reason. Record actor-specific history, due dates, blockers and deduplicated assignment/change notifications without leaking inaccessible context.
    - _Requirements: 52.1, 52.2, 52.3, 52.4, 52.6, 60.2_
  - [ ] 60.3 Implement versioned Question assessments and investigation state
    - Extend the Question adapter with lead, Open/Investigating/Answered/Parked transitions, assessment versions, evidence and uncertainty/next-action links. Answered requires evidence and non-blank assessment; reopen/park retains the previous conclusion and reason.
    - Reuse ordinary edit/consent/history rules, keep assessment under Full_Content publicly, and render only readable context on Workspace pages. Lead/responsibility never changes Owner or ACL.
    - _Requirements: 50.9, 50.10, 50.11, 60.1_
  - [ ] 60.4 Build work and Question screens and integrated record/search/export views
    - Build assignment acceptance/progress, dependency editing, due/blocked/outcome views and Question assessment/evidence screens. Add conjunction-filtered lossless /work lists; listing relationship metadata does not clear target flags.
    - Integrate new kinds/fields with common renderers, Activity_Feed/Project_Log, notifications, search canaries, backups/restores and permitted public exports; explicitly test hidden endpoints and assignee permission loss.
    - _Requirements: 50.11, 52.5, 52.6, 60.1, 60.9_
  - [ ] 60.5 Write property and regression tests for work coordination
    - Use independent models and fault injection in `apps/app/test/properties/p115-work-coordination.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 115: Work transitions retain explicit assignments and outcomes**
    - **Validates: Requirements 52.1, 52.2, 52.3, 52.4, 52.5, 52.6**
  - [ ] 60.6 Write property and regression tests for Question assessments
    - Use independent models and fault injection in `apps/app/test/properties/p116-question-lifecycle.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 116: Question assessments retain versioned evidence and access**
    - **Validates: Requirements 50.9, 50.10, 50.11**

- [ ] 61. Build evidence-backed decisions and personal acknowledgements
  - [ ] 61.1 Add Decision_Record schemas, storage and actor-specific acknowledgement guards
    - Add Decision_Record kind, alternatives, selected/deferred outcome, rationale/context, participant and evidence-version rows, personal digest-bound acknowledgements, revisit and supersession fields; enforce all R53 bounds and rebuild enum checks compatibly.
    - Adoption uses existing authorized editing, personal responses use self-only permission and content digest; changed rationale/outcome makes older acknowledgements earlier-wording, never assumed agreement. Preserve existing summary/dissent/profile protections.
    - _Requirements: 2.15, 53.1, 53.2, 53.3, 60.1_
  - [ ] 61.2 Implement decision APIs, revisit reminders and public/private views
    - Implement propose/adopt/acknowledge/supersede/withdraw with atomic history, current-access checks, exact citations, participant notifications and revisit reminders. A missing response stays explicitly no response.
    - Build forms and decision pages, link Question/work context, keep superseded rationale and differences visible, and integrate search/log/export/backup/public canaries without publishing hidden participants or acknowledgements.
    - _Requirements: 53.2, 53.3, 53.4, 53.5, 60.1, 60.2, 60.9_
  - [ ] 61.3 Write property and regression tests for decision records
    - Use independent models and fault injection in `apps/app/test/properties/p117-decision-records.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 117: Decisions never infer another Member’s agreement**
    - **Validates: Requirements 53.1, 53.2, 53.3, 53.4, 53.5**

- [ ] 62. Build precise citations and original/derivative provenance
  - [ ] 62.1 Add source bibliography and version-bound citation models
    - Add document creators/roles separately from Owner/Credit, date precision, identifiers/archive references/edition/language/URL/access date; implement typed citation/locator schemas and exact field/file version references with bounds and immutable identities.
    - Validate UTF-16 text boundaries, page/folio/range order, normalized image regions and current access to both ends; source changes preserve the original reference and mark earlier-version citations. Legacy source strings stay unresolved unless explicitly mapped.
    - _Requirements: 54.1, 54.2, 54.3, 60.1_
  - [ ] 62.2 Integrate citation editing, labels, navigation and exports
    - Implement /citations and readable backlink queries with record edit permissions; extend RichText overlays/pickers to citation IDs while preserving legacy strings and exact text. Render locators in excerpts, history/print and record pages without leaking a hidden target or its counts.
    - Implement JSON and CSL-JSON bibliography interchange and unresolved-reference curation; add preview warnings for uncovered rights without treating a citation as permission, and integrate version retention/backup/restore/release readers.
    - _Requirements: 54.3, 54.4, 54.5, 54.6, 60.1_
  - [ ] 62.3 Implement artifact derivation DAGs and uncertainty/review
    - Add derivation input/output versions, kinds, method/tool, language, uncertainty and personal review rows; implement /derivations with both-end authorization and transactional graph epoch/cycle checks.
    - Preserve original hashes; corrections create new output versions. Store transcript/translation/OCR text explicitly for authorized search, distinguish record version from derivation relation, and handle moved/deleted targets with historical tombstones instead of repointing.
    - _Requirements: 55.1, 55.2, 55.3, 55.4_
  - [ ] 62.4 Build provenance screens and verify preservation/interchange
    - Show originals, derivative paths, method/uncertainty and independent reviews with per-endpoint access; add manuscript scan/transcription/translation walkthroughs and corrected-text comparisons.
    - Round-trip graph, exact text, identities, reviews and uncertain passages through backup/public release/export under their existing gates. Automatic OCR remains unprovisioned and outside this scope.
    - _Requirements: 55.3, 55.4, 55.5, 60.1, 60.9_
  - [ ] 62.5 Write property and regression tests for evidence citations
    - Use independent models and fault injection in `apps/app/test/properties/p118-evidence-citations.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 118: Evidence citations retain version identity and safe locators**
    - **Validates: Requirements 54.1, 54.2, 54.3, 54.4, 54.5, 54.6**
  - [ ] 62.6 Write property and regression tests for artifact derivations
    - Use independent models and fault injection in `apps/app/test/properties/p119-artifact-derivations.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 119: Artifact derivations preserve originals and an authorized DAG**
    - **Validates: Requirements 55.1, 55.2, 55.3, 55.4, 55.5**

- [ ] 63. Build reproducible compute packages and comparable scope coverage
  - [ ] 63.1 Implement versioned compute manifests and held/verified artifact identity
    - Add package versions and bounded artifact/configuration/environment/scope/reproduction tables and /runs/{id}/package. Validate exact code commit/release, commands, input/output/checkpoint hashes, seeds/dependencies and all package bounds without rounding counts.
    - Distinguish held/hash-verified from unverified external references and Incomplete/Specified/Reproduced/Disputed states; list missing ingredients. Parsing/import never executes code or fetches arbitrary external URLs.
    - _Requirements: 56.1, 56.2, 56.6, 60.1_
  - [ ] 63.2 Implement scope schemas, coverage comparison and independent reproduction
    - Implement versioned project scope schemas with exact integer/set/range semantics, attempted/completed/excluded/unknown states, cycle-free evidence references and conservative overlap/union for compatible verified completed scopes only.
    - Generic/incompatible scopes remain explicitly incomparable; Partial/Suspended/Stopped work never proves full elimination. Add independent reproduction as a separate attributed Run with environment differences and evidence, preserving the initial package/outcome.
    - _Requirements: 56.3, 56.4, 56.5_
  - [ ] 63.3 Build package/coverage screens and interoperability walkthroughs
    - Build forms, missing-ingredient/status displays, exact manifests and authorized coverage comparisons; integrate linked Questions/Findings, current access/disclosure, search, history, export and backup/release retention.
    - Reproduce a synthetic run from exported configuration and held inputs in an explicitly operated test harness; application code does not execute uploaded tools. Test secrets rejection and no inferred elimination from unmatched scope formats.
    - _Requirements: 56.1, 56.2, 56.4, 56.6, 60.1, 60.9_
  - [ ] 63.4 Write property and regression tests for compute reproducibility and coverage
    - Use independent models and fault injection in `apps/app/test/properties/p120-compute-packages.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 120: Compute coverage is exact only for compatible verified scopes**
    - **Validates: Requirements 56.1, 56.2, 56.3, 56.4, 56.5, 56.6**

- [ ] 64. Build durable drafts and authorized proposed edits
  - [ ] 64.1 Implement author-scoped durable draft storage and recovery
    - Add /drafts with target/base revision, exact field-version manifests, upload/group IDs, operation key, pin/last-save state and local fallback. Distinguish acknowledged durable content from unsaved local changes; normal reads are author-only with current target access.
    - Implement reasoned audited Administrator recovery, warned 83/90-day inactive expiry and pinned retention, encrypted backup visibility metadata and exclusion from public/search/notification/Submission output. File reselection revalidates identity rather than fabricating File objects.
    - _Requirements: 2.16, 28.10, 57.1, 57.2, 57.3, 60.1, 60.2, 60.8_
  - [ ] 64.2 Implement revision-bound proposed diffs and guarded acceptance
    - Implement edit proposal submit/rebase/withdraw/accept/decline with exact diff, explanation, evidence and immutable author/base identities. Current authorized field editors accept; a stale base requires explicit rebase/review and a forbidden field rejects the entire action.
    - Do not route disclosure/access/rights/consent/status changes through content proposals. Preserve another Member's Log_Summary/Profile/Dissent protections and personal acknowledgement ownership; record proposer separately from actual editor and deduplicate readable notifications.
    - _Requirements: 57.4, 57.5, 57.6, 60.1, 60.2_
  - [ ] 64.3 Build draft resumption and proposal review screens
    - Add save/resume/discard/pin draft controls and clear saved/local/unknown indicators; test closing/reopening tabs, permission loss and upload expiry while preserving metadata.
    - Build proposed-diff review, stale/conflict rebase, accept/decline/withdraw and attribution/history screens; a Contributor can suggest another record's edit but does not gain target editing or public disclosure rights.
    - _Requirements: 57.1, 57.2, 57.3, 57.4, 57.5, 57.6, 60.9_
  - [ ] 64.4 Write property and regression tests for durable drafts
    - Use independent models and fault injection in `apps/app/test/properties/p121-durable-drafts.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 121: Durable drafts recover acknowledged input with author isolation**
    - **Validates: Requirements 57.1, 57.2, 57.3**
  - [ ] 64.5 Write property and regression tests for proposed edits
    - Use independent models and fault injection in `apps/app/test/properties/p122-edit-proposals.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 122: Proposed edits apply only current authorized diffs**
    - **Validates: Requirements 57.4, 57.5, 57.6**

- [ ] 65. Build personal navigation and team work dashboards
  - [ ] 65.1 Implement personal bookmarks, saved queries, follows and recipient union
    - Add author-scoped bookmark/search/follow tables and /me endpoints with validated names/count limits and no stored result snapshots; rerun saved searches through current authorization and show only a neutral unavailable personal entry for a lost target.
    - Union follows with existing participation recipients before notification/email grouping; apply event preferences and Project muting without defeating existing mandatory policy-alert exceptions. Add migration-defined preferences for new event types; personal records appear only in encrypted backup/personal export.
    - _Requirements: 2.16, 58.2, 58.3, 58.4, 60.1_
  - [ ] 65.2 Build My_Work and authorized team dashboards
    - Provide assignment acceptance/due/blocked work, eligible reviews, archival follow-ups, proposals, followed Questions and durable drafts with lossless paging and Project/responsible/state filters.
    - Keep outstanding work separate from unseen flags; show no inaccessible context/counts and do not clear flags merely by listing results. Add bookmark/search management and saved-navigation access-loss walkthroughs.
    - _Requirements: 52.5, 58.1, 58.4, 58.5, 60.9_
  - [ ] 65.3 Write property and regression tests for navigation and follows
    - Use independent models and fault injection in `apps/app/test/properties/p123-personal-navigation.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 123: Navigation and follows preserve access and event uniqueness**
    - **Validates: Requirements 58.1, 58.2, 58.3, 58.4, 58.5**

- [ ] 66. Build citable research releases with current public suppression
  - [ ] 66.1 Define release schema, immutable manifests and exact citations
    - Add release identity/state/snapshot, scope/rationale/licence version, bounded artifact/citation/package/provenance/work/decision references and immutable authenticated manifest. Draft validation captures exact revisions/hashes and current permission evidence; backup inventory includes release data even before public release UI ships.
    - Separate internal sealed manifest from the approved public subset. Sealing requires complete validation and current approvals; changed contents produce a successor ID, and version-specific citations include release/revision/hash.
    - _Requirements: 59.1, 59.2, 59.4, 60.1_
  - [ ] 66.2 Implement release creation, validation and publication through the kernel
    - Implement /releases and export/snapshot sealing under operation keys and exact dependency guards; use normal preview/Owner/rights/hold/naming checks, not an independent publication bypass.
    - Index every public release file/page/citation for current suppression and epoch/containment; keep immutable originals internal when permitted, but remove currently disallowed historic output from static manifests and public copies within the normal SLO.
    - _Requirements: 24.16, 59.1, 59.2, 59.3, 59.5, 60.2_
  - [ ] 66.3 Build release and version-citation screens and offline export verification
    - Build create/preflight/seal/successor views and exact citation copy/export, with current withdrawn/superseded/unavailable behavior that reveals no hidden metadata. Offline HTML/JSON/CSL/package manifests must round-trip without executing code.
    - Document external repository/DOI deposit as a separate explicit operator action with permanent-copy implications; setup does not publish/deposit research. Exercise removal of an old public release after a later hold or permission withdrawal.
    - _Requirements: 59.3, 59.4, 59.5, 60.9_
  - [ ] 66.4 Write property and regression tests for research releases
    - Use independent models and fault injection in `apps/app/test/properties/p124-research-releases.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 124: Research releases preserve manifests and current suppression**
    - **Validates: Requirements 59.1, 59.2, 59.3, 59.4, 59.5**

- [ ] 67. Implement compatibility, independent operations and retention assurance
  - [x] 67.1 Implement compatible release manifests and upgrade/recovery tooling
    - Add versioned release/schema/backup compatibility declarations, expand/contract scripts, bounded backfill/checkpoints and rollback/forward-recovery checks; reject incompatible Worker/schema rollout combinations and unsupported backup readers.
    - Test current and two prior released schemas where available, seeded/bootstrap identity, stored field versions and indexes/triggers through upgrades, and restore rehearsal before any destructive contraction. Record the deployed versions and accepted recovery window.
    - _Requirements: 36.16, 60.3, 60.5_
    - Acceptance: compatibility/candidate manifests, preflight/recovery checks, local expand/backfill/contract scripts and seven seeded SQLite-copy upgrade rehearsals pass; source/test fingerprints and executed evidence are in `docs/acceptance/task-evidence.json`. Production deployment, authenticated backup readers and independent restore certification remain their downstream tasks.
  - [ ] 67.2 Implement independent health, recovery-age, removal and spend alerts
    - Prepare provider-native/independent external checks and operator-controlled notification delivery without rf-core or Graph queue dependence, plus credential-loss, identity outage, freeze/quota/failed-migration and containment runbooks.
    - Keep payloads free of research text, bearer links and recovery secrets, certify actual endpoint/control availability and document the separate trusted credential custody. Setup remains an explicit operator action.
    - _Requirements: 28.4, 36.7, 36.17, 60.6_
  - [ ] 67.3 Implement reference-safe operational retention and growth reporting
    - Expire reconciled outbox/side-effect payloads and closed checkpoints at 30 days and aggregate failure metadata at 90 days, retaining required immutable research history, exact-version refs/evidence, suppressed identifiers and content-free operation tombstones.
    - Integrate warned draft expiry and independently retained recovery suppression, report 1/3/5-year measured growth including all current/transient copies, and prove cleanup cannot remove a live citation, release, proposal or backup dependency.
    - _Requirements: 28.8, 28.17, 57.2, 60.7, 60.8_
  - [ ] 67.4 Write property and regression tests for release and compatibility gates
    - Use independent models and fault injection in `tools/test/properties/p125-release-assurance.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 125: Release gates and compatibility evidence cannot be bypassed**
    - **Validates: Requirements 60.1, 60.3, 60.4, 60.5, 60.6, 60.7, 60.8, 60.9**

- [ ] 68. Complete permission-evidence policy and mandatory release gates
  - [ ] 68.1 Add shared Permission_Evidence and manual/emailed grant coverage
    - Add immutable grant/evidence/source/document/version/hash/use/naming/authority/expiry/withdrawal rows and common coverage helpers. Legacy hand-set statuses become unverified legacy evidence pending curation; do not invent historical grants or silently publish uncovered material.
    - Provide exact snapshot coverage helpers for 54's Owner consents and dual eligibility, Withheld neutral-name fallback and existing Do_Not_Name precedence; changing a status does not grant unlimited rights. Extend backup/recovery/release schema readers and suppression indexes.
    - _Requirements: 23.23, 23.24, 49.8, 51.9, 51.15, 51.16, 51.17, 51.18, 60.1_
  - [ ] 68.2 Build evidence recording, precise permission requests and policy text
    - Build a manual evidence editor and curation queue with immutable evidence references, exact file/use/naming identity and expiry; provide shared preview/snapshot components with structured document identity and asserted authority for the later task 56 Consent_Request screens. A separately authorized feature is required to share file bytes externally.
    - Disclose verified residual Microsoft 365 retention in policy; make the explicit scoped bearer Download_Link exception visible to Members, preserve neutral withheld naming without a grant, and require configured content licence and recovery/provider inputs before their launch gates.
    - _Requirements: 1.3, 20.24, 51.9, 51.15, 51.16, 51.17, 51.18, 60.1_
  - [ ] 68.3 Write property and regression tests for permission evidence coverage
    - Use independent models and fault injection in `apps/app/test/properties/p126-permission-evidence.test.ts`; cover the concrete scenarios in the design, including current-access and maximum encoded-input cases. This owning property file does not replace browser/staging tests.
    - **Property 126: Permission evidence covers only the exact authorized use**
    - **Validates: Requirements 51.9, 51.15, 51.16, 51.17, 51.18, 23.23, 23.24, 49.8**
  - [ ] 68.4 Enforce team-archive and public-launch acceptance evidence
    - Implement gate manifests and checks for the mandatory R60.4 matrix; a source file, checked box or unit-only result is not substitute evidence. Team archive requires independent encrypted recovery/fresh restore, exact privacy, drafts/files, text, concurrency/lost-response and keyboard/capacity checks.
    - Public launch additionally requires real rights/consent/holds/dual approvals, public-channel canaries, browser file safety, presentation/accessibility, static index/removal/containment, provider setup and the distributed Abuse_Profile. Missing licence, independent keys/destination, profile approval or failed control paths block that scope.
    - Run and record the R60.9 local synthetic team walkthroughs, and wire protected real import/staging rehearsals into setup tasks 48.6–48.9; they must supply passing evidence before custodial use/public launch. Retain failure reports and explicit remediation tasks. The final checkpoint cannot skip any required acceptance suite.
    - _Requirements: 28.17, 36.12, 36.17, 60.1, 60.3, 60.4, 60.5, 60.6, 60.7, 60.9_

## Notes

- Every specified test sub-task is required for its associated scope; there is no optional-MVP skip marker. Team-archive and public-launch gates require the complete evidence matrix of R60.4, including independent recovery, real public-channel/browser security, accessibility, concurrency, migration and measured provider/performance cases. A pure property test never substitutes for an infrastructure acceptance check.
- Each of the 126 correctness properties has exactly one property-based test sub-task. Each owning property file may contain multiple independently modeled cases; separate regression/browser/staging tests remain required. Each property test lives in its own file, `test/properties/pNN-<slug>.test.ts` inside the package or app under test, runs at least 100 fast-check iterations, and starts with the tag comment `// Feature: research-collab-cms, Property N: <title>`.
- A property that spans several features is placed after the last code it exercises in the canonical graph. Cross-feature browser/staging suites run again after all affected modules exist; creating a test harness alone does not satisfy a release gate. Property 5 is the exception: its test (task 6.6) checks every channel in `packages/testing/src/public-channels.ts`, and tasks 9.5, 10.1, 27.1, 30.5, 34.4, and 38.1 register their channels there, so the confinement test covers each public channel as soon as it exists.
- All tests run in single-run mode with `vitest --run` (`npm test`); no test starts a watcher or a development server. Task 50 adds `npm run dev` for running the Workspace locally by hand.
- Tests and fixtures use synthetic data. The existing journal and its attachments are never copied into the repository; task 7.10 and checklist 48.9 read them from paths the user gives, and the import creates every unit Not_Published and Unclassified.
- The canonical graph below replaces the obsolete appended historical waves. It covers each leaf task once, distinguishes the checked baseline from remaining work, and orders the remaining work through explicit predecessor wave barriers. The milestone narrative is checked against these groups; named helper dependencies such as 55.2 before 31.6/53.1 remain mandatory.
- Several tasks write the same shared files: `apps/app/src/api/app.ts` (route registration), `apps/app/src/index.ts` (Durable Object exports), `apps/app/src/cron.ts`, `apps/app/src/records/pipeline.ts`, `apps/app/src/notifications/fanout.ts`, `apps/app/web/src/routes.tsx`, `apps/ops/src/index.ts`, and `packages/testing/src/public-channels.ts`. The canonical remaining-work waves are serial; helpers and shared-file integrations complete before their callers. This is a safe scheduling order, not an instruction to spawn agents.
- Sub-tasks 48.6–48.9 and 48.11–48.12 are setup/acceptance checklists that need the user's Cloudflare, Microsoft 365, DNS, or deployment access. The agent completes the scripts, gate tooling and runnable suites first. Obtain only missing account inputs/actions at the scheduled setup phase; reuse access and authorization already supplied. Record actual setup/test results before production activation.
- Installation inputs and remaining open policy questions are explicit gate dependencies. Resolved review decisions are normative, not hidden provisional constants; a policy change updates requirements, design, tests and task evidence together.
- Each task references the requirement criteria it implements; checkpoints run the whole suite at the end of each phase.

## Task Dependency Graph

This is the canonical scheduling and gate manifest. Phase names match the milestone table above. The inherited baseline is audited, and every remaining leaf has an explicit predecessor barrier. Setup is separated from provider verification and production activation to avoid circular dependencies. Public and outside features remain denied until their gates pass.

```json
{
  "schemaVersion": 2,
  "semantics": {
    "completedBaseline": "Inherited checked leaf tasks; task 57.1 reconciles evidence. This is not release acceptance.",
    "waveDependencies": "Every wave requires all predecessor waves. One remaining leaf per wave avoids shared-file races.",
    "helperEdges": "Additional explicit prerequisite edges [before, after]; serial barriers preserve these too.",
    "gates": "Runtime evidence gates are evaluated by 68.4 using the completed staging evidence. Code completion alone does not pass a gate."
  },
  "completedBaseline": [
    "1.1",
    "1.2",
    "1.3",
    "1.4",
    "2.1",
    "2.2",
    "2.3",
    "2.4",
    "2.5",
    "2.6",
    "3.1",
    "3.2",
    "3.3",
    "3.4",
    "3.5",
    "3.6",
    "3.7",
    "3.8",
    "3.9",
    "3.10",
    "4.1",
    "4.2",
    "4.3",
    "4.4",
    "5.1",
    "5.2",
    "5.3",
    "5.4",
    "5.5",
    "5.6",
    "5.7",
    "5.8",
    "6.1",
    "6.2",
    "6.3",
    "6.4",
    "6.5",
    "6.6",
    "6.7",
    "7.1",
    "7.2",
    "7.3",
    "7.4",
    "7.5",
    "7.6",
    "7.7",
    "7.8",
    "7.9",
    "7.10",
    "8.1",
    "8.2",
    "8.3",
    "8.4",
    "8.5",
    "8.6",
    "8.7",
    "9.1",
    "9.2",
    "9.3",
    "9.4",
    "9.5",
    "9.6",
    "9.7",
    "9.8",
    "9.9",
    "10.1",
    "10.2",
    "10.3",
    "10.4",
    "10.5",
    "11.1",
    "11.2",
    "11.3",
    "11.4",
    "11.5",
    "11.6",
    "13.1",
    "13.2",
    "13.3",
    "13.4",
    "13.5",
    "13.6",
    "14.1",
    "14.2",
    "14.3",
    "14.4",
    "14.5",
    "14.6",
    "14.7",
    "15.1",
    "15.2",
    "15.3",
    "16.1",
    "16.2",
    "16.3",
    "16.4",
    "17.1",
    "17.2",
    "17.3",
    "17.4",
    "17.5",
    "18.1",
    "18.2",
    "18.3",
    "18.4",
    "18.5",
    "18.6",
    "18.7",
    "18.8",
    "18.9",
    "18.10",
    "19.2",
    "19.3",
    "20.1",
    "20.2",
    "20.3",
    "20.4",
    "21.1",
    "21.2",
    "21.3",
    "21.4",
    "21.5",
    "21.6",
    "21.7",
    "23.1",
    "23.2",
    "23.3",
    "23.4",
    "23.5",
    "23.6",
    "23.7",
    "23.8",
    "23.9",
    "23.10",
    "24.1",
    "24.2",
    "24.3",
    "24.4",
    "24.5",
    "25.1",
    "25.2",
    "25.3",
    "25.4",
    "25.5",
    "25.6",
    "25.7",
    "25.8",
    "25.9",
    "25.10",
    "26.1",
    "26.2",
    "26.3",
    "26.4",
    "26.5",
    "26.6",
    "26.7",
    "27.1",
    "27.2",
    "27.3",
    "27.4",
    "27.5",
    "27.6",
    "27.7",
    "27.8",
    "27.9",
    "27.10",
    "27.11",
    "28.1",
    "28.2",
    "28.3",
    "28.4",
    "28.5",
    "30.1",
    "30.2",
    "30.3",
    "30.4",
    "30.5",
    "30.9",
    "30.10",
    "30.12",
    "51.1",
    "51.2",
    "52.1",
    "52.2",
    "52.3",
    "52.7",
    "52.8",
    "57.1",
    "50.1",
    "50.2",
    "50.3",
    "57.2",
    "67.1",
    "57.3",
    "19.1",
    "57.4",
    "57.5"
  ],
  "phases": {
    "repair": {
      "firstWave": 0,
      "lastWave": 6
    },
    "collaboration": {
      "firstWave": 7,
      "lastWave": 37
    },
    "privacy": {
      "firstWave": 38,
      "lastWave": 61
    },
    "imports_and_log": {
      "firstWave": 62,
      "lastWave": 85
    },
    "publication": {
      "firstWave": 86,
      "lastWave": 103
    },
    "outside_and_ai": {
      "firstWave": 104,
      "lastWave": 151
    },
    "recovery": {
      "firstWave": 152,
      "lastWave": 169
    },
    "release_tooling": {
      "firstWave": 170,
      "lastWave": 199
    },
    "staging_and_acceptance": {
      "firstWave": 200,
      "lastWave": 207
    },
    "production_activation": {
      "firstWave": 208,
      "lastWave": 208
    }
  },
  "waves": [
    {"id": 0, "phase": "repair", "dependsOn": [], "tasks": ["30.6"]},
    {"id": 1, "phase": "repair", "dependsOn": [0], "tasks": ["30.7"]},
    {"id": 2, "phase": "repair", "dependsOn": [1], "tasks": ["30.8"]},
    {"id": 3, "phase": "repair", "dependsOn": [2], "tasks": ["30.11"]},
    {"id": 4, "phase": "repair", "dependsOn": [3], "tasks": ["57.6"]},
    {"id": 5, "phase": "repair", "dependsOn": [4], "tasks": ["57.7"]},
    {"id": 6, "phase": "repair", "dependsOn": [5], "tasks": ["57.8"]},
    {"id": 7, "phase": "collaboration", "dependsOn": [6], "tasks": ["55.1"]},
    {"id": 8, "phase": "collaboration", "dependsOn": [7], "tasks": ["55.2"]},
    {"id": 9, "phase": "collaboration", "dependsOn": [8], "tasks": ["55.3"]},
    {"id": 10, "phase": "collaboration", "dependsOn": [9], "tasks": ["62.1"]},
    {"id": 11, "phase": "collaboration", "dependsOn": [10], "tasks": ["61.1"]},
    {"id": 12, "phase": "collaboration", "dependsOn": [11], "tasks": ["66.1"]},
    {"id": 13, "phase": "collaboration", "dependsOn": [12], "tasks": ["60.1"]},
    {"id": 14, "phase": "collaboration", "dependsOn": [13], "tasks": ["60.2"]},
    {"id": 15, "phase": "collaboration", "dependsOn": [14], "tasks": ["60.3"]},
    {"id": 16, "phase": "collaboration", "dependsOn": [15], "tasks": ["60.4"]},
    {"id": 17, "phase": "collaboration", "dependsOn": [16], "tasks": ["60.5"]},
    {"id": 18, "phase": "collaboration", "dependsOn": [17], "tasks": ["60.6"]},
    {"id": 19, "phase": "collaboration", "dependsOn": [18], "tasks": ["62.2"]},
    {"id": 20, "phase": "collaboration", "dependsOn": [19], "tasks": ["62.3"]},
    {"id": 21, "phase": "collaboration", "dependsOn": [20], "tasks": ["62.4"]},
    {"id": 22, "phase": "collaboration", "dependsOn": [21], "tasks": ["62.5"]},
    {"id": 23, "phase": "collaboration", "dependsOn": [22], "tasks": ["62.6"]},
    {"id": 24, "phase": "collaboration", "dependsOn": [23], "tasks": ["61.2"]},
    {"id": 25, "phase": "collaboration", "dependsOn": [24], "tasks": ["61.3"]},
    {"id": 26, "phase": "collaboration", "dependsOn": [25], "tasks": ["63.1"]},
    {"id": 27, "phase": "collaboration", "dependsOn": [26], "tasks": ["63.2"]},
    {"id": 28, "phase": "collaboration", "dependsOn": [27], "tasks": ["63.3"]},
    {"id": 29, "phase": "collaboration", "dependsOn": [28], "tasks": ["63.4"]},
    {"id": 30, "phase": "collaboration", "dependsOn": [29], "tasks": ["64.1"]},
    {"id": 31, "phase": "collaboration", "dependsOn": [30], "tasks": ["64.2"]},
    {"id": 32, "phase": "collaboration", "dependsOn": [31], "tasks": ["64.3"]},
    {"id": 33, "phase": "collaboration", "dependsOn": [32], "tasks": ["64.4"]},
    {"id": 34, "phase": "collaboration", "dependsOn": [33], "tasks": ["64.5"]},
    {"id": 35, "phase": "collaboration", "dependsOn": [34], "tasks": ["65.1"]},
    {"id": 36, "phase": "collaboration", "dependsOn": [35], "tasks": ["65.2"]},
    {"id": 37, "phase": "collaboration", "dependsOn": [36], "tasks": ["65.3"]},
    {"id": 38, "phase": "privacy", "dependsOn": [37], "tasks": ["54.1"]},
    {"id": 39, "phase": "privacy", "dependsOn": [38], "tasks": ["68.1"]},
    {"id": 40, "phase": "privacy", "dependsOn": [39], "tasks": ["31.1"]},
    {"id": 41, "phase": "privacy", "dependsOn": [40], "tasks": ["54.2"]},
    {"id": 42, "phase": "privacy", "dependsOn": [41], "tasks": ["52.5"]},
    {"id": 43, "phase": "privacy", "dependsOn": [42], "tasks": ["31.2"]},
    {"id": 44, "phase": "privacy", "dependsOn": [43], "tasks": ["31.3"]},
    {"id": 45, "phase": "privacy", "dependsOn": [44], "tasks": ["54.3"]},
    {"id": 46, "phase": "privacy", "dependsOn": [45], "tasks": ["54.4"]},
    {"id": 47, "phase": "privacy", "dependsOn": [46], "tasks": ["54.5"]},
    {"id": 48, "phase": "privacy", "dependsOn": [47], "tasks": ["52.4"]},
    {"id": 49, "phase": "privacy", "dependsOn": [48], "tasks": ["54.6"]},
    {"id": 50, "phase": "privacy", "dependsOn": [49], "tasks": ["54.7"]},
    {"id": 51, "phase": "privacy", "dependsOn": [50], "tasks": ["54.8"]},
    {"id": 52, "phase": "privacy", "dependsOn": [51], "tasks": ["54.9"]},
    {"id": 53, "phase": "privacy", "dependsOn": [52], "tasks": ["31.4"]},
    {"id": 54, "phase": "privacy", "dependsOn": [53], "tasks": ["31.5"]},
    {"id": 55, "phase": "privacy", "dependsOn": [54], "tasks": ["31.6"]},
    {"id": 56, "phase": "privacy", "dependsOn": [55], "tasks": ["31.7"]},
    {"id": 57, "phase": "privacy", "dependsOn": [56], "tasks": ["68.2"]},
    {"id": 58, "phase": "privacy", "dependsOn": [57], "tasks": ["68.3"]},
    {"id": 59, "phase": "privacy", "dependsOn": [58], "tasks": ["53.1"]},
    {"id": 60, "phase": "privacy", "dependsOn": [59], "tasks": ["53.2"]},
    {"id": 61, "phase": "privacy", "dependsOn": [60], "tasks": ["53.3"]},
    {"id": 62, "phase": "imports_and_log", "dependsOn": [61], "tasks": ["36.1"]},
    {"id": 63, "phase": "imports_and_log", "dependsOn": [62], "tasks": ["36.2"]},
    {"id": 64, "phase": "imports_and_log", "dependsOn": [63], "tasks": ["36.3"]},
    {"id": 65, "phase": "imports_and_log", "dependsOn": [64], "tasks": ["36.4"]},
    {"id": 66, "phase": "imports_and_log", "dependsOn": [65], "tasks": ["37.1"]},
    {"id": 67, "phase": "imports_and_log", "dependsOn": [66], "tasks": ["37.2"]},
    {"id": 68, "phase": "imports_and_log", "dependsOn": [67], "tasks": ["37.3"]},
    {"id": 69, "phase": "imports_and_log", "dependsOn": [68], "tasks": ["37.4"]},
    {"id": 70, "phase": "imports_and_log", "dependsOn": [69], "tasks": ["37.5"]},
    {"id": 71, "phase": "imports_and_log", "dependsOn": [70], "tasks": ["37.6"]},
    {"id": 72, "phase": "imports_and_log", "dependsOn": [71], "tasks": ["37.7"]},
    {"id": 73, "phase": "imports_and_log", "dependsOn": [72], "tasks": ["37.8"]},
    {"id": 74, "phase": "imports_and_log", "dependsOn": [73], "tasks": ["37.9"]},
    {"id": 75, "phase": "imports_and_log", "dependsOn": [74], "tasks": ["37.10"]},
    {"id": 76, "phase": "imports_and_log", "dependsOn": [75], "tasks": ["37.11"]},
    {"id": 77, "phase": "imports_and_log", "dependsOn": [76], "tasks": ["40.1"]},
    {"id": 78, "phase": "imports_and_log", "dependsOn": [77], "tasks": ["40.2"]},
    {"id": 79, "phase": "imports_and_log", "dependsOn": [78], "tasks": ["40.3"]},
    {"id": 80, "phase": "imports_and_log", "dependsOn": [79], "tasks": ["52.6"]},
    {"id": 81, "phase": "imports_and_log", "dependsOn": [80], "tasks": ["40.4"]},
    {"id": 82, "phase": "imports_and_log", "dependsOn": [81], "tasks": ["40.5"]},
    {"id": 83, "phase": "imports_and_log", "dependsOn": [82], "tasks": ["41.1"]},
    {"id": 84, "phase": "imports_and_log", "dependsOn": [83], "tasks": ["41.2"]},
    {"id": 85, "phase": "imports_and_log", "dependsOn": [84], "tasks": ["41.3"]},
    {"id": 86, "phase": "publication", "dependsOn": [85], "tasks": ["59.1"]},
    {"id": 87, "phase": "publication", "dependsOn": [86], "tasks": ["59.2"]},
    {"id": 88, "phase": "publication", "dependsOn": [87], "tasks": ["59.3"]},
    {"id": 89, "phase": "publication", "dependsOn": [88], "tasks": ["32.1"]},
    {"id": 90, "phase": "publication", "dependsOn": [89], "tasks": ["32.2"]},
    {"id": 91, "phase": "publication", "dependsOn": [90], "tasks": ["32.3"]},
    {"id": 92, "phase": "publication", "dependsOn": [91], "tasks": ["32.4"]},
    {"id": 93, "phase": "publication", "dependsOn": [92], "tasks": ["32.5"]},
    {"id": 94, "phase": "publication", "dependsOn": [93], "tasks": ["32.6"]},
    {"id": 95, "phase": "publication", "dependsOn": [94], "tasks": ["32.7"]},
    {"id": 96, "phase": "publication", "dependsOn": [95], "tasks": ["55.4"]},
    {"id": 97, "phase": "publication", "dependsOn": [96], "tasks": ["55.5"]},
    {"id": 98, "phase": "publication", "dependsOn": [97], "tasks": ["66.2"]},
    {"id": 99, "phase": "publication", "dependsOn": [98], "tasks": ["66.3"]},
    {"id": 100, "phase": "publication", "dependsOn": [99], "tasks": ["66.4"]},
    {"id": 101, "phase": "publication", "dependsOn": [100], "tasks": ["38.3"]},
    {"id": 102, "phase": "publication", "dependsOn": [101], "tasks": ["38.1"]},
    {"id": 103, "phase": "publication", "dependsOn": [102], "tasks": ["38.2"]},
    {"id": 104, "phase": "outside_and_ai", "dependsOn": [103], "tasks": ["34.1"]},
    {"id": 105, "phase": "outside_and_ai", "dependsOn": [104], "tasks": ["34.2"]},
    {"id": 106, "phase": "outside_and_ai", "dependsOn": [105], "tasks": ["34.3"]},
    {"id": 107, "phase": "outside_and_ai", "dependsOn": [106], "tasks": ["34.4"]},
    {"id": 108, "phase": "outside_and_ai", "dependsOn": [107], "tasks": ["34.5"]},
    {"id": 109, "phase": "outside_and_ai", "dependsOn": [108], "tasks": ["34.6"]},
    {"id": 110, "phase": "outside_and_ai", "dependsOn": [109], "tasks": ["35.1"]},
    {"id": 111, "phase": "outside_and_ai", "dependsOn": [110], "tasks": ["35.2"]},
    {"id": 112, "phase": "outside_and_ai", "dependsOn": [111], "tasks": ["35.3"]},
    {"id": 113, "phase": "outside_and_ai", "dependsOn": [112], "tasks": ["35.4"]},
    {"id": 114, "phase": "outside_and_ai", "dependsOn": [113], "tasks": ["35.5"]},
    {"id": 115, "phase": "outside_and_ai", "dependsOn": [114], "tasks": ["35.6"]},
    {"id": 116, "phase": "outside_and_ai", "dependsOn": [115], "tasks": ["56.1"]},
    {"id": 117, "phase": "outside_and_ai", "dependsOn": [116], "tasks": ["56.2"]},
    {"id": 118, "phase": "outside_and_ai", "dependsOn": [117], "tasks": ["56.3"]},
    {"id": 119, "phase": "outside_and_ai", "dependsOn": [118], "tasks": ["56.4"]},
    {"id": 120, "phase": "outside_and_ai", "dependsOn": [119], "tasks": ["56.5"]},
    {"id": 121, "phase": "outside_and_ai", "dependsOn": [120], "tasks": ["56.6"]},
    {"id": 122, "phase": "outside_and_ai", "dependsOn": [121], "tasks": ["56.7"]},
    {"id": 123, "phase": "outside_and_ai", "dependsOn": [122], "tasks": ["56.8"]},
    {"id": 124, "phase": "outside_and_ai", "dependsOn": [123], "tasks": ["56.9"]},
    {"id": 125, "phase": "outside_and_ai", "dependsOn": [124], "tasks": ["56.10"]},
    {"id": 126, "phase": "outside_and_ai", "dependsOn": [125], "tasks": ["35.7"]},
    {"id": 127, "phase": "outside_and_ai", "dependsOn": [126], "tasks": ["35.8"]},
    {"id": 128, "phase": "outside_and_ai", "dependsOn": [127], "tasks": ["35.9"]},
    {"id": 129, "phase": "outside_and_ai", "dependsOn": [128], "tasks": ["35.10"]},
    {"id": 130, "phase": "outside_and_ai", "dependsOn": [129], "tasks": ["35.11"]},
    {"id": 131, "phase": "outside_and_ai", "dependsOn": [130], "tasks": ["35.12"]},
    {"id": 132, "phase": "outside_and_ai", "dependsOn": [131], "tasks": ["35.13"]},
    {"id": 133, "phase": "outside_and_ai", "dependsOn": [132], "tasks": ["42.1"]},
    {"id": 134, "phase": "outside_and_ai", "dependsOn": [133], "tasks": ["42.2"]},
    {"id": 135, "phase": "outside_and_ai", "dependsOn": [134], "tasks": ["42.3"]},
    {"id": 136, "phase": "outside_and_ai", "dependsOn": [135], "tasks": ["42.4"]},
    {"id": 137, "phase": "outside_and_ai", "dependsOn": [136], "tasks": ["42.5"]},
    {"id": 138, "phase": "outside_and_ai", "dependsOn": [137], "tasks": ["42.6"]},
    {"id": 139, "phase": "outside_and_ai", "dependsOn": [138], "tasks": ["42.7"]},
    {"id": 140, "phase": "outside_and_ai", "dependsOn": [139], "tasks": ["31.8"]},
    {"id": 141, "phase": "outside_and_ai", "dependsOn": [140], "tasks": ["31.9"]},
    {"id": 142, "phase": "outside_and_ai", "dependsOn": [141], "tasks": ["31.10"]},
    {"id": 143, "phase": "outside_and_ai", "dependsOn": [142], "tasks": ["31.11"]},
    {"id": 144, "phase": "outside_and_ai", "dependsOn": [143], "tasks": ["31.12"]},
    {"id": 145, "phase": "outside_and_ai", "dependsOn": [144], "tasks": ["31.13"]},
    {"id": 146, "phase": "outside_and_ai", "dependsOn": [145], "tasks": ["31.14"]},
    {"id": 147, "phase": "outside_and_ai", "dependsOn": [146], "tasks": ["31.15"]},
    {"id": 148, "phase": "outside_and_ai", "dependsOn": [147], "tasks": ["41.4"]},
    {"id": 149, "phase": "outside_and_ai", "dependsOn": [148], "tasks": ["41.5"]},
    {"id": 150, "phase": "outside_and_ai", "dependsOn": [149], "tasks": ["41.6"]},
    {"id": 151, "phase": "outside_and_ai", "dependsOn": [150], "tasks": ["41.7"]},
    {"id": 152, "phase": "recovery", "dependsOn": [151], "tasks": ["58.1"]},
    {"id": 153, "phase": "recovery", "dependsOn": [152], "tasks": ["58.3"]},
    {"id": 154, "phase": "recovery", "dependsOn": [153], "tasks": ["38.4"]},
    {"id": 155, "phase": "recovery", "dependsOn": [154], "tasks": ["58.2"]},
    {"id": 156, "phase": "recovery", "dependsOn": [155], "tasks": ["58.4"]},
    {"id": 157, "phase": "recovery", "dependsOn": [156], "tasks": ["38.5"]},
    {"id": 158, "phase": "recovery", "dependsOn": [157], "tasks": ["38.6"]},
    {"id": 159, "phase": "recovery", "dependsOn": [158], "tasks": ["38.7"]},
    {"id": 160, "phase": "recovery", "dependsOn": [159], "tasks": ["38.8"]},
    {"id": 161, "phase": "recovery", "dependsOn": [160], "tasks": ["38.9"]},
    {"id": 162, "phase": "recovery", "dependsOn": [161], "tasks": ["38.10"]},
    {"id": 163, "phase": "recovery", "dependsOn": [162], "tasks": ["38.11"]},
    {"id": 164, "phase": "recovery", "dependsOn": [163], "tasks": ["38.12"]},
    {"id": 165, "phase": "recovery", "dependsOn": [164], "tasks": ["38.13"]},
    {"id": 166, "phase": "recovery", "dependsOn": [165], "tasks": ["58.6"]},
    {"id": 167, "phase": "recovery", "dependsOn": [166], "tasks": ["58.7"]},
    {"id": 168, "phase": "recovery", "dependsOn": [167], "tasks": ["67.2"]},
    {"id": 169, "phase": "recovery", "dependsOn": [168], "tasks": ["67.3"]},
    {"id": 170, "phase": "release_tooling", "dependsOn": [169], "tasks": ["43.1"]},
    {"id": 171, "phase": "release_tooling", "dependsOn": [170], "tasks": ["43.2"]},
    {"id": 172, "phase": "release_tooling", "dependsOn": [171], "tasks": ["43.3"]},
    {"id": 173, "phase": "release_tooling", "dependsOn": [172], "tasks": ["43.4"]},
    {"id": 174, "phase": "release_tooling", "dependsOn": [173], "tasks": ["43.5"]},
    {"id": 175, "phase": "release_tooling", "dependsOn": [174], "tasks": ["43.6"]},
    {"id": 176, "phase": "release_tooling", "dependsOn": [175], "tasks": ["43.7"]},
    {"id": 177, "phase": "release_tooling", "dependsOn": [176], "tasks": ["43.8"]},
    {"id": 178, "phase": "release_tooling", "dependsOn": [177], "tasks": ["43.9"]},
    {"id": 179, "phase": "release_tooling", "dependsOn": [178], "tasks": ["43.10"]},
    {"id": 180, "phase": "release_tooling", "dependsOn": [179], "tasks": ["43.11"]},
    {"id": 181, "phase": "release_tooling", "dependsOn": [180], "tasks": ["43.12"]},
    {"id": 182, "phase": "release_tooling", "dependsOn": [181], "tasks": ["44.1"]},
    {"id": 183, "phase": "release_tooling", "dependsOn": [182], "tasks": ["44.2"]},
    {"id": 184, "phase": "release_tooling", "dependsOn": [183], "tasks": ["44.3"]},
    {"id": 185, "phase": "release_tooling", "dependsOn": [184], "tasks": ["45.1"]},
    {"id": 186, "phase": "release_tooling", "dependsOn": [185], "tasks": ["45.2"]},
    {"id": 187, "phase": "release_tooling", "dependsOn": [186], "tasks": ["45.3"]},
    {"id": 188, "phase": "release_tooling", "dependsOn": [187], "tasks": ["45.4"]},
    {"id": 189, "phase": "release_tooling", "dependsOn": [188], "tasks": ["46.1"]},
    {"id": 190, "phase": "release_tooling", "dependsOn": [189], "tasks": ["59.5"]},
    {"id": 191, "phase": "release_tooling", "dependsOn": [190], "tasks": ["59.6"]},
    {"id": 192, "phase": "release_tooling", "dependsOn": [191], "tasks": ["48.1"]},
    {"id": 193, "phase": "release_tooling", "dependsOn": [192], "tasks": ["48.2"]},
    {"id": 194, "phase": "release_tooling", "dependsOn": [193], "tasks": ["48.3"]},
    {"id": 195, "phase": "release_tooling", "dependsOn": [194], "tasks": ["48.5"]},
    {"id": 196, "phase": "release_tooling", "dependsOn": [195], "tasks": ["48.10"]},
    {"id": 197, "phase": "release_tooling", "dependsOn": [196], "tasks": ["68.4"]},
    {"id": 198, "phase": "release_tooling", "dependsOn": [197], "tasks": ["67.4"]},
    {"id": 199, "phase": "release_tooling", "dependsOn": [198], "tasks": ["48.4"]},
    {"id": 200, "phase": "staging_and_acceptance", "dependsOn": [199], "tasks": ["48.6"]},
    {"id": 201, "phase": "staging_and_acceptance", "dependsOn": [200], "tasks": ["48.7"]},
    {"id": 202, "phase": "staging_and_acceptance", "dependsOn": [201], "tasks": ["48.8"]},
    {"id": 203, "phase": "staging_and_acceptance", "dependsOn": [202], "tasks": ["48.11"]},
    {"id": 204, "phase": "staging_and_acceptance", "dependsOn": [203], "tasks": ["58.5"]},
    {"id": 205, "phase": "staging_and_acceptance", "dependsOn": [204], "tasks": ["59.4"]},
    {"id": 206, "phase": "staging_and_acceptance", "dependsOn": [205], "tasks": ["46.2"]},
    {"id": 207, "phase": "staging_and_acceptance", "dependsOn": [206], "tasks": ["48.12"]},
    {"id": 208, "phase": "production_activation", "dependsOn": [207], "tasks": ["48.9"]}
  ],
  "helperEdges": [
    [
      "57.2",
      "57.3"
    ],
    [
      "67.1",
      "57.3"
    ],
    [
      "57.3",
      "19.1"
    ],
    [
      "57.4",
      "64.1"
    ],
    [
      "55.2",
      "31.6"
    ],
    [
      "55.2",
      "53.1"
    ],
    [
      "61.1",
      "60.2"
    ],
    [
      "62.1",
      "61.2"
    ],
    [
      "54.1",
      "68.1"
    ],
    [
      "68.1",
      "54.2"
    ],
    [
      "31.1",
      "54.2"
    ],
    [
      "54.2",
      "31.2"
    ],
    [
      "59.1",
      "32.1"
    ],
    [
      "59.2",
      "32.5"
    ],
    [
      "59.3",
      "34.1"
    ],
    [
      "34.1",
      "56.2"
    ],
    [
      "58.1",
      "38.4"
    ],
    [
      "58.3",
      "38.4"
    ],
    [
      "58.4",
      "38.5"
    ],
    [
      "38.5",
      "58.5"
    ],
    [
      "68.4",
      "48.4"
    ],
    [
      "48.5",
      "48.11"
    ],
    [
      "48.11",
      "58.5"
    ],
    [
      "48.11",
      "59.4"
    ],
    [
      "48.11",
      "46.2"
    ],
    [
      "58.5",
      "48.12"
    ],
    [
      "59.4",
      "48.12"
    ],
    [
      "46.2",
      "48.12"
    ],
    [
      "48.12",
      "48.9"
    ],
    [
      "31.1",
      "52.4"
    ],
    [
      "54.5",
      "52.4"
    ],
    [
      "31.1",
      "52.5"
    ],
    [
      "54.2",
      "52.5"
    ],
    [
      "40.3",
      "52.6"
    ],
    [
      "50.1",
      "50.2"
    ],
    [
      "50.2",
      "50.3"
    ],
    [
      "50.3",
      "57.2"
    ]
  ],
  "gates": [
    {
      "id": "team_archive",
      "checkerTask": "68.4",
      "evidenceTask": "48.12",
      "requiredTasks": [
        "57.1",
        "50.1",
        "50.2",
        "50.3",
        "57.2",
        "67.1",
        "57.3",
        "19.1",
        "57.4",
        "57.5",
        "30.6",
        "30.7",
        "30.8",
        "30.11",
        "57.6",
        "57.7",
        "57.8",
        "52.1",
        "52.2",
        "52.3",
        "52.4",
        "52.5",
        "52.6",
        "52.7",
        "52.8",
        "55.1",
        "55.2",
        "55.3",
        "62.1",
        "61.1",
        "60.1",
        "60.2",
        "60.3",
        "60.4",
        "60.5",
        "60.6",
        "62.2",
        "62.3",
        "62.4",
        "62.5",
        "62.6",
        "61.2",
        "61.3",
        "63.1",
        "63.2",
        "63.3",
        "63.4",
        "64.1",
        "64.2",
        "64.3",
        "64.4",
        "64.5",
        "65.1",
        "65.2",
        "65.3",
        "54.1",
        "68.1",
        "31.1",
        "54.2",
        "31.2",
        "31.3",
        "54.3",
        "54.4",
        "54.5",
        "54.6",
        "54.7",
        "54.8",
        "54.9",
        "31.4",
        "31.5",
        "31.6",
        "31.7",
        "68.2",
        "68.3",
        "53.1",
        "53.2",
        "53.3",
        "36.1",
        "36.2",
        "36.3",
        "36.4",
        "37.1",
        "37.2",
        "37.3",
        "37.4",
        "37.5",
        "37.6",
        "37.7",
        "37.8",
        "37.9",
        "37.10",
        "37.11",
        "40.1",
        "40.2",
        "40.3",
        "40.4",
        "40.5",
        "41.1",
        "41.2",
        "41.3",
        "38.3",
        "31.8",
        "31.9",
        "31.10",
        "31.11",
        "31.12",
        "31.13",
        "31.14",
        "31.15",
        "41.4",
        "41.5",
        "41.6",
        "41.7",
        "58.1",
        "58.3",
        "38.4",
        "58.2",
        "58.4",
        "38.5",
        "38.6",
        "38.7",
        "38.10",
        "38.12",
        "38.13",
        "58.6",
        "58.7",
        "67.2",
        "67.3",
        "43.1",
        "43.2",
        "43.3",
        "43.4",
        "43.5",
        "43.6",
        "43.7",
        "43.9",
        "43.10",
        "43.11",
        "43.12",
        "44.1",
        "44.2",
        "44.3",
        "45.1",
        "45.2",
        "45.3",
        "45.4",
        "46.1",
        "48.1",
        "48.2",
        "48.3",
        "48.5",
        "48.10",
        "68.4",
        "67.4",
        "48.4",
        "48.6",
        "48.7",
        "48.8",
        "48.11",
        "58.5",
        "46.2",
        "48.12"
      ],
      "requiredEvidence": [
        "R60.4 team-archive matrix",
        "R60.9 team walkthroughs",
        "R36 independent encrypted recovery and fresh restore",
        "R28 certified selected operating profile",
        "current Worker/schema/configuration compatibility"
      ],
      "beforeTasks": [
        "48.9"
      ]
    },
    {
      "id": "public_archive",
      "checkerTask": "68.4",
      "evidenceTask": "48.12",
      "requiresGates": [
        "team_archive"
      ],
      "requiredEvidence": [
        "R60.4 additional public matrix",
        "current operator-selected content licence",
        "exact snapshot Owner/external permission coverage",
        "real channel/browser/security/accessibility/index tests",
        "R24 removal and independently verified containment",
        "R28 distributed Abuse_Profile and spend reserve"
      ],
      "beforeEnable": [
        "public research hosts"
      ]
    },
    {
      "id": "outside_services",
      "checkerTask": "68.4",
      "evidenceTask": "48.12",
      "requiresGates": [
        "public_archive"
      ],
      "requiredEvidence": [
        "Access/Turnstile/R2/Graph least privilege and delivery/retention verification",
        "consent snapshot and bearer-link current eligibility",
        "moderation/contact-review privacy and retention",
        "AI allow-list/input isolation and configured allocation when AI enabled"
      ],
      "beforeEnable": [
        "outside submission endpoints",
        "emailed consent endpoints",
        "AI drafting when enabled"
      ]
    },
    {
      "id": "final_checkpoint_49",
      "requiresGates": [
        "team_archive",
        "public_archive",
        "outside_services"
      ],
      "requiredTasks": [
        "57.1",
        "50.1",
        "50.2",
        "50.3",
        "57.2",
        "67.1",
        "57.3",
        "19.1",
        "57.4",
        "57.5",
        "30.6",
        "30.7",
        "30.8",
        "30.11",
        "57.6",
        "57.7",
        "57.8",
        "52.1",
        "52.2",
        "52.3",
        "52.4",
        "52.5",
        "52.6",
        "52.7",
        "52.8",
        "55.1",
        "55.2",
        "55.3",
        "62.1",
        "61.1",
        "66.1",
        "60.1",
        "60.2",
        "60.3",
        "60.4",
        "60.5",
        "60.6",
        "62.2",
        "62.3",
        "62.4",
        "62.5",
        "62.6",
        "61.2",
        "61.3",
        "63.1",
        "63.2",
        "63.3",
        "63.4",
        "64.1",
        "64.2",
        "64.3",
        "64.4",
        "64.5",
        "65.1",
        "65.2",
        "65.3",
        "54.1",
        "68.1",
        "31.1",
        "54.2",
        "31.2",
        "31.3",
        "54.3",
        "54.4",
        "54.5",
        "54.6",
        "54.7",
        "54.8",
        "54.9",
        "31.4",
        "31.5",
        "31.6",
        "31.7",
        "68.2",
        "68.3",
        "53.1",
        "53.2",
        "53.3",
        "36.1",
        "36.2",
        "36.3",
        "36.4",
        "37.1",
        "37.2",
        "37.3",
        "37.4",
        "37.5",
        "37.6",
        "37.7",
        "37.8",
        "37.9",
        "37.10",
        "37.11",
        "40.1",
        "40.2",
        "40.3",
        "40.4",
        "40.5",
        "41.1",
        "41.2",
        "41.3",
        "59.1",
        "59.2",
        "59.3",
        "32.1",
        "32.2",
        "32.3",
        "32.4",
        "32.5",
        "32.6",
        "32.7",
        "55.4",
        "55.5",
        "66.2",
        "66.3",
        "66.4",
        "38.3",
        "38.1",
        "38.2",
        "34.1",
        "34.2",
        "34.3",
        "34.4",
        "34.5",
        "34.6",
        "35.1",
        "35.2",
        "35.3",
        "35.4",
        "35.5",
        "35.6",
        "56.1",
        "56.2",
        "56.3",
        "56.4",
        "56.5",
        "56.6",
        "56.7",
        "56.8",
        "56.9",
        "56.10",
        "35.7",
        "35.8",
        "35.9",
        "35.10",
        "35.11",
        "35.12",
        "35.13",
        "42.1",
        "42.2",
        "42.3",
        "42.4",
        "42.5",
        "42.6",
        "42.7",
        "31.8",
        "31.9",
        "31.10",
        "31.11",
        "31.12",
        "31.13",
        "31.14",
        "31.15",
        "41.4",
        "41.5",
        "41.6",
        "41.7",
        "58.1",
        "58.3",
        "38.4",
        "58.2",
        "58.4",
        "38.5",
        "38.6",
        "38.7",
        "38.8",
        "38.9",
        "38.10",
        "38.11",
        "38.12",
        "38.13",
        "58.6",
        "58.7",
        "67.2",
        "67.3",
        "43.1",
        "43.2",
        "43.3",
        "43.4",
        "43.5",
        "43.6",
        "43.7",
        "43.8",
        "43.9",
        "43.10",
        "43.11",
        "43.12",
        "44.1",
        "44.2",
        "44.3",
        "45.1",
        "45.2",
        "45.3",
        "45.4",
        "46.1",
        "59.5",
        "59.6",
        "48.1",
        "48.2",
        "48.3",
        "48.5",
        "48.10",
        "68.4",
        "67.4",
        "48.4",
        "48.6",
        "48.7",
        "48.8",
        "48.11",
        "58.5",
        "59.4",
        "46.2",
        "48.12",
        "48.9"
      ],
      "requiredEvidence": [
        "full mandatory suites and traceability/graph validation",
        "no unresolved acceptance failures for enabled scope"
      ]
    }
  ]
}
```
