# Research Force design, requirements, and task review

Review date: 27 October 2026. Reviewed the working tree, including the recent Task 30 changes.

## Assessment

Research Force has a sound foundation for a shared research archive and a credible model for careful public publication. It already specifies substantially more than a basic journal or message board: structured research kinds, evidence links, negative results, provenance labels, discussion, review requests, history, restricted access, confidentiality holds, publication consent, dissent, imports, and exports.

The complexity is uneven. Infrastructure, publication policy, and presentation are described in considerable detail. Coordination of ongoing research, precise evidential citations, and computational reproducibility receive less structure. For a team that wants to overbuild, those are the most valuable areas to deepen.

The planned system would support basic asynchronous collaboration by the founding team. The implemented system is still partway through that plan. It should not yet be the only custodian of irreplaceable research or be treated as ready for public launch.

This review distinguishes corrections to existing promises from proposed scope additions. Recommendations do not replace the team's confirmed policies about ownership, Log Summary wording, dissent, access, or administrator authority.

## Traceability findings

A mechanical audit of the three specification documents found:

- 51 numbered requirements and 655 numbered acceptance criteria.
- Every criterion appears in an explicit task `_Requirements:` reference; none of those criterion references is invalid.
- All 108 numbered design properties have exactly one property-test task.
- 400 task checkboxes, of which 214 are checked.
- 61 property-test files currently exist. This is consistent with an implementation in progress, not proof that the remaining properties fail.

This is strong reference coverage. It does not establish semantic correctness, operational feasibility, or that the tests execute the actual behavior promised. Task 52, for example, is still unchecked despite substantial restricted-access implementation and tests being present. The milestone build order also deliberately differs from the older dependency waves. Status and executable dependency information need reconciliation.

## Corrections to make before relying on the system

### 1. Bind publication consent to the actual approved content

**Evidence:** requirements R23.18–R23.21; design lines 674–682; tasks 54.2–54.5.

Publication proposals show a proposed Public View, but `publication_consents` stores disclosure values and matches level, presentation, summary, and disclosure-line text. It has no specified approved content revision or view digest. An Administrator could edit another Member's underlying content after approval and then apply the same disclosure values. A fresh Administrator preview would not establish that the Owner approved the changed wording.

**Change:** record the approved Public View or canonical digest, relevant content revisions, file hashes, and disclosure values. Recheck these dependencies atomically when consent is consumed. Changed material needs renewed approval. Preserve the separately stated policy about an Owner editing their own already-public work. Dual Approvals should also recheck both administrators' current eligibility and their exact proposed effect.

**Acceptance case:** Owner approves A; an Administrator changes the body to B; publication is rejected until B is approved, even when level and summary are unchanged.

### 2. Establish dependable backup and recovery objectives

**Evidence:** R36.1–R36.8; design lines 898–911; tasks 38.4–38.5 and 38.10.

Manual backups, seven-day storage expiry, and reminders every thirty days do not define how much work the team may lose. A downloaded backup can be valuable, but the design does not require a recent independent copy or prove it can be restored.

**Change:** agree a recovery point objective and recovery time objective; a sensible starting proposal is at most one day's lost work and restoration within a working day. Add automatic backups, encrypted copies outside the production account or an explicitly operated offline destination, integrity verification, retention tiers, and regular restore rehearsals. Track successful restoration and independent-copy verification, not merely that bytes were downloaded.

The write freeze needs an owner, expiry/recovery procedure, and crash tests. If the job dies, the site must not remain frozen indefinitely or silently continue an inconsistent backup.

**Acceptance case:** recover into a fresh environment using only the documented recovery materials, after simulating loss of the production account.

### 3. Specify safe restore and release compatibility

**Evidence:** R36.4–R36.10; design restore instructions at lines 906–911; task 38.5; release instructions at design line 2163 and task 48.4.

