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
| Residual Recoverable Items copies (open question 2) | Mailbox settings in the Microsoft 365 setup script; no statement on the Privacy page | `STATE_MAILBOX_RESIDUAL_COPIES = false` in `packages/db/src/seed/policy-sections.ts` |
| Public search under an exhausted budget (open question 3, R28.11) | `status.json` marks search unavailable and the search page shows the notice | `PUBLIC_SEARCH_FOLLOWS_BUDGET = true` in `apps/app/src/budget/status.ts` |
| Journal-unreferenced attachments (open question 4, R26.12) | Reported early by the dry-run; they fail import as specified | `resolveAttachmentParent()` in `packages/markdown/src/journal/attachments.ts` |
| AI_Drafting_Setting default (open question 7) | Starts On | `SETTINGS.aiDrafting.default` in `packages/domain/src/settings.ts` |
| Backup write freeze (open question 11) | `frozen` guard while the backup reads `rf-core` | `apps/app/src/jobs/backup.ts`, `FREEZE` constants |
| Item_Identifier format (open question 12) | 12 random Crockford base-32 characters in groups of four | `ITEM_ID_FORMAT` in `packages/domain/src/identifiers.ts` |

Tests use synthetic data only. No task copies, quotes, or commits content from the existing journal or its attachments. The dry-run and the import read those files from paths the user gives, the dry-run prints only counts, phase identifiers, line ranges, and file names, and the import creates every unit Private and Unclassified.

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
    - `apps/submit/wrangler.jsonc`, `apps/dl/wrangler.jsonc`, `apps/ops/wrangler.jsonc` with the bindings from the design's component table; `workers_dev: false` and `preview_urls: false` on every Worker; a `staging` environment block in each; only features available on the Workers Free plan
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
  - [x]* 2.3 Write property test for dates and times
    - **Property 91: Dates and times follow precision and zone rules**
    - **Validates: Requirements 6.7, 45.12, 45.23**
  - [x] 2.4 Implement the RichText span model in `packages/domain/src/richtext.ts`
    - `RichText` and `Span` types (quote, paraphrase, source_reported, lang, mention) with UTF-16 offsets on code point boundaries
    - `validateSpans` naming each faulty span and reason (blank or over-long sources, Quote and Paraphrase on one character, languages outside the ISO 639-1 list, two language marks on one character)
    - `applyEdit` that maps spans through a text change, `labelsOnlyChanged` that confirms a label edit leaves the text unchanged, and `mentionsOf` that returns only picker-inserted Mention spans
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.7, 11.9, 16.8, 45.6_
  - [x]* 2.5 Write property test for label edits
    - **Property 37: Labels never change text and follow edits**
    - **Validates: Requirements 11.7, 11.9, 45.6**
  - [x]* 2.6 Write property test for label validity
    - **Property 38: Label and language-mark validity**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.4, 45.6**

- [x] 3. Build the domain rules: value sets, identifiers, file kinds, settings, retention, permissions, and search text
  - [x] 3.1 Implement the configurable value-set rules in `packages/domain/src/value-sets.ts`
    - Pure operations add, rename, retire, and mark-as-permitting-publication, returning the new set or the rule broken: names of 1 to 50 characters unique ignoring letter case, the last value that is not retired, locked values (Open and Eliminated, Sent and Replied, Unknown), and Unknown never renamed or marked as permitting publication
    - `acceptsNewlySet(value)` refusing retired values; Methods_Term sets require a Public_Description of 1 to 500 characters when a value is added
    - _Requirements: 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12, 46.13_
  - [x]* 3.2 Write property test for value sets
    - **Property 31: Configurable value sets behave uniformly**
    - **Validates: Requirements 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12**
  - [x] 3.3 Implement identifier generators in `packages/domain/src/identifiers.ts`
    - `ITEM_ID_FORMAT` and `newItemIdentifier()`: 12 Crockford base-32 characters from `crypto.getRandomValues` in groups of four, such as `K7QM-3XRW-9DPA`, with the lower-case registry key; this module is the only place the format is defined
    - `newSubmissionReference()`: `RS-` followed by ten random Crockford characters in two groups
    - _Requirements: 15.1, 15.6, 31.5_
  - [x] 3.4 Implement file kinds in `packages/domain/src/file-kinds.ts`
    - Map the lower-cased text after the last dot to PDF, image, archive, spreadsheet, CSV, structured data, text log, video, or other, using the design's extension table
    - _Requirements: 12.3_
  - [x]* 3.5 Write property test for file kinds
    - **Property 44: File kind is a total function of the extension**
    - **Validates: Requirements 12.3**
  - [x] 3.6 Implement the settings registry in `packages/domain/src/settings.ts`
    - Every workspace-wide setting with its validator, allowed range, and default: Follow_Up_Interval, Email_Batch_Window, Direct_Upload_Threshold, Attachment_Size_Limit, Public_Upload_Size_Limit, Outside_Submission_Limits, Public_Traffic_Budget, configured Email_Provider, Recipient_Cap, AI_Drafting_Setting (default On, defined only here), AI_Input_Limit, and the Responsible_Person
    - Operational constants in the same module: slice sizes, the Bulk_Import write allowance of 30,000 rows per UTC day, and budget safety margins
    - _Requirements: 2.5, 10.8, 20.14, 20.25, 28.12, 44.11, 44.15, 46.37_
  - [x] 3.7 Implement retention constants and Retention_Table rows in `packages/domain/src/retention.ts`
    - One constant per kind of data listed in Requirement 46.19, read by the sweepers and by `retentionRows()`, which produces the Retention_Table rows for the Privacy page
    - _Requirements: 12.8, 31.8, 32.8, 35.6, 35.11, 36.3, 46.19, 46.20, 46.26_
  - [x]* 3.8 Write property test for the Retention_Table
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
  - [x]* 4.4 Write property test for the validators
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
  - [x]* 5.8 Write integration tests for guards, the Revision trigger, and the schema
    - In the workers pool: a failing guard aborts the whole batch and names its rule; `UPDATE` on `revisions` is refused; a schema scan finds no password, password hash, or PIN column
    - _Requirements: 1.2, 4.1, 22.11_

- [x] 6. Build the privacy kernel in `packages/kernel`
  - [x] 6.1 Implement Effective_Disclosure in `packages/kernel/src/effective.ts`
    - `DNode`, `ancestors(n)` (Parent chain to the Root_Item, then the Project), and `effective(n)` as the design defines it: Unclassified units are Private, any non-Public ancestor makes a unit Private, and Entry_Sections, Replies, and Dissent_Notes also need a Full_Content Root_Item
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
    - **Validates: Requirements 23.1, 23.3, 24.5, 26.5**
  - [x] 6.6 Write property test for public output confinement
    - Build `workspaceStateArb` in `packages/testing/src/workspace.ts` with a unique canary token in every field of every unit, Member, Party, and Outside_Submission
    - Build the public-channel registry `packages/testing/src/public-channels.ts`, register the kernel's view output as its first channel, and write the test so it checks every registered channel; later tasks register their channels here
    - **Property 5: Public outputs contain only Public_View content**
    - **Validates: Requirements 17.7, 20.6, 24.5, 24.6, 24.13, 30.10, 31.7, 31.9, 35.2, 40.6, 41.12, 42.8, 42.15**
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
  - [x]* 7.3 Write property test for mathematics delimiters
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
  - [x]* 8.6 Write unit tests for font coverage and accent contrast
    - Read every font file's character map and check that each graphic character of the blocks Requirement 45.13 lists is covered in each stack; check every Project_Accent for at least 4.5:1 text and 3:1 interface contrast in both schemes
    - _Requirements: 45.4, 45.13, 45.22_
  - [x]* 8.7 Write property test for label rendering
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
  - [x]* 9.6 Write property test for complete public pages
    - **Property 16: Public pages are complete**
    - **Validates: Requirements 24.1, 24.2, 24.3, 24.9, 24.10, 24.14, 24.15, 29.9, 29.10, 29.11, 29.12, 45.2, 46.2, 46.8**
  - [x]* 9.7 Write property test for public listings
    - **Property 18: Public listings are exact, ordered, and paged**
    - **Validates: Requirements 29.1, 29.5, 29.13, 29.14, 40.1, 40.2, 40.4, 40.11**
  - [x]* 9.8 Write property test for page metadata
    - **Property 20: Page metadata derives from the page**
    - **Validates: Requirements 45.10, 45.11**
  - [x]* 9.9 Write property test for the Methods page and term links
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
  - [x]* 10.5 Write property test for public search
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
  - [x]* 13.5 Write property test for identity assertions
    - Use `jwtArb` in `packages/testing/src/jwt.ts` with test signing keys and mutations
    - **Property 21: Identity assertions gate every Workspace request**
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 1.8, 2.9**
  - [x]* 13.6 Write unit tests for logout and log redaction
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
  - [x]* 14.5 Write property test for Permission decisions
    - **Property 23: Permission decisions match the Role_Permission_Map**
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.2, 13.8, 34.10, 41.3, 41.4, 42.5, 42.6, 44.13, 45.22, 46.16, 46.39**
  - [x]* 14.6 Write property test for the last active Administrator
    - **Property 24: At least one active Administrator remains**
    - **Validates: Requirements 2.11**
  - [x]* 14.7 Write property test for Member identity
    - **Property 25: Member identity invariants**
    - **Validates: Requirements 2.1, 2.2, 2.13**

- [ ] 15. Build Profiles, preferences, mutes, and Licence_Agreements
  - [ ] 15.1 Implement the Profile API in `apps/app/src/api/routes/profile.ts`
    - `GET /me`, `PATCH /me/profile` (own Profile only, schema checks, retired Specialties refused), `GET /members/{id}/profile` with the 20 most recent Submissions and links, `PUT /me/preferences` (initially in-app On and email Immediate for every Event_Type; Daily_Digest hour initially 08:00), `PUT /me/mutes`, and `POST /me/licence-agreement` recording the UTC date and the Content_Licence name, with no route that withdraws one
    - Public_Profile changes to On return the `projectProfile` preview and apply only on confirmation; Profile changes write a `member:{id}` outbox row
    - _Requirements: 3.1, 3.2, 3.4, 3.7, 19.8, 19.9, 20.13, 39.10, 46.4, 46.16_
  - [ ] 15.2 Implement the incomplete-Profile gate in `apps/app/src/auth/profile-gate.ts`
    - Respond `profile_incomplete` (428) to every Workspace route except the Profile routes while the display name, a Specialty, or the time zone is missing
    - _Requirements: 3.6_
  - [ ]* 15.3 Write property test for the Profile gate
    - **Property 26: Incomplete Profiles gate the Workspace**
    - **Validates: Requirements 3.6**

- [ ] 16. Build the save pipeline and Projects
  - [ ] 16.1 Implement the save pipeline in `apps/app/src/records/pipeline.ts`
    - Validate with the domain schemas, load the current revision, run data checks, build one guarded batch with the `rev` guard, the change counter, the writes, `revisionsFor(change)` (one Revision per Revision_Kind with the previous value of each changed field), automatic consequences, and outbox rows, then commit
    - Content edits require a Minor_Edit or Correction mark with no default and a reason for a Correction, except Restorations and saves that only change status, withdrawal, or disclosure fields; a 409 lists the Revisions saved since with Member and time
    - A label-only change is an edit of the field that contains it, with the same Permission checks and a Revision whose previous values include the old spans; the server confirms the text is unchanged
    - _Requirements: 4.1, 4.5, 4.9, 11.7, 11.8, 22.1, 22.2, 22.9, 22.10, 28.13_
  - [ ] 16.2 Implement Projects in `apps/app/src/records/projects.ts` and `apps/app/src/api/routes/projects.ts`
    - Create (Private, not featured, last in the Project_Order, creator and time recorded), edit with validation, refusal of a whole save that changes a fixed Project_Slug, featured toggle, `move-position` rewriting the positions between the old and new places in one batch, and Project_Accent set or clear from the palette by Administrators only
    - A Revision for every change (Disclosure_Change for level and Disclosure_Line, Minor_Edit otherwise), `GET /projects/{id}/history` with before and after values, and `project:{id}` outbox rows
    - _Requirements: 39.4, 39.5, 39.6, 39.7, 39.8, 39.18, 45.3, 45.4, 45.22_
  - [ ]* 16.3 Write property test for the Project_Order
    - **Property 76: Project_Order stays a permutation**
    - **Validates: Requirements 39.7**
  - [ ]* 16.4 Write property test for Project_Accents
    - **Property 94: Project_Accents apply only to their Project and only from the palette**
    - **Validates: Requirements 45.3, 45.22**

