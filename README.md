# Research Force

Research Force is an MIT-licensed collaborative research workspace and public archive. ResearchForce.org is its first installation, beginning with the P1030680 Enigma project. Other teams can run independent installations from the same source.

The implementation follows the [requirements](.kiro/specs/research-collab-cms/requirements.md), [design](.kiro/specs/research-collab-cms/design.md), and [task checklist](.kiro/specs/research-collab-cms/tasks.md). Tasks 1 through 5 establish the scaffold, domain foundations, domain rules, validation schemas, and D1 database schemas. Authentication, records, publication, and migration follow in task order. The Worker handlers currently return 404, and the Workspace displays a construction notice.

## Software and research licensing

The software and its development documentation are covered by the [MIT licence](LICENSE). Third-party dependencies and assets retain their own licences and notices.

Research records, attachments, imported journals, and other instance content are separate from the software licence. Each instance runner or owner chooses and configures the licence for that instance's research content, subject to the authors' agreements and third-party rights. ResearchForce.org's content licence is undecided. MIT is never a default content licence or an automatic grant over research stored in an installation.

Private research, uploads, backups, credentials, and real personal data stay outside the source repository. Examples and tests use synthetic data. The deployment work will make site identity, trusted origins, group policy text, sending address, Responsible Person, and content licence explicit installation configuration. The initial scope remains one installation per team using the Cloudflare architecture in the design.

## Local checks

Use Node 22.22.2 (`nvm use`) and npm 11.21.1. The lockfile records the complete workspace toolchain. npm 10 can crash while resolving this toolchain's peer dependencies; use the pinned npm version when installing:

```sh
npx --yes npm@11.21.1 ci
npm run ci
npm run build
npm run check:workers
```

- `lint`: oxlint, stylelint design-token rules, and resolved import boundaries.
- `typecheck`: boundary checks and TypeScript 6 project-reference builds. Declaration output stays under ignored `.cache/` directories, outside browser assets.
- `test`: Vitest in single-run mode, with Node and local workerd projects. Miniflare needs permission to open loopback ports. Storage uses local D1/FTS5, R2, and SQLite Durable Objects. AI is absent and operations is a local stub; remote bindings are disabled.
- `test:nightly`: the same single-run suite with `FC_RUNS=1000`. Defaults are 100 iterations. Lower or invalid values are refused. fast-check failures retain the failing seed and shrink path for replay. See `packages/testing/src/fc.ts` for the property tag format.
- `build`: the React 19/react-router 7 Workspace and hashed public shell assets, built with Vite 8. No watcher or development server starts.
- `check:workers`: Wrangler dry-run bundles for all four Workers, in both top-level and staging environments. Run `build` first. It never deploys or provisions resources.
- `db:generate`: drizzle-kit migrations for `rf-core`, `rf-search`, and `rf-public` from the Drizzle schemas. It writes files only and never applies them to a database.

## Structure and boundaries

`packages/` contains domain, kernel, markdown, manifest, design, public-render, search-public, db, and testing. `apps/` contains the app Worker and its `web/` SPA, the public site shell, and submit, dl, and ops Workers. `tools/` holds migration helpers as they are implemented.

Package modules use subpath imports such as `@researchforce/domain/dates`. Each package has a wildcard source export and its own composite TypeScript project. The direct references and oxlint restrictions follow the design's dependency table. The additional boundary checker resolves relative paths and checks static imports, re-exports, import types, dynamic imports, and require calls, including type-only kernel access from public-render and search-public. Tests may import shared testing helpers without adding production dependency cycles.

Visual values belong in `packages/design/src/tokens.css`. The stylelint plugin rejects raw colours, dimensions, spacing, fonts, and custom property definitions elsewhere. The initial tokens and construction notice are scaffolding; Task 8 completes the Design System.

## Domain foundations

The domain package exposes `types`, `text`, `tree`, `dates`, `languages`, and `richtext` subpaths. It has no application or database dependencies.