Restore uses `INSERT OR IGNORE`, while the empty destination is allowed to contain the restoring Administrator and seeded configuration. A conflicting row can therefore be silently skipped. In particular, the bootstrap Administrator may share an email with a backed-up Member but have a different ID, leaving attribution and access references inconsistent. Resume safety requires more than ignoring conflicts.

**Change:** version backup formats and schemas; define supported upgrade paths, bootstrap identity reconciliation, manifest validation, and exact resume semantics. Skip a restored row only when it belongs to this restore and matches the intended payload. Unexpected conflicts must stop the job. Validate references and completion counts. Define expand/contract database upgrades, deployment order, forward recovery, and tested rollback boundaries across Workers and databases.

**Acceptance cases:** restore an older supported backup; restore with the same Administrator email but a different bootstrap ID; crash after every restore phase; reject conflicting duplicate IDs without reporting success.

### 4. Reconcile character limits with transport and storage limits

**Evidence:** R4.4; design execution model at lines 165–177; task 19.1; `apps/app/web/src/api.ts:144`; `apps/app/src/records/stages.ts:79`; `packages/domain/src/schemas/items.ts:18`.

A Journal Entry may contain two million Unicode code points, with no smaller individual Entry Section limit. Staging groups whole sections rather than splitting a large section. Consequently a valid section can exceed the 512,000-byte request limit. Larger Unicode sections also exceed D1's row limit.

A synthetic check during this review demonstrated:

| Input in one accepted Entry Section | Staged part size | Configured part limit |
|---|---:|---:|
| 600,000 ASCII characters | 600,049 bytes | 512,000 bytes |
| 600,000 emoji | 2,400,049 bytes | 512,000 bytes |

The schema accepts both. D1 documents a maximum string/blob/row size of 2,000,000 bytes. Staging alone does not solve that storage constraint. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

**Change:** design logical text sections backed by bounded physical chunks, including span mapping and revision reconstruction, or deliberately revise the accepted byte limits. Include text, span JSON, revision payloads, staging overhead, and a single oversized section in boundary tests.

### 5. Make public-traffic isolation and removal promises achievable

**Evidence:** R28.5–R28.7; design lines 193–210, 698–722, and 2001–2013; tasks 32.5, 34, 44, and 46.2.

Static public pages and public file copies are good choices. However, invalid Download Links still invoke `rf-dl`; the design explicitly leaves that host outside the global budget block so Member downloads remain available. Distributed traffic can exhaust an account-wide request allowance despite per-address rate limits. A gate inside a Worker cannot avoid the request charge for reaching that gate. The unconditional guarantee that public traffic cannot exhaust Member capacity is therefore not established.

Similarly, publication removals wait behind an existing publication run, and API failures or exhausted quotas trigger retries and alerts. An alert does not remove material from a still-serving public deployment.

**Change:** define a bounded abuse model and measured availability objectives; specify actual quota isolation or an operating plan that supports those objectives. Give urgent removals priority over older publication work, prevent stale runs from reintroducing withdrawn material, and document emergency containment when rebuilding cannot meet the removal deadline. Include independent operational alerting so a failed D1/app/email path is not its own only alarm.

Cloudflare currently documents the Workers Free daily request allowance at account level. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). A Workers Paid operating mode is worth evaluating against the existing cost policy, without treating its subscription as an absolute total-bill cap. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

**Acceptance cases:** sustained distributed invalid-download traffic while Members save and download; a confidentiality hold during a long publication job; deployment API failure; stale job retry after a removal; exhausted operational quota.

### 6. Update platform assumptions and turn estimates into measurements

**Evidence:** design execution model, capacity estimates at lines 1314–1319, and open question 9; tasks 46.2 and 48.5.

The design treats Durable Object work as if it must fit a 10 ms ordinary Worker budget and leaves the actual limit open. Current Durable Object documentation specifies a 30-second default CPU budget. Current D1 documentation also clarifies that a `batch()` counts as one query against the per-invocation query limit, though individual statement limits still apply. Conservative internal limits can remain useful; they should be identified as chosen limits rather than uncertain platform facts. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