- [ ] 17. Build Submissions, identifiers, Cross_Links, and External_Parties
  - [ ] 17.1 Implement Submissions and identifier issue in `apps/app/src/records/submissions.ts`
    - Every unit carries `submission_id`; a normal Submission sets `completed_at` in the batch that creates its units; `visibleTo(memberId)` filters every Workspace query to completed Submissions; Item_Identifiers are inserted into `identifiers` with a retry on collision
    - A Research_Item needs an existing Project, with the preselection rule of Requirement 39.2 and the "an Administrator must first create one" message when none exists
    - _Requirements: 15.1, 15.6, 18.2, 18.11, 39.1, 39.2, 39.3_
  - [ ] 17.2 Implement Cross_Links and Backlinks in `apps/app/src/records/links.ts` and `apps/app/src/api/routes/links.ts`
    - `POST /links` and `DELETE /links/{id}` recording origin, target, optional relation label, Member, and time whatever the levels and withdrawal states; refusal of self-links, missing or deleted ends, unknown or retired labels, and duplicates; removal by the adder or an Administrator recorded in the origin's history
    - Backlinks from the `target_id` index, 100 per page with no upper bound; each end shows the relation label, kind, title, Item_Identifier (the Root_Item's for Entry_Sections and Replies), and a withdrawal notice; citing evidence for a Finding records an Evidence_Link
    - _Requirements: 5.2, 15.2, 15.3, 15.4, 15.5, 15.7_
  - [ ] 17.3 Implement External_Parties in `apps/app/src/records/parties.ts` and `apps/app/src/api/routes/parties.ts`
    - A new External_Party whose case- and diacritic-folded name equals an existing one needs confirmation; one Do_Not_Name flag and one Generic_Label per External_Party; any Member may turn the flag on with a valid Generic_Label; a non-Administrator turning it off is refused; changes write `party:{id}` outbox rows
    - _Requirements: 9.2, 34.4, 34.8, 34.10_
  - [ ]* 17.4 Write property test for Cross_Links and Backlinks
    - **Property 42: Cross_Links are unique and Backlinks complete**
    - **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.7**
  - [ ]* 17.5 Write property test for External_Party duplicate detection
    - **Property 99: External_Party duplicate detection ignores case and diacritics**
    - **Validates: Requirements 9.2**

- [ ] 18. Build the Research_Item kinds with the Log_Summary and the Group_Note
  - [ ] 18.1 Implement Journal_Entries in `apps/app/src/records/kinds/journal.ts`
    - Title, optional Campaign_Status from the set, phase identifier, start and end dates, related Members, and 1 to 5,000 ordered Entry_Sections; edits that add, change, reorder, or remove sections keep each surviving section's Disclosure_Level, Classification_State, Revisions, and Cross_Links, with the growth rule for entries larger than the caps
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8_
  - [ ] 18.2 Implement Findings in `apps/app/src/records/kinds/finding.ts`
    - Default Finding_Status Open; the `evidence` guard for Confirmed and the `superseding` guard for Superseded, counting links saved in the same change; removal of the last such link refused with "change the Finding_Status first"; Withdrawn at submission needs a reason
    - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.8, 5.9_
  - [ ] 18.3 Implement Sources and Runs in `apps/app/src/records/kinds/source.ts` and `apps/app/src/records/kinds/run.ts`
    - Source fields with the recoverer as a Member or External_Party, rights fields defaulting to Unknown, and partial document dates stored as given; Run fields, start time to the second with a zone, end time, Resume_Point, notes, and up to 20 counts stored as digit strings and never converted to numbers
    - _Requirements: 6.1, 6.2, 6.4, 6.6, 6.7, 7.1, 7.2, 7.3, 7.5, 7.8, 7.9, 33.1, 33.2_
  - [ ] 18.4 Implement Hypotheses in `apps/app/src/records/kinds/hypothesis.ts`
    - Start Open; Eliminated needs a non-blank Elimination_Scope and an Evidence_Link with a Run or Finding, re-checked on edits and link removals; reopening by the Owner or an Administrator needs a reason and records a Status_Change with the previous Elimination_Scope; an Elimination_Scope change while Eliminated must be a Correction
    - _Requirements: 8.1, 8.2, 8.4, 8.6, 8.7, 8.9_
  - [ ] 18.5 Implement Correspondences in `apps/app/src/records/kinds/correspondence.ts`
    - Title, date, channel, direction, content, at least two Parties, and one Consent_Status per External_Party per Correspondence, initially Not_Asked
    - Automatic consequence in the same batch: a Public Correspondence that gains a non-Granted External_Party or loses a Granted consent becomes Withheld with `prefillCorrespondenceLine`, with a Disclosure_Change attributed to the saving Member
    - _Requirements: 9.1, 9.3, 9.4, 9.5, 9.6, 34.1, 34.3_
  - [ ] 18.6 Implement Archival_Requests and Topics in `apps/app/src/records/kinds/archival.ts` and `apps/app/src/records/kinds/topic.ts`
    - Archive or desk and contact as Parties; the Sent and Replied rules; reply date and content as fields separate from the Thread; `isFollowUpDue(request, interval, ownerZone)`; Topics with title and body
    - _Requirements: 10.1, 10.2, 10.6, 10.7, 16.1_
  - [ ] 18.7 Implement the Log_Summary and the Group_Note in `apps/app/src/records/log-summary.ts`
    - Log_Summary required at submission for every kind except Journal_Entry and Topic; the `log_summary_owner` guard refuses any change by another Member, even inside a request that changes other fields; an edit that empties an existing Log_Summary is refused with "a Log_Summary can be changed but not removed"; changes are Revisions with previous text and labels
    - A non-empty Group_Note is posted in the same Submission as a Reply flagged `is_group_note`, owned and credited by the submitter, placed first in the Thread
    - _Requirements: 41.1, 41.2, 41.3, 41.4, 41.5, 41.6, 41.7, 41.8, 41.15_
  - [ ] 18.8 Implement the Item routes in `apps/app/src/api/routes/items.ts`
    - `POST /items/{kind}`, `GET /items/{id}`, and `PATCH /items/{id}`; the item response carries the Owner's display name and current Specialties, the Credit, the Project name, and each unit's Disclosure_Level and Effective_Disclosure computed with the kernel over the loaded ancestors
    - _Requirements: 3.5, 23.9, 39.15_
  - [ ]* 18.9 Write property test for Journal_Entry edits
    - **Property 32: Journal_Entry edits preserve surviving sections and their order**
    - **Validates: Requirements 4.4, 4.8**
  - [ ]* 18.10 Write property test for the acting Member
    - **Property 22: The acting Member is the session Member**
    - **Validates: Requirements 1.7, 2.10**

- [ ] 19. Build staged commits and the value-set and settings APIs
  - [ ] 19.1 Implement staged commits in `apps/app/src/records/stages.ts` and `apps/app/src/api/routes/stages.ts`
    - Saves above 512 KB send `POST /stages`, `PUT /stages/{token}/parts/{n}`, and `POST /stages/{token}/commit`, which moves the staged rows into place with `INSERT … SELECT` in one batch; non-staged routes answer `too_large` (413) above 512 KB
    - _Requirements: 4.1, 4.4, 28.3_
  - [ ] 19.2 Implement the value-set API in `apps/app/src/api/routes/value-sets.ts`
    - `GET/POST/PATCH /value-sets` applying the domain rules to every configurable set, Public_Description edits for Methods_Terms, and `value:{set}:{id}` outbox rows
    - _Requirements: 3.3, 3.8, 4.6, 6.5, 6.8, 7.7, 8.8, 10.5, 33.6, 46.12, 46.13_
  - [ ] 19.3 Implement the settings API in `apps/app/src/api/routes/settings.ts`
    - `GET/PUT /settings` with each setting's validator, refusing out-of-range values with the allowed range shown
    - _Requirements: 2.5, 10.8, 20.14, 20.25, 28.12, 44.15_

- [ ] 20. Build the transactional outbox consumers, cron, and sliced jobs
  - [ ] 20.1 Implement the outbox reader and kicks in `apps/app/src/outbox.ts`
    - Per-topic reading in `seq` order with `done_at` marking; after a committed batch the handler sends a best-effort kick to the owning Durable Object with `ctx.waitUntil`
    - _Requirements: 4.1, 21.6, 24.12_
  - [ ] 20.2 Implement the scheduled handler in `apps/app/src/cron.ts`
    - The every-minute trigger kicks every owner; the hourly trigger runs a list of sweeps, starting with deletion of staging rows older than 24 hours
    - _Requirements: 28.3_
  - [ ] 20.3 Implement the sliced job runner in `apps/app/src/do/jobs.ts`
    - A `Jobs` Durable Object that processes one slice of about 5 ms per alarm, stores its cursor and progress in its SQLite storage and the `jobs` table, sets the next alarm while work remains, and pauses on a daily-limit error until after 00:00 UTC
    - _Requirements: 26.13, 28.3, 36.10_
  - [ ]* 20.4 Write integration tests for the outbox and the job runner
    - A lost kick is picked up by the next cron run; a job stopped by a simulated daily-limit error resumes from its cursor without repeating work
    - _Requirements: 26.13, 36.10_

- [ ] 21. Build the Workspace SPA foundation and the record screens
  - [ ] 21.1 Create the SPA shell in `apps/app/web/src/main.tsx`, `apps/app/web/src/routes.tsx`, and `apps/app/web/src/api.ts`
    - react-router routes; an API client that sends `X-RF-CSRF`, handles the error shape, reloads through Access on 401, and shows "saving is unavailable until 00:00 UTC" on every page after a `daily_limit` error or the platform's limit response; the "saving is paused for a backup" notice for `frozen`; the Profile form for `profile_incomplete`; the ResearchForce header link to the start page
    - _Requirements: 1.1, 3.6, 28.9, 28.13, 45.2_
  - [ ] 21.2 Implement unsent-input persistence in `apps/app/web/src/persist.ts`
    - Mirror every editor's and form's field values into `sessionStorage` for the tab until the input is sent or discarded, restore them after a reload, and state that the input was not saved after a failure
    - _Requirements: 28.10, 28.13_
  - [ ] 21.3 Build the rich-text editor in `apps/app/web/src/editor/`
    - CodeMirror 6 on the Markdown source with label and language-mark decorations and dialogs, span mapping through `applyEdit`, and a picker that inserts Mentions of active Members and non-retired Specialties as atomic ranges
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.9, 16.8, 45.6_
  - [ ] 21.4 Build the submission and edit forms in `apps/app/web/src/items/forms/`
    - One form per Research_Item kind with the Project choice and preselection, the Log_Summary and Group_Note fields, field errors from 422 responses, the Minor_Edit or Correction choice with no default and the reason field, and the conflict view for 409 responses that keeps the input
    - _Requirements: 4.9, 22.2, 22.10, 39.2, 39.3, 41.2, 41.7_
  - [ ] 21.5 Build the item pages in `apps/app/web/src/items/page.tsx`
    - Fields with their companion fields in the same section (Finding_Status and Scope_Caveat with every claim, the superseding Finding link, Source_Kind and reliability, the Resume_Point or its absence, the Elimination_Scope right after an Eliminated status), the Owner and Credit linked to Profiles, the Project name, Disclosure_Level and Effective_Disclosure, Cross_Links and Backlinks with their notices, the Log_Summary section with its author or "no Log_Summary recorded", and the Group_Note label
    - _Requirements: 3.5, 5.6, 5.10, 6.3, 7.4, 8.3, 15.3, 23.9, 39.15, 41.9_
  - [ ] 21.6 Build the Profile and Member screens in `apps/app/web/src/people/`
    - Own Profile form, Profile view with recent Submissions, Notification_Preferences, digest hour, Muted_Projects, the Licence_Agreement checkbox (never preselected), and the Public_Profile preview and confirmation; for Administrators, invitations, Role changes, and revocations
    - _Requirements: 2.1, 3.1, 3.4, 19.8, 20.13, 39.10, 46.4, 46.16_
  - [ ] 21.7 Build the Project screens in `apps/app/web/src/projects/`
    - Create and edit with the reserved slug names shown, the slug-fixed indicator, the featured toggle, order moves with buttons as well as dragging, the accent picker limited to the palette, and the Project history
    - _Requirements: 39.4, 39.5, 39.7, 39.18, 45.4, 45.5_

- [ ] 22. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 23. Build the History_Service
  - [ ] 23.1 Implement history reconstruction and the history API in `packages/domain/src/history.ts` and `apps/app/src/api/routes/history.ts`
    - Pure `stateAt(current, revisions, point)` that undoes later Revisions from the current state
    - `GET /items/{id}/history` listing the creation and every Revision of the Item and its Entry_Sections, newest first, with Member, time, Revision_Kind, and reason, and the state immediately after a selected point
    - _Requirements: 22.1, 22.3, 22.11_
  - [ ] 23.2 Implement comparisons in `packages/domain/src/compare.ts` and `GET /items/{id}/compare`
    - Field-by-field comparison of two points with both values, and word diffs (`diffWordsWithSpace`) that mark added and removed words, including label differences
    - _Requirements: 22.4_
  - [ ] 23.3 Implement Restoration in `packages/domain/src/restore.ts` and `POST /items/{id}/restore`
    - Pure `restoreFields` returning content and fields at the chosen point, except the fields that Status_Changes, Withdrawals, and Disclosure_Changes set, and except the Log_Summary when the restorer is not the Owner or the point had none
    - The Owner or an Administrator restores; Entry_Sections added back get Private; the Restoration Revision names the point and intermediate Revisions stay
    - _Requirements: 2.4, 22.5, 23.15, 41.14_
  - [ ] 23.4 Implement Withdrawal in `POST /items/{id}/withdraw`
    - Reason of 1 to 1,000 characters; the Item, its history, and its Disclosure_Level stay; withdrawn date and reason shown to Members; a Finding becomes Withdrawn with a Withdrawal Revision; a preview response states whether the Public_Site will show the reason (Effective_Disclosure Public)
    - _Requirements: 5.5, 22.6, 22.9, 24.10_
  - [ ] 23.5 Implement permanent deletion in `apps/app/src/jobs/deletion.ts` and `DELETE /items/{id}`
    - Administrators confirm by typing the Item_Identifier and give a reason of 1 to 1,000 characters; a `Jobs` object removes the content, fields, and Revisions of the Item and every element under it, deletes their R2 objects within 24 hours, keeps the `identifiers` rows, and writes the Deletion record with kind, Item_Identifier, Administrator, time, and reason
    - A deleted Reply leaves a placeholder at its position with the deletion date and its children in place; Cross_Links on remaining ends show the deleted end's kind, Item_Identifier, and deletion date from the Deletion record
    - _Requirements: 15.8, 16.10, 22.7, 22.9_
  - [ ] 23.6 Build the history screens in `apps/app/web/src/history/`
    - History list, state at a point, comparison with marked words, the restore dialog, the withdrawal dialog with its public-reason statement, and the deletion confirmation
    - _Requirements: 22.3, 22.4, 22.5, 22.6, 22.7_
  - [ ]* 23.7 Write property test for status rules
    - **Property 30: Status rules hold under all operation sequences**
    - **Validates: Requirements 5.3, 5.4, 5.9, 8.2, 8.4, 8.6, 8.7**
  - [ ]* 23.8 Write property test for history reconstruction
    - **Property 33: History reconstructs every past state**
    - **Validates: Requirements 11.8, 22.1, 22.3, 22.6, 39.8, 41.6, 42.7**
  - [ ]* 23.9 Write property test for Restoration
    - **Property 34: Restoration changes only content fields**
    - **Validates: Requirements 22.5, 23.15, 41.14, 42.5**
  - [ ]* 23.10 Write property test for comparisons
    - **Property 35: Comparisons mark exactly the changed words**
    - **Validates: Requirements 22.4, 42.9**

- [ ] 24. Build discussion and Review_Requests
  - [ ] 24.1 Implement Topics, Replies, and Threads in `apps/app/src/discussion/replies.ts`, `apps/app/src/api/routes/discussion.ts`, and `packages/domain/src/thread.ts`
    - `POST /topics` and `POST /replies` with a Parent that is a Research_Item, an Attachment, or a Reply at any depth, withdrawn or not
    - Pure `buildThread(replies)`: each Reply under its Parent, siblings oldest first by posting time, the Group_Note first, and placeholders for deleted Replies
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.9, 16.10, 41.7_
  - [ ] 24.2 Implement Mention detection in `apps/app/src/discussion/mentions.ts`
    - Compare the Mention spans of the previously saved and the newly saved text of Research_Item fields, Entry_Sections, and Replies; return newly mentioned active Members, plus active holders of newly mentioned Specialties not already included, without the author
    - _Requirements: 16.6, 16.7, 16.8_
  - [ ] 24.3 Implement Review_Requests in `apps/app/src/reviews/reviews.ts` and `apps/app/src/api/routes/reviews.ts`
    - `POST /reviews` within a Submission or later, with addressees (active Members, non-retired Specialties, Roles, each once) and an optional note; refusal without an Eligible_Reviewer keeps the Submission unsubmitted
    - `POST /reviews/{id}/complete` by an Eligible_Reviewer on a Needs_Review request with an optional note; refusals state the reason; Publication_Requests cannot be completed this way; `GET /reviews/queue` oldest first; item responses list every request of the Item and its Entry_Sections and carry the pending-review marker, which no public view has
    - _Requirements: 3.8, 17.1, 17.2, 17.3, 17.5, 17.7, 17.8, 17.9, 17.10, 17.11_
  - [ ] 24.4 Build the discussion and review screens in `apps/app/web/src/discussion/` and `apps/app/web/src/reviews/`
    - Thread tree, reply composer with Mentions, Topic form, review request form, review queue, the item page's request list, and the pending-review marker
    - _Requirements: 16.4, 17.7, 17.8, 17.11_
  - [ ]* 24.5 Write property test for Threads
    - **Property 47: Threads are trees in posting order**
    - **Validates: Requirements 16.3, 16.4, 41.7**

- [ ] 25. Build the Activity_Service: flags, views, badges, and the Activity_Feed
  - [ ] 25.1 Implement New_Flags in `apps/app/src/activity/flags.ts`
    - The batch that completes a Submission inserts a `new` flag on each of its Items for every other Member who is Active or Pending and whose account was created before completion, with `INSERT … SELECT`
    - _Requirements: 18.1, 18.2, 18.6_
  - [ ] 25.2 Implement Updated_Flags in `apps/app/src/activity/flags.ts`
    - A Correction, Withdrawal, or Status_Change on an Item or one of its Entry_Sections inserts an `updated` flag for every other active Member with a `views` row for the Item, in the batch of the Revision
    - _Requirements: 18.4_
  - [ ] 25.3 Implement views and flag clearing in `apps/app/src/api/routes/views.ts`
    - `POST /views` deletes the viewer's flags on the given units and upserts `views`; the SPA calls it only when a Research_Item page opens, an Attachment opens or downloads, or a page shows a Reply, and a failed call leaves the page displayed and the flags in place
    - _Requirements: 18.3, 18.12_
  - [ ] 25.4 Implement the Activity_Feed in `apps/app/src/activity/feed.ts` and `apps/app/src/api/routes/feed.ts`
    - One `activity` row per Submission, Correction, Withdrawal, Status_Change, and Disclosure_Change, with up to 10 Item references or per-kind counts, and `activity_tags` for Root_Item kinds and Projects
    - `GET /feed` in keyset pages of 50 with filters by kind, acting Member, the acting Member's current Specialty, an inclusive date range in the viewer's time zone, and Project; the feed-open time; `POST /feed/mark-seen` clearing flags on matching entries' Items set no later than that time
    - Muted_Projects never change flags or which feed entries a Member sees
    - _Requirements: 18.5, 18.8, 18.9, 39.14, 39.17_
  - [ ] 25.5 Implement badge counts in `GET /me/badges`
    - Counts of the viewer's flags per Research_Item kind, Attachment, and Reply over units that are not deleted, in one indexed query
    - _Requirements: 18.7_
  - [ ] 25.6 Build the activity screens in `apps/app/web/src/activity/`
    - Badge counts on every page, new and updated marks in listings, search results, Threads, and Attachment lists as the flags stood when the page opened, and the feed page with filters and "mark all as seen"
    - _Requirements: 16.4, 18.5, 18.7, 18.8, 18.10_
  - [ ]* 25.7 Write property test for New_Flags
    - **Property 49: New_Flags mark exactly the unseen Items of others' Submissions**
    - **Validates: Requirements 18.1, 18.3, 18.6, 39.17**
  - [ ]* 25.8 Write property test for Updated_Flags
    - **Property 50: Updated_Flags mark changes after a view**
    - **Validates: Requirements 18.4**
  - [ ]* 25.9 Write property test for Submission visibility
    - **Property 51: Submissions become visible all at once**
    - **Validates: Requirements 18.2, 18.11**
  - [ ]* 25.10 Write property test for mark-all-seen
    - **Property 53: Mark-all-seen clears exactly the matching, older flags**
    - **Validates: Requirements 18.5**

- [ ] 26. Build the Notification_Service
  - [ ] 26.1 Implement the event fan-out in `apps/app/src/notifications/fanout.ts`
    - One rule per Event_Type from the design's table, written with `INSERT … SELECT` in the batch of the causing action: New_Submission, Item_Update (Owner and Thread posters), the Administrator Item_Updates for automatic downgrades and for a non-Administrator's save that alters a Public_View, Reply, Mention (from task 24.2), Review_Requested, Review_Completed, and System_Alert; rules for Outside_Submission, Reminder, and Dissent events are added by the tasks that introduce them
    - The acting Member is excluded except for System_Alerts; Muted_Projects remove only New_Submission, Reply, and ordinary Item_Update events; each event stores the recipient's email mode at creation
    - _Requirements: 9.6, 16.6, 16.7, 17.4, 17.6, 19.1, 19.2, 19.3, 19.4, 19.8, 23.13, 34.3, 39.9_
  - [ ] 26.2 Implement Notifications and the Notification_Centre in `apps/app/src/notifications/centre.ts` and `apps/app/src/api/routes/notifications.ts`
    - All events that one Submission causes for one recipient with in-app On form one Notification, added in the same batch; `GET /notifications` newest first with Event_Types, actor, time, read state, and what it concerns; `POST /notifications/{id}/read`; deleted Root_Items shown by kind and the Deletion record's time and reason; Group_Note indication; the unread count added to `GET /me/badges`
    - _Requirements: 19.5, 19.6, 19.7, 19.11, 19.12, 19.13, 41.11_
  - [ ] 26.3 Implement Follow_Up_Due Reminders in `apps/app/src/notifications/reminders.ts`
    - The hourly sweep creates a Reminder for the Owner within 24 hours after an Archival_Request becomes Follow_Up_Due in the Owner's time zone, and again after each further Follow_Up_Interval
    - _Requirements: 10.3, 10.4_
  - [ ] 26.4 Build the notification screens in `apps/app/web/src/notifications/`
    - The Notification_Centre, the unread count on every Workspace page, and opening a Notification at its Root_Item, its list of Root_Items, or the Group_Note scrolled into view
    - _Requirements: 19.7, 19.11, 19.12, 41.10_
  - [ ]* 26.5 Write property test for Mentions
    - **Property 40: Mentions are explicit and notify once**
    - **Validates: Requirements 16.6, 16.7, 16.8**
  - [ ]* 26.6 Write property test for counts
    - **Property 52: Counts match flags and Notifications**
    - **Validates: Requirements 18.7, 19.12**
  - [ ]* 26.7 Write property test for Notification grouping
    - **Property 55: One Notification per Submission per recipient**
    - **Validates: Requirements 19.6**

- [ ] 27. Build the Mailer and email pipeline
  - [ ] 27.1 Implement the email templates in `packages/public-render/src/email/`
    - Plain-text-first structure with an HTML version from the Design_System email components using only token typefaces and colours; sender name ResearchForce; subjects starting with "ResearchForce:"; every link's visible text is its full address; a Notification_Preferences link in every Member email
    - Items described only by their current Public_View, kind, Event_Type, actor display name, and time in the recipient's zone, with `https://app.researchforce.org/go/{ref}` login links; Outside_Submissions by Event_Type, Submission_Type, time, and days since receipt for Reminders; Elimination_Scope after Eliminated statuses; Group_Note links and views; Log_Summaries followed by their Dissent_Notes' views
    - Register the email outputs in `packages/testing/src/public-channels.ts`
    - _Requirements: 8.3, 20.6, 20.7, 41.12, 42.15, 45.21_
  - [ ] 27.2 Implement batching in `apps/app/src/mail/batching.ts`
    - Group keys `root:`, `sub:`, `os:`, and `alert`; a window starts at the first event and copies the Email_Batch_Window length in force; events after the window end open a new batch; closed batches are queued within 2 minutes of the window end
    - _Requirements: 20.1, 20.2, 20.3, 20.12_
  - [ ] 27.3 Implement Daily_Digests in `apps/app/src/mail/digest.ts`
    - A quarter-hour check finds Members whose local digest hour has passed since their last digest and queues one email of their unlisted Daily_Digest events from before that hour, grouped by Root_Item, or nothing when none qualifies
    - _Requirements: 20.4, 20.5, 20.13_
  - [ ] 27.4 Implement the `Mailer` Durable Object in `apps/app/src/do/mailer.ts`
    - One sending queue for invitations, notification emails, and Submitter emails, oldest first; an attempt log enforcing at most 30 attempts per 60 seconds and the Recipient_Cap in force over 24 hours, holding emails until both allow; the recipient of a notification email must be an active Member at each attempt; composition from the current Public_Views at send time; the configured provider read at each attempt
    - Retries at about 2, 10, 25, and 50 minutes, honouring `Retry-After` on 429; after the final failure a System_Alert for every Administrator unless the email held only System_Alerts; a failed invitation sets `invite_email_state` until a later invitation succeeds; queue time recorded so time limits exclude it
    - _Requirements: 2.1, 2.14, 20.8, 20.9, 20.10, 20.11, 20.15, 20.16, 20.17, 20.18_
  - [ ] 27.5 Implement the Microsoft Graph provider in `apps/app/src/mail/providers/graph.ts`
    - The `send(message)` Email_Provider interface; client-credentials tokens from `login.microsoftonline.com` with a certificate assertion signed by WebCrypto, held only in the `Mailer` instance's memory; `POST /v1.0/users/{Sending_Address}/sendMail` with one recipient, an HTML body, and `saveToSentItems: false`; `BODY_MODE = 'html-with-exchange-conversion'` as the one place the plain-text strategy is chosen; credentials, tokens, and Graph responses never logged or stored
    - _Requirements: 20.11, 20.19, 20.20, 20.21, 20.22, 20.24, 45.21_
  - [ ]* 27.6 Write property test for companion fields
    - **Property 9: Companion fields are rendered together**
    - **Validates: Requirements 5.6, 5.10, 6.3, 7.4, 8.3, 29.2, 29.3, 29.4, 43.3**
  - [ ]* 27.7 Write property test for email batching
    - **Property 56: Email batching partitions events correctly**
    - **Validates: Requirements 20.1, 20.2, 20.3, 20.12**
  - [ ]* 27.8 Write property test for Daily_Digests
    - **Property 57: Daily_Digests list each event once**
    - **Validates: Requirements 20.4, 20.5**
  - [ ]* 27.9 Write property test for the sending queue
    - **Property 58: The sending queue respects every limit**
    - **Validates: Requirements 20.8, 20.9, 20.10, 20.15, 20.16, 20.17, 20.18, 32.11, 32.12**
  - [ ]* 27.10 Write property test for email branding
    - **Property 59: Emails carry the brand and full-address links**
    - **Validates: Requirements 20.7, 45.21**
  - [ ]* 27.11 Write integration tests for the Mailer with a mocked Graph endpoint
    - 429 and 5xx retries, a provider change between attempts, the invitation-failure state, and a request body with `saveToSentItems: false` and one recipient
    - _Requirements: 2.14, 20.9, 20.11, 20.24_

- [ ] 28. Build Member search
  - [ ] 28.1 Implement the search indexer in `apps/app/src/search/indexer.ts`
    - A permanent `Jobs` instance named `indexer` draining the `search` outbox topic within seconds; one document per Item and Entry_Section, with Research_Item free-text and name fields, Attachment title, Item_Identifier, caption, Origin, and file name (never file contents), Dissent_Note documents pointing at their Research_Item with author and withdrawal marker, withdrawn and superseded markers, incomplete Submissions flagged, deleted Items removed, and creation sort keys
    - _Requirements: 21.1, 21.5, 21.6, 42.13_
  - [ ] 28.2 Implement queries in `apps/app/src/search/query.ts` and `GET /search`
    - Shared validation; FTS5 expressions with `"word"*` terms, quoted phrases, and "ß"/"ss" expansion capped at 16 alternatives; own-title matches first, then the rest, newest first, in pages of 20; filters by root kind, Credit person, current Specialty holders, own Disclosure_Level, Projects, and an inclusive creation date range in the viewer's zone
    - Results with kind, title (the Root_Item's for sections and Replies), Credit, creation date, markers, Disclosure_Level and Effective_Disclosure, Project name, and excerpts of at most 300 characters located in the stored text with their labels and highlighted terms; Dissent_Note matches marked with the author; "no result matched" when empty
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 21.7, 21.8, 21.9, 23.9, 39.14, 39.15, 42.13_
  - [ ] 28.3 Build the search screen in `apps/app/web/src/search/`
    - Query form and filters; after 10 seconds without a response, "search is unavailable", with the 00:00 UTC note for daily limits; query and filters kept as entered
    - _Requirements: 21.9, 21.10_
  - [ ]* 28.4 Write property test for Member search
    - **Property 60: Member search returns exactly the matching units**
    - **Validates: Requirements 21.1, 21.3, 21.4, 21.5, 21.8, 42.13**
  - [ ]* 28.5 Write property test for search excerpts
    - **Property 61: Search excerpts are bounded, highlighted, and labelled**
    - **Validates: Requirements 21.7, 30.5, 30.13**

- [ ] 29. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 30. Build files: uploads, Attachments, versions, previews, Download_Links, and `rf-dl`
  - [ ] 30.1 Implement uploads in `apps/app/src/files/uploads.ts` and `apps/app/src/api/routes/uploads.ts`
    - `POST /uploads` with name, size, and browser-computed SHA-256, refusing files above the Attachment_Size_Limit and the 101st file of a Submission before any transfer, naming the file and the limit
    - SigV4 presigned PUT URLs to `rf-private` signing `content-length` and `x-amz-checksum-sha256` for files up to 64 MiB, and multipart uploads with 16 MiB parts each signing its SHA-256 (`POST /uploads/{id}/parts`); `POST /uploads/{id}/complete` compares the stored size and checksum with the declared values; no file content passes through a Worker request body
    - _Requirements: 12.4, 12.5, 12.9, 12.10_
  - [ ] 30.2 Implement Attachments in Submissions in `apps/app/src/files/attachments.ts`
    - One Attachment per completed file on a Research_Item or Reply that the Submission adds or that already exists, with title (default the file name), file kind, original file name preserved exactly, size, Credit, caption, Origin, and upload completion time; rights fields with limits, Unknown by default, or copied from a Source Parent with Unknown in place of a retired value
    - Hourly sweep deleting objects of uploads started more than 24 hours earlier that belong to no completed Submission
    - _Requirements: 6.4, 7.3, 12.1, 12.2, 12.8, 16.5, 33.1, 33.2, 33.3_
  - [ ] 30.3 Implement Attachment versions in `apps/app/src/files/versions.ts`
    - A new version is a new Attachment on the same Parent with `supersedes_unit_id`, last in the Version_Chain, Private, with Rights_Status Unknown; the `chain_tip` guard refuses a version of a superseded Attachment and names the last version so the dialog can offer it; adding a version needs edit Permission on the target; the superseded Attachment stays unchanged and usable
    - Chain data for every Attachment (positions from 1, upload time, Owner, viewed and last marks) and supersession notices with the successor's upload time and link
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8_
  - [ ] 30.4 Implement Download_Link issue in `apps/app/src/files/links.ts` and `POST /files/{id}/link`
    - Tokens `base64url(objectKey, memberId, issuedAt, purpose)` with an HMAC-SHA-256 under a Workers secret, issued only to active Members, at `https://dl.researchforce.org/t/{token}` for files and `/x/{token}` for package volumes
    - _Requirements: 14.9, 25.1, 25.5_
  - [ ] 30.5 Implement the `rf-dl` Worker in `apps/dl/src/index.ts`
    - Accept a token only with a valid signature, at most 15 minutes after issue, for an Active Member at request time, and for an Administrator when the purpose is an Internal_Backup; support `Range` and `HEAD`; serve with `Content-Disposition: attachment`, `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cross-Origin-Resource-Policy: same-site`, and CORS limited to the Workspace origin
    - Every refusal returns the same 404 response as an unknown path; register `rf-dl` responses to non-Members in `packages/testing/src/public-channels.ts`
    - _Requirements: 14.6, 25.1, 25.2, 25.5, 25.6, 35.9, 36.2_
  - [ ] 30.6 Build the upload screen in `apps/app/web/src/files/upload.tsx`
    - SHA-256 and per-part hashes in a Web Worker; per-file progress as a whole-number percentage refreshed at least once per second; a file fails after 60 seconds without progress, an R2 error, a check mismatch, or sweeper removal, and can be retried any number of times or removed without losing the rest; the Submit button stays disabled with reasons while any file is uploading, failed, or has invalid metadata
    - _Requirements: 12.6, 12.7, 12.11_
  - [ ] 30.7 Build the inline previews in `apps/app/web/src/files/preview/`
    - Bytes fetched through a Download_Link; pdf.js with scripting and `eval` off, page n of N, previous, next, and go-to-page; JPEG, PNG, GIF, and WebP from typed `blob:` URLs, fitted, with zoom to 400% and keyboard and pointer panning; the first 1 MB of text logs with "showing X of Y"; CSV through Papa Parse with the header and 1,000 rows, the row count, and whether more rows exist
    - Magic-byte checks; notices naming the cause for damaged, password-protected, mismatched, or unavailable files while metadata and download stay available; renderings only in the browser's memory; pure `previewText` and `previewCsv` helpers in `truncate.ts`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.9_
  - [ ] 30.8 Build the Attachment screens in `apps/app/web/src/files/attachment-page.tsx`
    - Metadata, Origin, rights with whether the Rights_Status permits publication, download link, preview, Version_Chain list, and supersession notices on the Attachment and wherever a Cross_Link or Backlink shows a superseded Attachment
    - _Requirements: 13.4, 13.6, 14.5, 33.7_
  - [ ]* 30.9 Write property test for Version_Chains
    - **Property 43: Version_Chains stay linear**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4, 13.7**
  - [ ]* 30.10 Write property test for Download_Links
    - **Property 45: Download_Links authorize one file for 15 minutes**
    - **Validates: Requirements 25.1, 25.5, 35.9, 36.2**
  - [ ]* 30.11 Write property test for preview truncation
    - **Property 46: Previews truncate exactly**
    - **Validates: Requirements 14.3, 14.4**
  - [ ]* 30.12 Write integration tests for uploads
    - Local R2 refuses a part or object with a wrong checksum; completion with a mismatched size fails the file; the sweep deletes only abandoned uploads
    - _Requirements: 12.7, 12.8, 12.10_

- [ ] 31. Build disclosure changes, previews, classification, Publication_Requests, rights and consent rules, and item moves
  - [ ] 31.1 Implement projection input loading and the preview API in `apps/app/src/kernel-input.ts` and `apps/app/src/disclosure/preview.ts`
    - `loadProjectionInput(roots)`, the only code that turns `rf-core` rows into kernel input, including Parties, Do_Not_Name flags, registered Member emails, consent, rights, Licence_Agreements, and Cross_Link neighbours
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
    - _Requirements: 17.5, 23.10, 23.11, 23.12, 34.2_
  - [ ] 31.5 Implement the rights and consent rules in `apps/app/src/disclosure/rights.ts`
    - A save that sets a non-permitting Rights_Status on a Public Attachment makes it Withheld in the same batch with a Disclosure_Line of only file kind and upload date, a Disclosure_Change by the saving Member, and an Administrator Item_Update; marking a Rights_Status value as not permitting shows the count of affected Public Attachments, then downgrades them all in one batch with a Disclosure_Change each and one Item_Update per Administrator listing them
    - Making an Attachment Public with a non-permitting Rights_Status, or a Correspondence Public while any consent is not Granted, is refused with Withheld offered; turning Do_Not_Name off goes through the preview
    - _Requirements: 33.4, 33.5, 33.8, 34.2, 34.6, 34.9_
  - [ ] 31.6 Implement item moves in `apps/app/src/records/move.ts` and `POST /items/{id}/move`
    - Update `project_id` on the Research_Item and every element under it in one statement, leaving everything else unchanged, and record a Revision holding the previous Project (Disclosure_Change when a Public_View changes, Minor_Edit otherwise); a move that alters a Public_View needs a confirmed, fresh preview
    - _Requirements: 23.3, 39.12, 39.13_
  - [ ] 31.7 Build the disclosure screens in `apps/app/web/src/disclosure/`
    - The disclosure dialog with the preview (changed views, Party names, Dissent_Notes that will not be Public, Licence_Agreement states, gate failures with Withheld offers), set selection up to 1,000 units, the Public_Summary editor pre-filled from the Log_Summary when empty or from a Publication_Request being applied, the Unclassified list, the public overview, Publication_Request apply and decline, the move dialog, and Consent_Status, Do_Not_Name, and Generic_Label on Correspondence pages and previews
    - _Requirements: 23.6, 23.8, 23.11, 23.12, 26.8, 34.7, 41.13_
  - [ ] 31.8 Write property test for independent Disclosure_Levels
    - **Property 2: Own Disclosure_Levels are independent of ancestors**
    - **Validates: Requirements 4.8, 9.3, 23.3, 39.12**
  - [ ] 31.9 Write property test for Unclassified units
    - **Property 4: Unclassified units stay Private and classification is selective**
    - **Validates: Requirements 26.5, 26.6, 26.7**
  - [ ] 31.10 Write property test for publication gates
    - **Property 12: Publication gates reject the whole change**
    - **Validates: Requirements 23.5, 23.14, 26.7, 26.14, 33.4, 34.2, 46.17**
  - [ ] 31.11 Write property test for rights and consent invariants
    - **Property 13: Rights and consent invariants hold after every save**
    - **Validates: Requirements 9.6, 33.3, 33.5, 33.8, 34.1, 34.3**
  - [ ]* 31.12 Write property test for public addresses
    - **Property 19: Public addresses are stable and content-free**
    - **Validates: Requirements 29.6, 29.7, 29.8, 39.6, 40.3, 40.8**
  - [ ]* 31.13 Write property test for the Review_Request state machine
    - **Property 48: Review_Requests follow their state machine**
    - **Validates: Requirements 17.3, 17.4, 17.5, 17.8, 17.9, 17.10**
  - [ ]* 31.14 Write property test for item moves
    - **Property 77: Moving a Research_Item changes only its Project**
    - **Validates: Requirements 39.1, 39.12**
  - [ ]* 31.15 Write property test for Log_Summary rules
    - **Property 79: Log_Summary rules**
    - **Validates: Requirements 41.1, 41.2, 41.5, 41.13**

- [ ] 32. Build the Publisher and the public site deployment
  - [ ] 32.1 Implement the `rf-ops` site deployment in `apps/ops/src/deploy.ts`
    - `deploySite(manifest)`: start a Direct Upload session with the manifest of paths, hashes, and sizes, upload only the files the platform reports missing (resuming across invocations while the upload token is valid), create an assets-only `rf-site` version with `html_handling: auto-trailing-slash` and `not_found_handling: 404-page`, and deploy it to 100%
    - _Requirements: 24.7, 24.11, 24.12, 28.6, 28.16_
  - [ ] 32.2 Implement the Publisher projection step in `apps/app/src/do/publisher.ts`
    - Dirty scopes from the `publish` outbox topic (`unit`, `root`, `project`, `party`, `member`, `emails`, `value`, `policy`, `site`) expanded to root keys; one run at a time; slices of at most about 500 KB of text that compute views, compare hashes with the current versions in `rf-public`, write new versions, and close old ones; Private units get their version closed and no new row; closed versions older than 30 days pruned unless an export in progress started before them
    - _Requirements: 24.11, 24.12, 34.6, 46.7, 46.34_
  - [ ] 32.3 Implement planning and rendering in `apps/app/src/publisher/plan.ts` and `apps/app/src/publisher/render.ts`
    - Map changed views to every affected output (unit, Parent, and root pages; every page of affected listings, Project_Logs, and Disclosure_Line listings; Project, home, and projects pages; People and Policy pages; search index files; file operations), render with `public-render` and `search-public`, include the `site-shell` build, `robots.txt`, `sitemap.xml`, and `_headers`, hash each file as the Direct Upload API specifies, store new content under `rf-private/build/{hash}`, and keep the manifest in `rf-public.site_files`; alert at 16,000 files
    - No file is rendered for a Private Project's addresses or for any address of a Withheld Project other than its page, so those addresses get the same `404.html` as unknown ones; Policy_Pages, metadata, print styles, fonts, scripts, and images ship only as static assets
    - _Requirements: 24.1, 24.2, 24.4, 24.5, 28.16, 29.1, 30.7, 30.8, 40.4, 40.9, 40.10, 45.4_
  - [ ] 32.4 Implement public file copies in `apps/app/src/publisher/files.ts`
    - Copy an Attachment that becomes Public to `rf-public` at `f/{Item_Identifier}` with a server-side `CopyObject` before any page links to it, with a content type from the file kind (`application/octet-stream` for script-capable types) and `Content-Disposition` naming `{Item_Identifier}.{ext}`; delete copies first for removals and retry failed deletions each slice
    - _Requirements: 24.3, 25.2, 25.3, 25.4, 28.6_
  - [ ] 32.5 Implement urgency, deployment, and verification in `apps/app/src/publisher/deploy.ts`
    - A run is urgent when any existing view changed or disappeared and deploys as soon as its slices finish; add-only runs wait for 30 seconds without new changes and at most 5 minutes
    - After an urgent deploy, `HEAD` every removed page and file address and expect the not-found response; a removal not confirmed 5 minutes after its save raises a System_Alert naming the unit within one more minute; a "publication lag" System_Alert at 4 minutes; a System_Alert for kernel invariant breaches; no processing while a restore runs, then a full rebuild
    - _Requirements: 24.11, 24.12, 25.3, 25.7, 30.7, 30.8, 36.9, 42.8, 46.30, 46.38_
  - [ ] 32.6 Write property test for Publisher convergence
    - **Property 15: Publisher convergence**
    - **Validates: Requirements 24.1, 24.2, 24.4, 24.11, 24.12, 25.2, 25.3, 29.1, 30.7, 30.8, 36.9, 40.4, 46.7, 46.30**
  - [ ]* 32.7 Write integration tests for publication timing and alerts
    - A stubbed `HEAD` that keeps answering 200 raises the System_Alert of Requirement 25.7; urgent runs deploy before add-only runs; a restore in progress pauses the Publisher
    - _Requirements: 24.11, 25.7, 36.9_

- [ ] 33. Checkpoint - Ensure all tests pass
  - Run `npm test` (`vitest --run`) and `npm run lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 34. Build the `Budget` Durable Object and the public submission API in `rf-submit`
  - [ ] 34.1 Implement the `Budget` Durable Object in `apps/app/src/do/budget.ts` and `apps/app/src/budget/status.ts`
    - Per-UTC-day counters of Public_Traffic requests, rows read, and rows written with `admit()` and `report(rows)`; when a counter reaches the Public_Traffic_Budget minus a 2% margin, refuse further public requests with a fixed "unavailable until 00:00 UTC" response that uses no D1 query, ask `rf-ops` to enable the WAF block rule for `submit.researchforce.org`, and rewrite `files.researchforce.org/status.json`; `PUBLIC_SEARCH_FOLLOWS_BUDGET = true` in `status.ts` is the one place that decides whether search is marked unavailable
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
    - Both scripts read `status.json` and replace the form or search with the "unavailable until 00:00 UTC" notice when it says so
    - _Requirements: 28.10, 28.11, 31.1, 31.10, 31.11, 31.13, 45.5, 45.18_
  - [ ]* 34.6 Write property test for Outside_Submission limits
    - **Property 88: Outside_Submission limits**
    - **Validates: Requirements 31.4, 31.12**

- [ ] 35. Build the Moderation_Service
  - [ ] 35.1 Implement the Moderation_Queue API in `apps/app/src/moderation/queue.ts` and `apps/app/src/api/routes/moderation.ts`
    - `GET /moderation` for active Members only, with Submission_Reference, type, Project or General_Choice, state, text, Submitter details, files, referenced page, receipt time, and for Corrections and Removal_Requests the receipt date and the Response_Target end date (receipt plus 14 days) in the viewer's zone with an overdue mark while undecided; no network address appears; Project filters
    - _Requirements: 2.8, 32.1, 32.2, 32.17, 39.14, 46.20, 46.24_
  - [ ] 35.2 Implement Moderation_Decisions in `apps/app/src/moderation/decide.ts`
    - Every decision returns the exact email text first and applies only after confirmation; messages and reasons up to 5,000 characters; the `decision_open` guard refuses a decision after an Accepted or Rejected one and shows the recorded decision; decision rows are never changed and record Administrator, time, text, and created Items; emails go only to the address in that Outside_Submission
    - Accept for Material, Correction, or Comment creates the selected Items (at least one; Research_Items with Log_Summaries, Replies, or Attachments on existing or newly created Parents), credited to the Submitter's name and affiliation, Private and Unclassified, in the Outside_Submission's Project unless another is chosen (a choice is required for the General_Choice), all-or-nothing, as one Submission by the accepting Administrator
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
    - **Property 7: Private and nonexistent are indistinguishable**
    - **Validates: Requirements 24.7, 25.6, 31.6, 31.14, 40.10**
  - [ ]* 35.8 Write property test for Project choice
    - **Property 78: Project choice and preselection**
    - **Validates: Requirements 31.13, 32.18, 39.2, 39.3**
  - [ ]* 35.9 Write property test for Response_Links
    - **Property 89: Response_Link validity**
    - **Validates: Requirements 32.14**
  - [ ]* 35.10 Write property test for Moderation_Decisions
    - **Property 90: Moderation decisions are final, credited, and append-only**
    - **Validates: Requirements 32.4, 32.13, 32.16, 46.23**
  - [ ]* 35.11 Write integration tests for moderation flows
    - Acceptance creates one Submission with flags and New_Submission events; More_Information_Requested emails a Response_Link; decisions apply only after confirmation; rejection schedules file deletion and email erasure
    - _Requirements: 32.5, 32.6, 32.8, 32.9, 32.10_

- [ ] 36. Build the journal and attachment migration service
  - [ ] 36.1 Implement the journal import job in `apps/app/src/jobs/journal-import.ts` and `POST /imports/journal`
    - The server re-validates every parsed entry it receives; a `Jobs` object commits one Journal_Entry with all its Entry_Sections per batch in the P1030680 Project, with phase identifier, dates, and Campaign_Status where the journal states them, Owner the importing Administrator, every unit Private and Unclassified, and no Findings or labels
    - Re-imports skip entries matched by phase identifier or the `front-matter` key and leave them unchanged; at the end one Activity_Feed entry with the counts, no New_Flags, and no Notification_Events; the import report (created, skipped, and failed entries and files with reasons, the Journal_Printer output as a downloadable Markdown file, the comparison result, and failing entries with titles and line ranges) is stored under `rf-private/imports/{job}/`
    - _Requirements: 26.1, 26.4, 26.9, 26.10, 26.11, 26.13, 27.4, 27.8_
  - [ ] 36.2 Implement the attachment import in `apps/app/src/jobs/journal-import.ts`
    - Verify each stored file's size and checksum against the source values before creating its Attachment; Parent from `resolveAttachmentParent`; keep title, original file name, file kind, size label, caption, and Origin (or the fixed text "No origin recorded in the source journal", flagged in the report); Credit from the crediting contributor; Rights_Status Unknown; skip files matched by original file name
    - A file that no entry references, that cannot be read or stored, or whose copy mismatches gets no Attachment, has any stored copy deleted, and is listed as failed with the reason
    - _Requirements: 26.2, 26.3, 26.10, 26.12_
  - [ ] 36.3 Build the journal import screen in `apps/app/web/src/imports/journal.tsx`
    - Select the journal file, the attachment folder, and the metadata JSON; parse, print, and compare in a Web Worker; show the report preview (entries, sections, unassigned spans, attachments with Parents, unreferenced files); hash and upload the files; start the job and show progress and the report
    - _Requirements: 26.1, 26.3, 26.11, 27.7, 27.8_
  - [ ]* 36.4 Write integration tests for the journal import
    - The import sets no flags and creates no events but adds one feed entry; an interrupted import leaves no partial Journal_Entry and resumes; a re-import skips everything
    - _Requirements: 26.9, 26.10, 26.13_

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
  - [ ]* 37.4 Write property test for manifest parsing and validation
    - **Property 69: Manifest parsing is exact and validation is complete**
    - **Validates: Requirements 33.10, 37.1, 37.2, 37.3, 37.8, 37.16, 38.1, 38.2, 38.3, 38.6, 38.7, 38.9**
  - [ ] 37.5 Implement Bulk_Import validation in `apps/app/src/jobs/bulk-validate.ts`
    - Re-run the parser and row rules on the server, then check Party, archive or desk, and contact names against at most one Member or External_Party; files that exist, are named by one row only, and fit the Attachment_Size_Limit; version marks without branches or cycles that name only the row's files; kind-specific columns filled for the row's kind and empty otherwise, with the date column empty for Findings, Hypotheses, and Topics; each row's values against the kind's schema with the Log_Summary checked only for length; an Origin of 1 to 5,000 characters for rows with files
    - Any error creates no Item and the report lists every error with row, column, file name, and reason; folder files that no row names are listed as not imported without being errors
    - _Requirements: 33.10, 37.2, 37.3, 37.4, 37.8, 37.16_
  - [ ] 37.6 Implement the Bulk_Import job in `apps/app/src/jobs/bulk-import.ts` and `POST /imports/bulk`
    - In the chosen Project, one batch per row: a Research_Item of the row's kind (Findings and Hypotheses Open) with the mapped values, an Attachment per file with the row's Origin, caption, Credit, and rights, the row's rights on a Source, Parties linked by name or created as External_Parties, and Version_Chains in the declared order; every unit Private and Unclassified
    - A Row_Key already used by an earlier or concurrent Bulk_Import skips the row through the unique index; a file that fails to store or match fails the whole row; writes are metered against the daily import allowance and the job pauses until the next UTC day when it is used
    - The final step writes New_Flags and New_Submission events in chunks and sets the Submission complete in one statement; the report lists created, skipped, and failed rows and Attachments with row number, Row_Key, and reason
    - _Requirements: 33.9, 37.5, 37.6, 37.7, 37.9, 37.10, 37.11, 37.12, 37.13, 37.14, 37.15, 37.17, 37.18_
  - [ ] 37.7 Build the Bulk_Import screen in `apps/app/web/src/imports/bulk.tsx`
    - Choose the Project, select the manifest and folder, show the browser-side validation report, hash and upload the files, start the job, and show progress and the report
    - _Requirements: 37.3, 37.11, 37.17_
  - [ ]* 37.8 Write property test for import idempotency and mapping
    - **Property 70: Imports are idempotent and map rows and files correctly**
    - **Validates: Requirements 26.2, 26.10, 26.12, 33.9, 37.6, 37.7, 37.12, 37.15, 37.18**
  - [ ]* 37.9 Write property test for import reports
    - **Property 71: Import reports account for every input**
    - **Validates: Requirements 26.11, 37.4, 37.11**
  - [ ]* 37.10 Write property test for atomic saves
    - **Property 28: Saves are all-or-nothing**
    - **Validates: Requirements 4.1, 4.5, 26.13, 28.13, 32.15, 37.13**
  - [ ]* 37.11 Write property test for budget gates
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
    - `FREEZE` constants and the `frozen` guard added as the first statement of every write batch in `packages/db/src/batch.ts`; while frozen, saves answer `frozen`; read the backed-up tables in keyset pages of about 1,000 rows into JSON Lines under `rf-private/backups/{id}/`, then lift the freeze and copy the files
    - Back up Projects with slug, featured flag, position, accent, and level, units and kind tables, labels, Revisions, Cross_Links, Review_Requests, Outside_Submissions with decisions, External_Parties, Members with Role and status, Profiles, value sets with Public_Descriptions, settings including the Responsible_Person, and Policy_Sections with Revisions; leave out flags, views, Notifications, events, email batches, sessions, outbox, staging, and network-address counters
    - Mark a backup incomplete when an element is missing, it takes over 24 hours, or a file mismatches, and report this to the requester; deliver only to Administrators; delete every file within 1 hour once 7 days old; Reminders for every Administrator at each 30-day multiple since the latest complete, fully downloaded backup, or since the first Item
    - _Requirements: 28.8, 36.1, 36.2, 36.3, 36.6, 36.7, 36.11_
  - [ ] 38.5 Implement restore in `apps/app/src/jobs/restore.ts` and `POST /restores`
    - Accept a backup still in R2 or an uploaded package whose files the browser verified; refuse before any change when the package is not an Internal_Backup, the system is not empty, or a manifest file is missing or mismatched, reporting each reason
    - Insert rows in dependency order with original ids, Item_Identifiers, levels, classification states, and Revisions using `INSERT OR IGNORE` and per-table cursors, so a stopped restore resumes without duplicates and reports created and remaining counts; copy files to their original keys; replace the seeded Policy_Sections; set no flags and create no events; keep the Publisher paused until completion, then rebuild `rf-search`, `rf-public`, and the site
    - _Requirements: 36.4, 36.5, 36.8, 36.9, 36.10, 36.11_
  - [ ] 38.6 Build the export and backup screens in `apps/app/web/src/exports/`
    - Request an export with its scope; list exports with state, staleness labels, missing files, and deletion offers; Download_Links for volumes; backups and restores for Administrators only, with browser-side hashing of uploaded packages
    - _Requirements: 35.7, 35.9, 35.10, 36.2, 36.8_
  - [ ]* 38.7 Write property test for Item_Identifiers
    - **Property 41: Item_Identifiers are well-formed, unique, and never reused**
    - **Validates: Requirements 15.1, 15.6**
  - [ ]* 38.8 Write property test for the export JSON round trip
    - **Property 72: Export JSON round trip**
    - **Validates: Requirements 35.4**
  - [ ]* 38.9 Write property test for export snapshots
    - **Property 73: Exports contain exactly the snapshot and are self-contained**
    - **Validates: Requirements 35.1, 35.2, 35.3, 35.12**
  - [ ]* 38.10 Write property test for backup and restore
    - **Property 74: Backup and restore round trip**
    - **Validates: Requirements 36.1, 36.4, 36.5, 36.8, 36.10, 36.11**
  - [ ]* 38.11 Write property test for package retention and staleness
    - **Property 75: Package retention and staleness labels**
    - **Validates: Requirements 35.6, 35.7, 35.10, 36.6, 46.34**
  - [ ]* 38.12 Write property test for retention sweeps
    - **Property 86: Retention sweeps act on time**
    - **Validates: Requirements 12.8, 31.8, 32.8, 35.11, 36.3, 46.20, 46.26**
  - [ ]* 38.13 Write property test for character preservation
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
    - The Findings ledger (newest first, filters by Finding_Status, Credit person, and Specialty), Runs (newest start first with the listed columns and filters), Hypotheses (statement and status, status filter), Correspondences (newest date first, filters by Party, direction, and date range), Archival_Requests (Follow_Up_Due marks, filters by status and archive or desk), and the Projects list with every field of Requirement 39.16; every list applies the visibility gate, filters by one or more Projects, and names each Research_Item's Project
    - _Requirements: 5.7, 7.6, 8.5, 9.7, 10.4, 39.14, 39.15, 39.16_
  - [ ] 40.3 Build the Project_Log and list screens in `apps/app/web/src/lists/` and `apps/app/web/src/projects/log.tsx`
    - The Project_Log with Project switcher, order toggle, filters, and page links; after 10 seconds without a page, "the Project_Log is unavailable", with the 00:00 UTC note for daily limits, keeping Project, order, and filters; the list pages and the Projects list
    - _Requirements: 39.16, 43.1, 43.6, 43.8, 43.9_
  - [ ]* 40.4 Write property test for query and date-range validation
    - **Property 64: Query and date-range validation**
    - **Validates: Requirements 21.9, 30.11, 43.8**
  - [ ]* 40.5 Write property test for Workspace lists
    - **Property 65: Workspace lists filter by conjunction and page losslessly**
    - **Validates: Requirements 3.4, 5.7, 7.6, 8.5, 9.7, 10.4, 18.8, 18.9, 23.8, 26.8, 39.14, 39.16, 43.1, 43.2, 43.4, 43.5**

- [ ] 41. Build Dissent_Notes
  - [ ] 41.1 Implement the Dissent_Note API in `apps/app/src/dissent/dissent.ts` and `apps/app/src/api/routes/dissent.ts`
    - `POST /dissent` by an active Member other than the Owner on a Research_Item with a Log_Summary, withdrawn or not, recording text, author, time, and a snapshot of the Log_Summary's text and labels, Private, with the `dissent_unique` guard; `PATCH /dissent/{id}` and `POST /dissent/{id}/withdraw` by the author only, with marks and reasons, a new snapshot on each text change, and refusal when the Log_Summary or the note changed since the editor opened, returning the current Log_Summary and the changes since
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
    - **Property 3: New Disclosure_Units start Private**
    - **Validates: Requirements 13.5, 23.2, 23.15, 26.4, 32.4, 33.2, 37.5, 39.4, 42.1**
  - [ ]* 41.5 Write property test for permanent deletion
    - **Property 36: Permanent deletion removes the subtree and leaves only a tombstone**
    - **Validates: Requirements 15.8, 16.10, 22.7, 22.8, 42.11, 42.18, 43.7**
  - [ ]* 41.6 Write property test for event recipients
    - **Property 54: Recipients follow the event rules**
    - **Validates: Requirements 17.4, 17.6, 19.1, 19.2, 19.3, 19.4, 19.8, 23.7, 23.13, 32.3, 39.9, 39.10, 42.4, 46.36**
  - [ ]* 41.7 Write property test for Dissent_Notes
    - **Property 80: Dissent_Notes stay attached to the wording they concern**
    - **Validates: Requirements 42.1, 42.2, 42.3, 42.8, 42.9, 42.14**

- [ ] 42. Build AI drafting
  - [ ] 42.1 Implement the AI draft API in `apps/app/src/ai/drafts.ts`, `GET /ai/status`, and `POST /ai/drafts`
    - Check the AI_Drafting_Setting and the Permission for the field; select the input in Workspace display order (Research_Item fields, Entry_Sections, Group_Note, Attachment metadata, never file contents), using the editor's unsaved text where open; cut it to the AI_Input_Limit and flag left-out text; send nothing for empty input
    - Reserve the worst-case Neurons in `Budget` and refuse when used plus reserved would exceed 10,000 minus a 300-Neuron margin; `GET /ai/status` offers drafting only while the remaining Neurons cover one worst-case draft at the current limit; call `@cf/google/gemma-4-26b-a4b-it` (fallback `@cf/meta/llama-3.1-8b-instruct-fp8-fast`) through the `AI` binding with an allow-list of Cloudflare-hosted models and no AI Gateway, logging, caching, or batch API, a fixed system prompt, `max_tokens` 800 or 200, and a 30-second deadline; settle the reservation with the reported usage; store and log neither prompts nor drafts; refuse Public_Traffic, imports, and restores
    - _Requirements: 28.14, 28.15, 44.1, 44.2, 44.3, 44.4, 44.9, 44.10, 44.11, 44.12, 44.13, 44.17, 44.18_
  - [ ] 42.2 Implement draft output shaping in `packages/domain/src/ai-output.ts`
    - Cut drafts at the last sentence or word boundary within 2,000, 100, or 200 characters, remove Markdown headings, add no label, return only kind and note for Disclosure_Line drafts, and flag the quotation-mark notice when a listed quotation mark stands at the start or after a space, line break, or opening bracket
    - _Requirements: 44.2, 44.7, 44.8, 44.14_
  - [ ] 42.3 Record AI provenance on save in `apps/app/src/records/pipeline.ts`
    - The client sends the model id and version and the SHA-256 of the last placed draft for each field; the creation or Revision records them with whether the saved text differs; history views show these details
    - _Requirements: 44.6_
  - [ ] 42.4 Build the editor draft controls in `apps/app/web/src/editor/ai-draft.tsx`
    - The request control only when the status allows, with the "turned off" or "resumes at 00:00 UTC" notice otherwise; the draft held only in the tab's editor memory and shown apart from the field; accept places the text, asks before replacing, and leaves the field unsaved; discard or a new draft removes the old one; the quotation-mark notice next to the draft and then the field until saved; "no AI_Draft was produced" on errors, empty output, or timeout, with late answers discarded
    - _Requirements: 44.4, 44.5, 44.8, 44.10, 44.11, 44.12, 44.16, 44.17_
  - [ ]* 42.5 Write property test for the AI allocation
    - **Property 83: AI requests never exceed the allocation**
    - **Validates: Requirements 28.14, 44.10, 44.11, 44.17**
  - [ ]* 42.6 Write property test for AI input and output
    - **Property 84: AI input selection and output shaping**
    - **Validates: Requirements 44.1, 44.2, 44.3, 44.7, 44.8, 44.14, 44.18**
  - [ ]* 42.7 Write property test for AI provenance
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
  - [ ]* 43.7 Write the Playwright presentation tests in `tests/presentation/`
    - axe-core on every page type in both colour schemes; a viewport sweep from 320 to 2,560 pixels with no horizontal page scroll, overlap, or clipping; print to PDF on A4 and US Letter compared with the page text; colour-scheme switching without reload; a privacy crawl recording network requests and cookies or storage; visual regression of every component through both renderers
    - _Requirements: 45.1, 45.5, 45.7, 45.9, 45.16, 45.17, 45.18_
  - [ ]* 43.8 Configure Lighthouse CI in `lighthouserc.json`
    - 20 loads per representative public page under the Reference_Mobile_Profile with an empty cache, asserting the 75th percentiles of Largest Contentful Paint, Cumulative Layout Shift, and Interaction to Next Paint
    - _Requirements: 45.8_
  - [ ]* 43.9 Write property test for concurrent saves
    - **Property 29: Concurrent saves from one base are serialized**
    - **Validates: Requirements 4.9, 22.10, 32.16, 42.16, 46.28**
  - [ ]* 43.10 Write property test for reminder and alert schedules
    - **Property 87: Reminder and alert schedules**
    - **Validates: Requirements 10.3, 35.5, 36.7, 46.24, 46.25, 46.40**
  - [ ]* 43.11 Write property test for the People page and Responsible_Person statement
    - **Property 95: People page and Responsible_Person statement**
    - **Validates: Requirements 46.5, 46.6, 46.35, 46.38**
  - [ ]* 43.12 Write property test for last-updated dates
    - **Property 98: Policy_Page last-updated dates**
    - **Validates: Requirements 46.29**

- [ ] 44. Build usage monitoring and System_Alerts
  - [ ] 44.1 Implement the analytics queries in `apps/ops/src/analytics.ts`
    - `usage()` querying the Cloudflare GraphQL Analytics API for Worker requests, D1 rows read and written and storage per database, R2 storage and Class A and B operations, and Workers AI Neurons
    - _Requirements: 19.10_
  - [ ] 44.2 Implement usage alerts in `apps/app/src/usage/alerts.ts`
    - Every 15 minutes combine the analytics with the `Budget` figures for the Public_Traffic_Budget, the AI_Allocation, and the Recipient_Cap; a state machine per allowance and period raises one System_Alert for every Administrator, naming the allowance and the percentage, each time usage rises from below 80% to 80% or more
    - _Requirements: 19.10, 28.2_
  - [ ]* 44.3 Write property test for usage alerts
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
  - [ ]* 45.3 Write security tests in `tests/security/`
    - HTML, SVG, PDF, and polyglot files with scripts served through `rf-dl` and opened in previews run no script in the Workspace origin and cannot send an accepted request; cross-origin and header-less state-changing requests are refused; Download_Links replayed after 15 minutes, after revocation, or for another file are refused
    - _Requirements: 14.6, 25.5, 25.6_
  - [ ]* 45.4 Write the CI smoke checks in `tools/smoke/`
    - No route accepts file bodies and none returns renditions; the AI model allow-list holds only Cloudflare-hosted models and no AI Gateway is configured; no secret appears in the repository; every font and icon has a licence that allows self-hosting and export; the Policy_Section list matches Requirement 46.32
    - _Requirements: 12.5, 14.9, 20.20, 44.9, 45.20, 46.32_

- [ ] 46. Add observability
  - [ ] 46.1 Implement metrics and the operations status endpoint in `apps/app/src/metrics.ts` and `GET /api/v1/ops/status`
    - Structured metric events per route (requests, CPU time, D1 rows), Publisher lag from save to deploy and to verified removal, Mailer queue depth, held time, and delays against the time limits, AI Neurons per day, and Public_Traffic_Budget use; an Administrator-only summary endpoint
    - _Requirements: 24.11, 28.2, 28.3_
  - [ ]* 46.2 Write the performance test harness in `tests/perf/`
    - Largest allowed inputs (a 2,000,000-character Journal_Entry through staged saves, a 100-file Submission, Member search on a synthetic 50 MB corpus, previews of 1,000 units, Publisher slices) with CPU time read from Workers Logs and an 8 ms 95th-percentile limit; Member and public search latency on 50 MB corpora; Publisher throughput on 20,000 units; an export at the planned size; Neurons per draft; run against staging
    - _Requirements: 21.2, 24.11, 24.12, 28.3, 28.8, 28.15, 30.6_

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
    - Apply D1 migrations and deploy `rf-app`, `rf-dl`, `rf-submit`, and `rf-ops` per environment, then enqueue a `site` scope so the Publisher creates the first `rf-site` deployment; bootstrap the first Administrator and Responsible_Person from an email given on the command line and the P1030680 Project (Private); CI runs `npm run ci` on every push
    - Accept validated installation configuration and initial Project inputs; provide ResearchForce.org as an explicit example. Require the instance owner's content-licence name, URL, and export text before enabling research publication or collecting licence agreements, with no default from the software's MIT licence
    - _Requirements: 2.2, 26.1, 46.37_
  - [ ]* 48.5 Write the staging verification suites in `tests/staging/` and `infra/m365/Verify-ResearchForceMail.ps1`
    - Public change timing (removals within 5 minutes, other changes within 15) on pages, search, files, People, and Policy pages; Access redirects; Graph refusals to send as another mailbox or read mail; credential rotation; SPF, DKIM, and DMARC alignment from `Authentication-Results`; the received MIME structure and plain-text part; Sent Items and Recoverable Items statistics; Turnstile in managed mode; a load replay of the usage profiles with a public flood
    - _Requirements: 1.1, 20.19, 20.21, 20.22, 20.24, 24.11, 24.12, 28.1, 28.2, 28.6, 28.7, 45.21_
  - [ ] 48.6 User setup checklist (needs Cloudflare account access)
    - The agent prepares the scripts above, then stops and asks the user to: run `provision.ts` for staging and production; set every secret listed in `infra/secrets.ts`; confirm that `workers.dev` and preview URLs are off and Bot Fight Mode is off; and report the results
    - _Requirements: 1.3, 28.1, 45.18_
  - [ ] 48.7 User setup checklist (needs Microsoft 365 administrator access)
    - The user runs `Setup-ResearchForceMail.ps1`, waits 30 minutes to 2 hours, re-runs `Test-ServicePrincipalAuthorization`, checks the "Tenant Outbound External Recipients" report and sets the Recipient_Cap below the tenant's shared external limit, and stores the Graph tenant, client id, and certificate key as Workers secrets
    - _Requirements: 20.16, 20.19, 20.20, 20.25_
  - [ ] 48.8 User setup checklist (needs DNS access for researchforce.org)
    - The user publishes the SPF, DKIM, and DMARC records, enables DKIM signing for researchforce.org in Microsoft 365, and runs `tools/check-email-dns.ts`
    - _Requirements: 20.22, 20.23_
  - [ ] 48.9 User setup checklist (needs account access for deployment)
    - The user deploys to staging, runs the staging suites and the performance harness, rehearses the journal import on staging with the real files (checking only the counts in the import report), then deploys production, runs `tools/bootstrap.ts`, and runs the production journal import, which creates everything Private and Unclassified
    - _Requirements: 26.4, 26.11, 27.7_
  - [ ] 48.10 Prepare the reusable source release and independent-installation guide
    - Document installation configuration, migration and upgrade steps, and the separate software/content licensing boundaries; include the MIT licence and required third-party notices in software distributions
    - Verify setup with a synthetic second installation whose domain, identity, policy statements, first Project, and chosen content licence differ from ResearchForce.org; verify missing content-licence configuration refuses publication and agreement collection
    - Check release material for real research, personal data, secrets, backups, and instance state; do not include them or publish a repository as part of this preparation
    - _Requirements: Introduction (product and installation scope), 23.2, 29.10, 33.4, 46.16, 46.17_

- [ ] 49. Final checkpoint - Ensure all tests pass
  - Run `npm run ci` (lint, type check, and `vitest --run`); ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are optional and can be skipped for a faster MVP. The required test sub-tasks are the privacy-kernel and disclosure properties (Properties 1 to 8, 10 to 15, 17, and 63) and the parser and printer properties (Properties 66, 67, and 68).
- Each of the 99 correctness properties has exactly one property-based test sub-task. Each test lives in its own file, `test/properties/pNN-<slug>.test.ts` inside the package or app under test, runs at least 100 fast-check iterations, and starts with the tag comment `// Feature: research-collab-cms, Property N: <title>`.
- A property that spans several features is placed after the last code it exercises. Property 5 is the exception: its test (task 6.6) checks every channel in `packages/testing/src/public-channels.ts`, and tasks 9.5, 10.1, 27.1, 30.5, 34.4, and 38.1 register their channels there, so the confinement test covers each public channel as soon as it exists.
- All tests run in single-run mode with `vitest --run` (`npm test`); no task starts a watcher or a development server.
- Tests and fixtures use synthetic data. The existing journal and its attachments are never copied into the repository; task 7.10 and checklist 48.9 read them from paths the user gives, and the import creates every unit Private and Unclassified.
- Several tasks write the same shared files: `apps/app/src/api/app.ts` (route registration), `apps/app/src/index.ts` (Durable Object exports), `apps/app/src/cron.ts`, `apps/app/src/records/pipeline.ts`, `apps/app/src/notifications/fanout.ts`, `apps/app/web/src/routes.tsx`, `apps/ops/src/index.ts`, and `packages/testing/src/public-channels.ts`. The dependency graph keeps those tasks in separate waves.
- Sub-tasks 48.6 to 48.9 are setup checklists that need the user's Cloudflare, Microsoft 365, DNS, or deployment access. The agent prepares the scripts in 48.1 to 48.5, then stops and asks the user to run the checklist and report the results.
- The design's open points stay behind the single locations listed in the Overview, so an answer from the user changes one constant, one function, or one seed text.
- Each task references the requirement criteria it implements; checkpoints run the whole suite at the end of each phase.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "2.4", "3.1", "3.3", "3.4", "3.6", "3.7", "3.9", "3.10", "5.1", "5.2", "5.3", "5.4", "5.5", "6.1", "7.1", "8.1", "8.2"] },
    { "id": 4, "tasks": ["2.3", "2.5", "2.6", "3.2", "3.5", "3.8", "4.1", "4.2", "4.3", "5.6", "5.7", "6.2", "6.5", "7.2", "7.4", "8.3", "8.5"] },
    { "id": 5, "tasks": ["4.4", "5.8", "6.3", "7.3", "7.5", "7.6", "8.4", "9.1"] },
    { "id": 6, "tasks": ["6.4", "7.7", "7.8", "7.9", "8.6", "8.7", "9.2"] },
    { "id": 7, "tasks": ["6.6", "6.7", "7.10", "9.3", "9.4"] },
    { "id": 8, "tasks": ["9.5"] },
    { "id": 9, "tasks": ["9.6", "9.7", "9.8", "9.9", "10.1"] },
    { "id": 10, "tasks": ["10.2", "10.3"] },
    { "id": 11, "tasks": ["10.4", "10.5", "11.1", "11.2", "11.3", "11.4", "11.5", "11.6"] },
    { "id": 12, "tasks": ["13.1"] },
    { "id": 13, "tasks": ["13.2"] },
    { "id": 14, "tasks": ["13.3"] },
    { "id": 15, "tasks": ["13.4", "14.1"] },
    { "id": 16, "tasks": ["13.5", "13.6", "14.2"] },
    { "id": 17, "tasks": ["14.3"] },
    { "id": 18, "tasks": ["14.4"] },
    { "id": 19, "tasks": ["14.5", "14.6", "14.7", "15.1"] },
    { "id": 20, "tasks": ["15.2"] },
    { "id": 21, "tasks": ["15.3", "16.1"] },
    { "id": 22, "tasks": ["16.2"] },
    { "id": 23, "tasks": ["16.3", "16.4", "17.1"] },
    { "id": 24, "tasks": ["17.2"] },
    { "id": 25, "tasks": ["17.3"] },
    { "id": 26, "tasks": ["17.4", "17.5", "18.1", "18.2", "18.3", "18.4", "18.5", "18.6"] },
    { "id": 27, "tasks": ["18.7"] },
    { "id": 28, "tasks": ["18.8"] },
    { "id": 29, "tasks": ["18.9", "18.10", "19.1"] },
    { "id": 30, "tasks": ["19.2"] },
    { "id": 31, "tasks": ["19.3"] },
    { "id": 32, "tasks": ["20.1"] },
    { "id": 33, "tasks": ["20.2"] },
    { "id": 34, "tasks": ["20.3"] },
    { "id": 35, "tasks": ["20.4", "21.1"] },
    { "id": 36, "tasks": ["21.2", "21.3"] },
    { "id": 37, "tasks": ["21.4"] },
    { "id": 38, "tasks": ["21.5"] },
    { "id": 39, "tasks": ["21.6"] },
    { "id": 40, "tasks": ["21.7"] },
    { "id": 41, "tasks": ["23.1"] },
    { "id": 42, "tasks": ["23.2"] },
    { "id": 43, "tasks": ["23.3"] },
    { "id": 44, "tasks": ["23.4"] },
    { "id": 45, "tasks": ["23.5"] },
    { "id": 46, "tasks": ["23.6", "23.7", "23.8", "23.9", "23.10"] },
    { "id": 47, "tasks": ["24.1"] },
    { "id": 48, "tasks": ["24.2", "24.3"] },
    { "id": 49, "tasks": ["24.4", "24.5"] },
    { "id": 50, "tasks": ["25.1"] },
    { "id": 51, "tasks": ["25.2"] },
    { "id": 52, "tasks": ["25.3"] },
    { "id": 53, "tasks": ["25.4"] },
    { "id": 54, "tasks": ["25.5"] },
    { "id": 55, "tasks": ["25.6", "25.7", "25.8", "25.9", "25.10"] },
    { "id": 56, "tasks": ["26.1"] },
    { "id": 57, "tasks": ["26.2"] },
    { "id": 58, "tasks": ["26.3"] },
    { "id": 59, "tasks": ["26.4", "26.5", "26.6", "26.7"] },
    { "id": 60, "tasks": ["27.1", "27.2"] },
    { "id": 61, "tasks": ["27.3"] },
    { "id": 62, "tasks": ["27.5"] },
    { "id": 63, "tasks": ["27.4"] },
    { "id": 64, "tasks": ["27.6", "27.7", "27.8", "27.9", "27.10", "27.11"] },
    { "id": 65, "tasks": ["28.1"] },
    { "id": 66, "tasks": ["28.2"] },
    { "id": 67, "tasks": ["28.3", "28.4", "28.5"] },
    { "id": 68, "tasks": ["30.1"] },
    { "id": 69, "tasks": ["30.2"] },
    { "id": 70, "tasks": ["30.3", "30.4"] },
    { "id": 71, "tasks": ["30.5", "30.6"] },
    { "id": 72, "tasks": ["30.7", "30.8"] },
    { "id": 73, "tasks": ["30.9", "30.10", "30.11", "30.12"] },
    { "id": 74, "tasks": ["31.1"] },
    { "id": 75, "tasks": ["31.2"] },
    { "id": 76, "tasks": ["31.3"] },
    { "id": 77, "tasks": ["31.4"] },
    { "id": 78, "tasks": ["31.5"] },
    { "id": 79, "tasks": ["31.6"] },
    { "id": 80, "tasks": ["31.7"] },
    { "id": 81, "tasks": ["31.8", "31.9", "31.10", "31.11", "31.12", "31.13", "31.14", "31.15"] },
    { "id": 82, "tasks": ["32.1", "32.2"] },
    { "id": 83, "tasks": ["32.3", "32.4"] },
    { "id": 84, "tasks": ["32.5"] },
    { "id": 85, "tasks": ["32.6", "32.7"] },
    { "id": 86, "tasks": ["34.2"] },
    { "id": 87, "tasks": ["34.1"] },
    { "id": 88, "tasks": ["34.3"] },
    { "id": 89, "tasks": ["34.4"] },
    { "id": 90, "tasks": ["34.5", "34.6"] },
    { "id": 91, "tasks": ["35.1"] },
    { "id": 92, "tasks": ["35.2"] },
    { "id": 93, "tasks": ["35.3", "35.4"] },
    { "id": 94, "tasks": ["35.5"] },
    { "id": 95, "tasks": ["35.6"] },
    { "id": 96, "tasks": ["35.7", "35.8", "35.9", "35.10", "35.11"] },
    { "id": 97, "tasks": ["36.1", "37.1"] },
    { "id": 98, "tasks": ["36.2", "37.2"] },
    { "id": 99, "tasks": ["36.3", "37.3", "37.4"] },
    { "id": 100, "tasks": ["36.4", "37.5"] },
    { "id": 101, "tasks": ["37.6"] },
    { "id": 102, "tasks": ["37.7"] },
    { "id": 103, "tasks": ["37.8", "37.9", "37.10", "37.11"] },
    { "id": 104, "tasks": ["38.1"] },
    { "id": 105, "tasks": ["38.2", "38.3"] },
    { "id": 106, "tasks": ["38.4"] },
    { "id": 107, "tasks": ["38.5"] },
    { "id": 108, "tasks": ["38.6"] },
    { "id": 109, "tasks": ["38.7", "38.8", "38.9", "38.10", "38.11", "38.12", "38.13"] },
    { "id": 110, "tasks": ["40.1"] },
    { "id": 111, "tasks": ["40.2"] },
    { "id": 112, "tasks": ["40.3"] },
    { "id": 113, "tasks": ["40.4", "40.5", "41.1"] },
    { "id": 114, "tasks": ["41.2"] },
    { "id": 115, "tasks": ["41.3"] },
    { "id": 116, "tasks": ["41.4", "41.5", "41.6", "41.7", "42.2"] },
    { "id": 117, "tasks": ["42.1"] },
    { "id": 118, "tasks": ["42.3"] },
    { "id": 119, "tasks": ["42.4"] },
    { "id": 120, "tasks": ["42.5", "42.6", "42.7", "43.1"] },
    { "id": 121, "tasks": ["43.2", "43.5"] },
    { "id": 122, "tasks": ["43.3"] },
    { "id": 123, "tasks": ["43.4"] },
    { "id": 124, "tasks": ["43.6"] },
    { "id": 125, "tasks": ["43.7", "43.8", "43.9", "43.10", "43.11", "43.12", "44.1"] },
    { "id": 126, "tasks": ["44.2"] },
    { "id": 127, "tasks": ["44.3", "45.1", "45.2"] },
    { "id": 128, "tasks": ["45.3", "45.4", "46.1"] },
    { "id": 129, "tasks": ["46.2"] },
    { "id": 130, "tasks": ["48.1", "48.2", "48.3", "48.4"] },
    { "id": 131, "tasks": ["48.5", "48.10"] },
    { "id": 132, "tasks": ["48.6", "48.7", "48.8"] },
    { "id": 133, "tasks": ["48.9"] }
  ]
}
```