- Internal IDs are canonical ULIDs; recorded timestamps are canonical ISO 8601 UTC strings with milliseconds. Stored text is never normalized. Character limits use Unicode code points, while span and edit offsets use UTF-16 code units on code point boundaries.
- Partial dates store `{ value, approx }`, with `value` at year, month, or day precision in years 0001 to 9999. Human displays use `c. ` for approximation. JSON preserves the flag; CSV helpers provide separate date and approximate fields so ISO text retains its original precision. Partial-date ordering uses the beginning of the entered period, and overlapping date ranges are allowed.
- Entered times retain their supplied offset and fractional precision. Recorded times use the Profile zone in the Workspace and Member emails, and marked UTC elsewhere. Inclusive local date filters return half-open UTC intervals (`start <= instant < endExclusive`), including short/long days and wholly skipped calendar dates. The clock is always supplied by the caller.
- Rich-text validation returns indexed issues for every faulty label. Insertions strictly inside a label join it; replacements include new text only when marked characters survive on both sides. Fully deleted labels disappear. Mentions are explicit picker-created atomic ranges: editing their contents removes the reference, and typed `@name` text creates no notification target.
- `languages.ts` pins the current ISO 639-1 codes and English names from the [Library of Congress table](https://www.loc.gov/standards/iso639-2/ISO-639-2_utf-8.txt); validation does not fetch external data.

Properties 37, 38, and 91 live in `packages/domain/test/properties/`, alongside example tests for Unicode, date precision, time zones, mentions, and immutable edits. The edit properties use a per-character reference model; the validity property uses independent character coverage. A workerd smoke test checks the same date functions in the deployment runtime.

## Domain rules

- `value-sets` provides immutable add, rename, retire, and rights-publication operations. Results return either a new set or indexed field issues. Locked values have fixed IDs in `LOCKED_VALUE_IDS`; the database seeds must use these IDs so protection survives renaming. Retired values remain available for existing references, while new selections refuse them. Every configurable set except Specialties consists of Methods terms and requires Public Descriptions.
- `identifiers` generates opaque IDs through native `crypto.getRandomValues`. `newItemIdentifier()` returns `{ identifier, registryKey }`; `newSubmissionReference()` returns a string. The registry still has to reserve each Item Identifier atomically and retry collisions in Task 17. File-kind detection is separate from MIME sniffing and preview safety.
- `settings` is the registry for defaults, units, validation and operational slice budgets. MB and GB settings use decimal bytes; explicitly named MiB transport constants use binary bytes. The direct-upload threshold defaults to zero because the design sends every file directly to R2. Byte limits without a specified maximum accept positive safe integers; Outside Submission limits accept non-negative safe integers, so zero can disable an allowance. Explicit requirement ranges remain fixed. `defaultSettings(owner)` requires an active campaign owner and replaces the Responsible Person bootstrap placeholder. Email credentials are secrets, not setting values.
- `permissions` seeds both built-in Roles from one map, evaluates current Member status and grants for every call, and enforces ownership and authorship limits. Custom Roles can draw only from existing grants. Project accents, Policy sections, the Responsible Person and backup delivery keep the explicit Administrator restrictions. Callers supply targets read from trusted current records, and use `canAll` before writes. The last-Administrator check also requires the atomic D1 guard introduced in Tasks 5 and 14.
- `retention` holds the periods, ending events and unlimited policies shared by sweepers and the Privacy table. The generated table preserves the distinct requested/scheduled export policies, response-link/hash lifetimes, decision-based file/email erasure, and backup deletion grace period. Retention is release configuration, not an Administrator-editable setting.
- `search-text` folds only derived search text using NFKD, combining-mark removal, lower case and sharp-S expansion. Paired double quotes form whole-word phrases; an unmatched quote is punctuation. Query validation counts code points and reports all date and query issues without changing entered text. Matching, ranking and FTS query construction come in later search tasks.

Properties 31, 44 and 97 cover operation sequences, the complete extension table, and generated retention rows. Example tests cover settings, cryptographic sources, scope restrictions, custom grants, review eligibility, status changes, and search syntax. Native crypto and Unicode folding are also exercised inside workerd.

## Validation schemas

The `schemas/people`, `schemas/items`, and `schemas/other` subpaths expose Zod 4.6.6 validators for editable records and settings. Shared primitives and `validate(schema, input)` live in `schemas/common`; validation returns the existing `RuleResult` format with dotted field paths, including array indices. The validators reject unknown keys and report independent cross-field errors even when another field has a wrong JSON type. They never merge unvalidated input back into parsed output.

Factories take a trusted `ValidationContext` snapshot containing the current instant, viewer time zone, allowed reference records and value sets. Public endpoints must supply only reference records available to that visitor. Existing selections, previous Journal totals, fixed slugs, and edit/import/parser/restore modes come from trusted saved state or verified import/backup processing, never from an editable body. Contextual schemas should be rebuilt from current request data.

- Editable text stays in its original form. Long text uses `{ text, spans }`; dates use the domain partial-date form. Validated output may add documented defaults, such as empty optional Profile fields, the digest hour, Public Profile Off, Open Finding/Hypothesis status, or Unknown rights. It never trims text or rounds Run counts, which remain strings of up to 30 digits.
- `researchItemSchema(kind, context, options)` retains the chosen kind in its output type. Submission mode requires a Log Summary except for Journal Entries and Topics. Edit mode protects existing summaries and uses the saved Journal section/character totals. Parser mode requires the actual source byte count within the journal limit; verified restore mode preserves existing sizes and supplied retired selections. An unchanged retired selection is accepted only for an existing record; a new Attachment cannot inherit that exception from its parent.
- `BUILT_IN_VALUE_IDS` now also defines the Finding status identities. Seeds must use them so renaming Withdrawn does not disable its reason requirement. Reserved slugs are exported from the Project schema for use beside the editor field.
- `submissionReadiness` validates complete uploads, metadata, file count and sizes and identifies unready files by index and original name. Upload ownership, checksums and storage facts still require the file service. Outside Submission validation requires explicit agreement to the configured current licence, with the Removal Request exemption.
- Validation performs no writes and grants no authority. The save pipeline must still run `canAll`, verify referenced and staged records, enforce evidence/superseding links, and repeat concurrency-sensitive rules in guarded D1 batches. These integration steps follow in the database and feature tasks.

Property 27 runs a matrix of record, field, setting and invalid-input cases against independent constraint expectations. Example tests cover large Journal boundaries, all independent error fields, exact counts and fractional times, retired selections, licence exemptions, and unknown ownership/disclosure fields. A workerd test exercises the same Zod validators in the deployment runtime.

## Database

`packages/db` holds the Drizzle schemas for the three D1 databases (`schema/core/*.ts`, `schema/search.ts`, `schema/public.ts`) and their migrations in `migrations/<database>/`. Wrangler applies these folders in filename order.

- `0000_schema.sql` files come from `db:generate`. SQL that Drizzle cannot express sits in hand-written migrations registered in the Drizzle journal: `core/0001_raw.sql` (the expression index for active Cross_Links and the triggers that keep Revisions, Moderation_Decisions, and Item_Identifiers permanent) and `search/0001_fts.sql` (the FTS5 table and its sync triggers).
- `core/0002_seed.sql` is generated by `src/seed/seed.ts`. The seed test compares the two; run `npx vitest --run -u packages/db` after changing a seed module. Seeds hold only what every installation shares: built-in Roles, value sets with fixed IDs for locked and built-in values, Methods_Term descriptions, default settings, Policy_Sections with neutral starting text, and the counters. The installation name, Responsible Person, first Administrator, first Project, and Content_Licence are bootstrap inputs.
- There are no foreign-key constraints; the save pipeline verifies references. CHECK constraints restate domain invariants that a single row can show.
- `GuardedBatch` (`src/batch.ts`) sends a save as one D1 batch. It starts with the backup-freeze guard and the change-counter increment, stamps `updated_seq`, `actor_id`, and `rev`, adds Revision and outbox rows, and expands bulk inserts with `json_each`. A guard inserts NULL into its `_g_<code>` table when its condition fails, which aborts the batch; the helper reports this as a `GuardViolation` with the rule's code and HTTP status. Batches above 40 statements are refused before sending. `RequestAccountant` sums statements, rows read, and rows written for a request.

Workerd tests in `apps/app/test/db-schema.test.ts` apply all three migration sets to local D1 and cover the seeds, the credential-column scan, immutability triggers, CHECK rules, stamping, guards, the freeze, bulk inserts, and FTS synchronisation. They use synthetic data only.

## Cloudflare configuration

The Wrangler configurations have Workers development addresses and preview URLs disabled. Production and staging have separate resource names and cross-Worker bindings. `rf-app` owns the three D1 databases, two R2 buckets, Workers AI, four SQLite-backed Durable Object classes, the ops service binding, and the two cron schedules. `rf-submit` references the app's Budget and Mailer namespaces; `rf-dl` has only core data and private files. `rf-ops` has no fetch handler or public route.

Database UUIDs are deliberate placeholders for local validation. No resources, custom domains, secrets, Access policies, or public site deployment have been created. Task 48 provisions real resources and replaces these IDs. Secrets belong in Wrangler secrets or ignored `.dev.vars` files.

## Toolchain compatibility notes

- Cloudflare renamed `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin`. The requested dependency name is retained as an npm alias to the maintained plugin, with the current `cloudflareTest()` API and a compatible Vitest 4.1 version. This avoids the retired package's outdated dependencies. See [Cloudflare's configuration documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/).
- The legacy esbuild loader pulled in by drizzle-kit uses an esbuild override to 0.25.12 to remove its vulnerable older copy. Keep the override until drizzle-kit removes that legacy dependency, and validate Drizzle CLI operation when changing it.

All fixtures are synthetic. The HELUT journal and attachments stay outside this repository; later migration tasks read them only from explicitly supplied paths.