The claims about years of database capacity and low public-search transfer cost also need a reproducible growth/load model. Include revision growth, indexes, flags/views, notification history, processed outbox rows, consent snapshots, public copies, retained exports, backup copies, and transient copies. Define maintenance retention without deleting scholarly history. Test search with common terms and large result pages as well as typical small pages.

### 7. Require the tests that prove launch safety

**Evidence:** task notes at line 1359; tasks 38.10, 43.7, 45.3–45.4, 46.2, and 48.5.

Backup round trips, browser security tests, presentation/accessibility checks, the performance harness, and staging verification are marked optional. Following the plan literally can therefore reach its final checkpoint while omitting evidence required by the requirements.

**Change:** make recovery, privacy, security, concurrency, accessibility, migration, and capacity acceptance tests required for the milestone that relies on them. Define separate team-archive and public-launch gates. Add crash, timeout, lost-response, and recovery tests. Ensure public-channel tests invoke real channel behavior: a constant refusal registered in `packages/testing/src/public-channels.ts:69` alone cannot detect a leak introduced in the actual download Worker.

Also add saved-submission idempotency and an explicit uncertain-save state. A response lost after commit must not cause duplicate research records on retry. Clarify that logical notification grouping is different from guaranteeing exactly-once delivery through an external mail provider.

### 8. Close policy ambiguities and task inconsistencies

**Evidence:** requirements open questions; design open questions; tasks 53.2 and 48.4.

- Choose the installation content licence before public launch, as already required.
- Resolve naming outside parties in Withheld lines, addressed disclosure through Consent Links, and the intended bearer-capability exception to general Workspace authentication.
- Give rights requests a structured identity for the exact document/file and permission scope. The current no-file snapshot policy should not depend only on an Administrator remembering to identify the document in a free-text message. Any future external preview needs an explicit, narrowly scoped disclosure exception.
- Resolve residual sending-mailbox retention in the public policy text instead of silently treating a provisional constant as a settled policy.
- Task 53.2 offers destination Parents the Member can edit; R12.12 permits a destination the Member can read. Align them deliberately.
- Reconcile the milestone order, dependency graph, completion state, and acceptance evidence. Keep confirmed decisions separate from provisional assumptions and historical conversational instructions.

## Concrete mismatches in already completed work

These are targeted implementation observations, not a full code audit. They include corrections to the recent Task 30 completion assessment.

1. **Attachment lists clear unread flags.** `apps/app/web/src/files/attachment-page.tsx:40` records every listed Attachment as viewed. Design line 534 explicitly says Attachment lists never clear flags. Record views only on an actual open/preview/download, and add a browser test for listing versus opening.
2. **Upload metadata disappears on reload.** `apps/app/web/src/files/upload.tsx:75` keeps drafts only in component state. R28.10 requires entered text and field values to survive reload in the same tab. Persist metadata, upload IDs, and group identity; revalidate resumed uploads; explain when a local File must be selected again rather than pretending browsers can restore arbitrary File objects.
3. **CSV preview reads the entire file.** `apps/app/web/src/files/preview/index.tsx:26` buffers the full response and later decodes it before truncation. The Attachment_Service design specifies streaming until the bounded row preview is available. A large CSV can exhaust browser memory despite displaying only 1,000 rows. Stream and abort after enough rows, with explicit byte and oversized-record safeguards.
4. **Oversized Entry Sections are accepted but cannot be staged correctly.** The synthetic boundary case above is an implementation failure as well as a specification/storage mismatch.

Reopen or add explicit correction tasks with these acceptance cases. A checked task and a passing suite should not be treated as proof of every intended behavior.

## Recommended scope additions for a deeper research collaboration system

These are new product recommendations, not claims that the current requirements already demand them.

