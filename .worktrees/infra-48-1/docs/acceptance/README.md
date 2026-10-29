# Specification status and acceptance evidence

Task 57.1 adds a repeatable inventory of requirements, design properties, implementation tasks, dependencies and local acceptance evidence. The canonical schedule remains the JSON graph in `.kiro/specs/research-collab-cms/tasks.md`.

Run from the repository root:

```sh
npm run check:specs
npm run specs:write
```

`check:specs` validates the specifications and checks that the committed `spec-status.json` is current. `specs:write` regenerates that file only after structural validation succeeds. CI runs the check alongside lint, type checking and the test suite. The checker does not edit task checkboxes or infer acceptance from the existence of code.

The generated inventory names the next task and remaining build order directly from the canonical graph. It includes every numbered criterion and its task/property coverage; each property and its owning task and existing test files; every leaf task with prerequisites, phase, scope gates, declared source/test paths and file fingerprints; checkpoints; recorded corrections; and the release-gate definitions. Missing future files are recorded as planned work, rather than reported as implementation. Supplemental tests in different layers, such as the existing Property 94 files, remain linked to the same single owning task.

## Evidence states

`task-evidence.json` is the reviewed status ledger. Its frozen historical baseline preserves the checked tasks inherited at the start of this audit. They appear as `historical_unverified`, which means their old checkboxes have not been retroactively certified. They must still pass ongoing CI and the relevant release gates.

An `accepted` record needs source files, test files, a reason, and a passing executed-check report with matching current source/test SHA-256 fingerprints. An accepted record must agree with the checkbox. Newly checked work outside the historical baseline needs such a record. A fingerprint mismatch requires rerunning and reviewing the affected evidence; it must not be resolved by copying hashes into a report by hand.

`reopened` records retain the known failure and correction task IDs. `partial` records distinguish working implementation from unfulfilled acceptance or missing integration. Both remain unchecked. Task 52 is reviewed subtask by subtask. Tasks 52.1–52.3 and 52.7–52.8 have fresh local acceptance; 52.4/52.5 are scheduled after their privacy helpers, and 52.6 after the Workspace lists, so the earlier repair phase cannot deadlock on future integration. Migration `0007_restricted_access.sql` is tested on disposable local D1 databases and is neither recreated nor rerun against production.

To record fresh local evidence, run all tests using synthetic fixtures and import the resulting Vitest JSON:

```sh
npm test -- --reporter=json --outputFile=/tmp/research-force-local-tests.json
node --import tsx tools/check-specs.ts --record-tests /tmp/research-force-local-tests.json
```

The importer refuses failed, skipped, incomplete, duplicate or inconsistent suites, test files outside this checkout, future-dated receipts, and evidence sources modified after the recorded run began. It retains only the command, run start time, checkout-relative suite names, passing counts and current ledger source/test hashes. Test inputs, names, failure details and console output are omitted. The temporary raw report stays outside the repository. The committed record is a local, point-in-time test receipt, not signed infrastructure attestation.

After reviewing the results, update the relevant ledger records, checkboxes and graph, then run `npm run specs:write` and `npm run check:specs`. Completing a task moves its ID from a wave into `completedBaseline`; preserve task IDs, remove empty waves, recompute serial predecessor IDs and phase bounds, and keep the `Canonical phases` narrative consistent. Explicit helper edges and gate references continue to name the same task IDs. An existing implementation verified out of its original scheduling position may be reconciled into the completed baseline with an explicit evidence record.

This checker validates release-gate structure and scheduling. Task 68.4 owns runtime gate evaluation. Local node, component and workerd tests do not establish browser accessibility, real Access/R2/Graph behavior, independent recovery, production capacity, consent correctness of research, or authority to publish. Those remain separate mandatory scope-specific evidence. Real research, raw reports, credentials, bearer links and backups do not belong in this directory.

## Acceptance gaps retained by this audit