| Capability | Why it matters for this team | Minimum useful acceptance behavior |
|---|---|---|
| Work assignments and dependencies | Threads and review requests do not show who is doing what or what is blocked. | Assign research work, record status/due date/dependencies, link the question/evidence, and show each Member's work and blocked tasks. Completing an assignment records its resulting artifact or explicit no-result outcome. |
| Research Question lifecycle | R50 provides curated links but little structure for managing an investigation. | Record lead, current assessment, open uncertainties, next actions, and open/answered/parked state, with history and evidence for an assessment change. |
| Decision records | A discussion and a Log Summary are not a durable record of the team's chosen course. | Record the question, options, decision, rationale, participants, evidence, dissent, and revisit trigger. Distinguish an individual's conclusion from a team decision. |
| Structured citations and locators | Free-text source names and record-level links are insufficient for precise archival scholarship. | Reference a stable Source/Attachment/version plus page, folio, section, image region, or text range. Include document creators, archival identifiers, persistent identifiers, and access dates where applicable. |
| Original/derivative provenance | A scan, transcription, translation, OCR output, and corrected transcription are related artifacts with different evidential roles. | Preserve originals and checksums; record derivation, method/tool, editor, language, uncertainty, and review state; keep extracted text searchable under the same access rules. Automated OCR can follow later. |
| Reproducible compute packages | R7 records useful descriptions, but free-text parameters and tool versions do not establish reproducibility or comparable search coverage. | Link immutable input hashes, code commit/release, structured configuration, seeds when relevant, environment, search scope, checkpoint, outputs, and independent verification. Add coverage/overlap checks only where the project's scope model supports them. |
| Durable drafts and proposed edits | A closed tab loses work under the current draft policy, and Contributors cannot directly improve a colleague's record. | Save private drafts and offer proposed diffs that the authorized Owner/editor can accept. Preserve the confirmed ownership and Log Summary wording rules. Realtime coediting is optional. |
| Personal and team navigation | An activity feed primarily answers what changed. Researchers also need to resume specific work. | Saved searches, followed records/questions, bookmarks, and a dashboard of work, reviews, archival follow-ups, and recent relevant activity, all filtered through current access. |
| Citable research releases | Stable current URLs identify records, but not necessarily the exact evidence and wording another researcher used. | Produce an identified release/snapshot manifest with revisions, hashes, citations, and licence/rights statements. Public access to historical releases must still obey withdrawal and confidentiality policy. |

Every added object must participate in the existing access, disclosure, history, attribution, search, notification, backup/restore, and export rules. This integration is part of each feature's acceptance criteria.

## Changes to task descriptions

Keep the useful existing detail: file locations, domain behavior, transaction boundaries, test properties, and requirement references. Add:

- The user journey and outcome each task enables.
- Invariants and authorization rules at both read and commit time.
- API/state-machine contracts, including retries and ambiguous outcomes.
- Worst-case byte/row/memory budgets and a measured acceptance check.
- Migration and upgrade compatibility.
- Tests through the user-facing path, plus failure/recovery cases.
- Explicit milestone release gates and evidence of acceptance.

Bring Task 50's local environment forward so the team can exercise real workflows before most of the system is finished. Use walkthroughs based on the team's work: plan and resume a compute search, ingest and cite an archival document, turn discussion into a recorded decision, disagree with a summary, restrict a record, publish approved material, withdraw it, and recover the archive.

## Recommended next sequence

1. Correct the identified implementation mismatches and reconcile task status.
2. Revise consent, recovery, text storage, traffic isolation, and publication removal contracts before implementing the dependent features.
3. Make safety acceptance suites mandatory and build the local walkthrough environment.
4. Add work coordination, decision records, structured citations/provenance, and reproducible compute packages to requirements, design, and tasks together.
5. Finish the team-archive milestone and rehearse recovery before entrusting it with the sole copy of research.
6. Complete public publication and launch only after the privacy, consent, removal, infrastructure, and operational gates pass.

The direction should be retained. The next investment should make research work easier to coordinate, evidence easier to verify, and operational guarantees easier to prove.