| Tasks | Remaining acceptance | Owning correction |
|---|---|---|
| 19.1 | Accepted logical text can exceed a staged request or D1 row; history/spans also need bounded physical storage | 57.3, then 19.1 and 57.6–57.8 |
| 30.6 | Upload metadata and acknowledged identity must survive reload without claiming to reconstruct local File objects | 30.6, 57.8 and durable drafts in 64.1 |
| 30.7, 30.11 | CSV currently buffers the file; enforce bounded streaming, cancellation and accurate truncation reporting | 30.7, 30.11, 57.8 |
| 30.8 | Listing attachments must not clear all their flags | 30.8, 57.8 |
| 52.4, 52.5 | Access preview lists reset units, but full removed Public_Views and database projection loading remain unfinished | 31.1; revoked-owner approval remains 54.5 |
| 52.6 | Reusable access controls exist; full Workspace list integration and rendered removed views remain unfinished | 40.3, 31.1 |

## Existing tests that new features must extend

| Existing coverage | Required extension | Owning work |
|---|---|---|
| Domain schema/permission tests and migration tests | Work/Decision kinds, configurable-role migration, exact bounds and field-specific actors | 60.1, 61.1, 62.1 |
| Property 1 effective disclosure and kernel preview tests | New kinds, related evidence/participants, exact consent snapshots and current permission evidence | 54.2, 60–63, 66, 68.1 |
| Property 5 confinement and public-channel registry | Actual rf-dl responses and every added HTML/index/file/export/release channel, rather than constant refusal adapters | 57.5, 45.3, 66.2, 68.4 |
| Property 27 validators, Property 33 history and existing staged-save tests | Chunked logical text/spans, one oversized section, immutable version reconstruction, lost responses | 57.2–57.4, 19.1 |
| Property 46 and file component tests | Reload/expiry/reselection, scan and quoted-record budgets, cancellation, list-versus-view semantics | 30.6–30.8, 30.11, 57.8 |
| Properties 60/61 search and excerpt tests | Matches and phrase positions spanning physical chunks; new record filters and hidden relationship endpoints | 57.3, 60–65 |
| Properties 100/101 and access/component/recipient tests | Every new research kind, relationship, current-access route and per-Member insert; proposals/drafts have explicit exceptions | 60–66; 57.5 adds actual delivery coverage |
| Notification/grouping/preference tests | Follows plus participation deduplicate, new event defaults, access loss and mute handling | 60–65 |

These extensions are recorded work. This audit does not mark the future feature or infrastructure suites complete.

## Task 50.1 local smoke verification

On 28 October 2026, `npm run dev:reset` successfully applied local D1 migrations and populated both emulated R2 buckets. Repeated `npm run dev` preserved fixture identities, served the Vite page with HTTP 200 and proxied `/api/v1/me` to the protected Worker with HTTP 401. A terminal interruption then released both 5173 and 8787 and removed the run lock. The repeat-signal shutdown fix was exercised against the actual Wrangler/Vite processes. Migration/seed compatibility, full-text search, repeatability/edit preservation, local configuration, port validation and reset boundaries are also covered by the local test receipt. Sign-in and service emulation remain separate tasks.

## Task 50.2 local sign-in verification

On 28 October 2026, the running loopback Worker/Vite environment was exercised with local sign-in enabled through the ignored `.dev.vars` file. HTTP verification observed sign-in 303, authenticated `/api/v1/me` and Projects 200, sign-out 303, and refusal of the ended token with 401. An isolated headless Edge profile verified the Workspace-to-sign-in redirect, synthetic-member form login, protected Projects navigation, sign-out and subsequent reauthentication. The browser check caught a `no-referrer` form policy that produced `Origin: null`; the local form now uses `same-origin` while preserving exact Origin validation.

Real Vite HTTP checks and the regression suite verify 403 responses for root/generated local vars files and the local signing key, including direct `/@fs` requests. The local config is validated before launch; the production entrypoint refuses local-auth settings, and the deployment guard refuses local entrypoints/flags in root or named environment configuration and selected vars files. Runtime tests verify normal current role/status/profile/session enforcement, invite activation, tampered or duplicated cookies and forged assertion-header refusal, browser-session switching, and both sign-out paths. Node/component tests and the complete suite pass. Production frontend builds and eight guarded Worker dry-run bundles pass; these commands performed no deployment.

The guard in `scripts/deploy.ts` is the task 50.2 refusal foundation, not completion of task 48.4 deployment orchestration. Task 50.3 introduces local service stand-ins through the controlled local entrypoint and extends local-binding checks while retaining production refusal. The general release gates remain unevaluated by this local tooling work.

## Task 50.3 local service stand-ins

On 28 October 2026, a synthetic invitation was submitted through the running Workspace Members screen. OPS membership changes were recorded locally, the real Mailer queue accepted the invitation through the capture provider, and the Administrator could inspect its plain text and inert HTML source in the outbox. Repeated local AI probes returned identical visibly synthetic results. A Contributor received 403 for the outbox. After a full server restart, the captured message and AI diagnostic history remained present, with zero delivered emails reported by the stand-in.

Automated workerd tests exercise local OPS state, AI determinism/unsupported inputs, capture size bounds, 200-message retention, lossless summary pagination, real invitation queuing and repeated Mailer kicks, current Administrator authorization and CSRF, inert HTML rendering, production refusal and no Graph fallback. A native Worker-request regression covers a request-affinity issue found by the live browser test: the cached router must obtain RPC stubs from each current request rather than retain an earlier request's handle. The isolated local-worker Vitest project uses actual local DO/RPC behavior and ephemeral synthetic test keys.

The normal deployable Mailer retains Microsoft Graph. Only the local entrypoint exports the capture Mailer and the local service namespace; runtime/launch/deploy checks reject accidental production selection or remote bindings. Production frontend builds and all eight guarded Worker dry-run bundles passed. This completes task 50's local environment without certifying real Access, Graph, Workers AI, delivery, provider billing/quotas or the general release gates.

## Task 57.2 resource profile foundations

The 28 October 2026 local receipt covers strict versioned Free_Qualified/Paid_Standard contracts, independent provider/chosen budgets, exact bounded JSON byte accounting, logical/schema and preview constants, authenticated profile API and browser validation, installation templates, and local certification/forecast tooling. Boundary fixtures include a single 600,000-character ASCII section, 600,000 emoji, two million code points, maximum escaped text and 50,000 source-bearing labels, a large inline Revision, and a label crossing a prospective fragment boundary. The fixtures preserve logical acceptance and explicitly refuse oversized physical representations. They do not claim fragment storage or inside-section staging is implemented.

Both installation templates were exercised through the CLI, with source hashes and explicit `productionCertified: false`. Reports retain separate 1/3/5-year source/history/metadata/public/release/export volumes, conservative independent retention tiers, transient full copies and recovery transfer bytes. The example corpus is synthetic/unmeasured and spending/production approval remains false. Provider documentation URLs/date and the abuse/reference/growth versions accompany each report; real provider CPU/memory, transfer, recovery, edge shedding and spend evidence remain the release/capacity gates in task 48.3. See `infra/profiles/README.md` for reproduction and required installation inputs.

The full suite found a faulty historical preview property: a valid literal U+FFFD at the byte boundary was mistaken for decoding corruption. The property now compares the independently counted whole-code-point prefix and includes a deterministic literal-character regression. Preview implementation behavior is unchanged; the reopened streaming/memory work remains pending. All 1,035 tests passed; lint, type checking, production frontend builds and eight guarded Worker dry-run bundles also passed. No deployment, plan upgrade or purchase occurred.

## Task 67.1 compatibility and upgrade foundations

On 29 October 2026, the release catalog gained a source/configuration/dependency/migration-fingerprinted development baseline, strict per-Worker schema ranges, immutable candidate creation, released-reader retention checks, inventory-based preflight/recovery plans and explicit accepted recovery windows. The repository currently has no released software or authenticated production backup format. Unsupported readers fail closed; synthetic release fixtures test retention of current/two-prior readers without inventing historical releases. Production promotion/deployment and independent restore certification retain their downstream gates.

The local adapter verifies DDL before adopting existing history, preserves original rows/columns/indexes/triggers on expansion, and commits migration history with schema effects. Its bounded backfills retain row/byte limits, definition/specification hashes, atomic cursors/effects and monotonic generations, with explicit final verification. Contraction checks the exact expanded schema, ended accepted window, drained consumers/leases, exact completed backfill versions and a fresh installation-specific restore proof. Interrupted migrations/backfills roll back; safe completed contraction retries do not replay SQL. Tests also preserve synthetic immutable field-version tables, pending actual field storage in 57.3, and refuse bootstrap email/ID conflicts.

Seven actual local SQLite recovery copies were reopened and verified across core checkpoints 9/8/7, search 2/1/0 and public 0, with pre-upgrade bootstrap identity, research text, immutable revision, upload and indexed-document fixtures. Seeding documents before the inherited FTS-creation migration exposed a missing index population step. The registered search repair now resets/repopulates in bounded checkpointed slices, with atomic first effects/cursor rollback and a final FTS content integrity check. No previously applied migration was edited or blindly replayed.

All 1,051 tests passed, including the new fault-injection and command tests. Lint, type checking, release fingerprint checks, frontend production builds and eight guarded Worker dry-run bundles passed. CLI rehearsal, rollout plan and deployment preflight ran successfully using the explicit synthetic inventory. Node 22.16+ is now required for the actual local SQLite backup API. No live D1, active local-dev database, provider deployment, software release, plan purchase or public research changed. See `infra/releases/README.md` for commands and the boundary between these local checks and mandatory production evidence.

## Task 57.3 immutable logical fields

On 29 October 2026, additive core migration 0010 and search migration 0003 introduced immutable logical field versions, separately bounded text/label pieces, canonical checksums, sealed manifests and exact global offsets. Scoped readers, guarded current pointers, immutable retained references and renewable read leases preserve owner authorization and prevent collection of live dependencies. Large new Revision values use retained snapshots; the legacy backfill keeps original field and Revision bytes intact. Legacy mirrors remain authoritative during the expansion window.

Synthetic tests exercise malformed/manipulated parts, replay with reordered JSON keys, immutable storage and retention, cancelled reads, history reconstruction, migration checkpoints, owner/refusal and current-access fences. Search terms/phrases cross physical boundaries while excerpts retain original text/labels. Markdown printing streams complete logical sections, kernel materialization retains projection policy, and public continuation helpers bound rendered pages while preserving marks and cross-page anchors. `boundedEnvelopes` measures complete encoded JSON envelopes.

The actual local rehearsal reopened all seven recovery copies at core 10/9/8, search 3/2/1 and public 0. Running `fields:migrate` against its working core-10 copy stopped after two slices at generation 2, resumed to completion at generation 37 and preserved the source/history fixtures. These commands touched only disposable synthetic databases. All 1,071 tests, lint, type checking, release fingerprint checks, frontend production builds and eight guarded Worker dry-run bundles passed.

The shared storage/read/retain contract supports subsequent citation, draft, backup and export implementations without certifying those features. Task 19.1 still owns inside-section staged transport and atomic-save cutover; 57.6 owns the end-to-end property suite. Derived search-generation cleanup, production capacity, authenticated backup/recovery, publication orchestration and deployment keep their explicit later tasks. See `docs/storage/logical-fields.md` for format, migration and reader contracts. No live data, production release or public research changed.
