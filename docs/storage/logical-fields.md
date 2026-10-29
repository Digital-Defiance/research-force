# Immutable logical fields

Task 57.3 adds core migration `0010_logical_fields.sql` and search migration `0003_logical_search.sql`. Both expand the existing schema. Earlier applied migrations remain unchanged, and legacy text/spans and original Revision bytes remain readable. There is no destructive contraction or automatic deployment.

## Field format and ownership

`packages/domain/src/text-fragments.ts` defines `rich-text-v1`. Text pieces and label-manifest pieces are independently bounded to 128,000 encoded UTF-8 bytes, including JSON escaping/metadata. Text cuts preserve code points; text is never trimmed, normalized, or assigned new section IDs. Labels retain global UTF-16 offsets and their original ordering. Sources, language marks and mentions stay attached to their logical ranges across cuts.

The field manifest records exact UTF-16/code-point totals, label count, and an ordered list of piece kinds, ordinals, ranges and SHA-256 digests. Digests use canonical JSON key order; identical part retries may reorder JSON keys. Unknown shapes, missing/reordered pieces, changed bytes/ranges, unsupported formats and inconsistent totals are refused. Schema-specific logical limits remain separate from the physical layout. Keep this format's budgets/readers when changing Resource_Profile; a new storage format needs explicit compatibility/reader coverage.

`field_versions`, `text_fragments` and `span_manifest_parts` contain immutable prepared data. A version seals only after authoritative read-back and complete semantic validation; SQL checks also prevent a missing/mismatched piece from sealing. Ordinary trusted preparation streams its read-back because the original RichText already passed validation. Part-wise staging uses `beginFieldVersion`, `putFieldFragment` and `sealFieldVersion`; the final seal validates the reconstructed logical field. Prepared versions grant no read permission and become visible only through a guarded current pointer or retained reference.

`DatabaseFieldReader` requires an explicit authorized `(ownerType, ownerId, field)` and rejects another owner's reference. Authorize through the existing current Can_Read/owner path before creating the reader. There is no public field-ID lookup route. Current record, thread, search and projection adapters preserve the original logical owner/field. Projection materialization rejects a reference belonging to a different unit or field before the ordinary kernel handles rights, consent, suppression and personal data.

## Atomicity and retention

A guarded save switches `field_current` together with its domain writes. Mirrored fields retain exact inline values throughout expansion; an old compatible writer's legacy value stays authoritative if it changes the mirror. Version-only pointers are the cutover mechanism for bounded transport. Activating that transport and its full staging/atomic-save integration remains task 19.1; do not let retired consumers write version-only values.

Large previous values are stored as retained field/JSON references, keeping new Revision rows within the complete encoded budget, including their metadata. History/compare/restoration resolves the references before using the existing logical history model. A legacy-history backfill adds an immutable sidecar; it preserves the original Revision ID, sequence and bytes. Retention rows are scoped to the exact Revision/slot, so copying an arbitrary reference into history cannot grant access. Ordinary inline Revisions remain readable.

`field_references` accounts for immutable revision, citation, proposal, draft-version, release and backup dependencies. Its holder/slot cannot silently move to a different version. Mutable current values use `field_current`; future workflows must retain their exact immutable versions explicitly. Current pointers, retained references and live leases block collection. Prepared writes hold a 120-second lease. Streaming readers reserve a 30-second scoped lease, renew after at most 10 seconds between batches and release it on completion/cancellation; explicit leases accept 1–120 seconds. Authorized GC uses a transaction-scoped permit, respects freeze, and cannot remove a retained or actively leased version. A failed save leaves unreachable prepared data for later reference-safe cleanup rather than publishing a partial field.

## Readers and output

* Record/thread adapters read canonical version-only values after normal authorization, with an additional current-read fence for multi-step Item reads.
* The kernel adapter materializes stored references before projection; it does not add visibility or change unit identity.
* `printJournalParts` streams exact original Markdown through the existing logical sections/separator rules. It does not parse individual physical fragments as separate Markdown documents.
* Public continuation helpers split an already projected/rendered tree. They preserve containers and marks, retain IDs once, resolve cross-page anchors, return canonical/previous/next addresses and enforce a maximum 20 MiB HTML page. They do not render private database rows or bypass the future Publisher.
* `boundedEnvelopes` counts complete JSON envelopes, including metadata and escaping, for browser/view/export adapters. Export, backup, citation and draft implementations use the shared scoped reader/immutable-reference contract rather than copying oversized values into rows.

Full private API/staging transport cutover remains 19.1. The owning end-to-end property suite is 57.6. Authenticated backup formats/readers, independent recovery, publication orchestration and later collaboration features retain their explicit tasks; these storage primitives do not certify those gates.

## Logical search

Large search documents have bounded raw text/label pieces and a prepared token-index generation. The metadata/head batch exposes only a complete generation; physical pieces never become new results or disclosure units. Terms may occur in different pieces. Phrase matching uses a versioned shared normalized token stream, carried across physical boundaries, with bounded repeated token context. Hex-encoded normalized tokens avoid a tokenizer treating a physical cut as a word break. A bounded long-token prefix covers every permitted query; a Unicode decomposition-bound test guards the normalization assumption. Raw text and label offsets remain unchanged for excerpts.

Existing small documents retain the legacy index during expansion. The query path handles both representations, preserves title/newest ordering and pagination, and checks each candidate's current core unit/root and deletion/access state before reconstructing an excerpt. Restriction/deletion therefore does not wait for asynchronous reindexing. Derived old generations remain rebuildable; operational retention and capacity certification are separate mandatory tasks.

## Existing-data migration

`migrateLegacyFieldSlice` inventories the registered RichText columns and legacy Revisions. Each slice handles at most one source row, stores bounded immutable pieces, verifies the source revision and checkpoint generation, and commits the pointer/sidecar and cursor together. It changes no original text, label, unit/section/member ID, Revision sequence or original previous-value bytes, and sends no notifications. A changed source/checkpoint refuses the link; prepared data remains unreachable. A definition change needs a new migration identity.

For a disposable local recovery copy:

```sh
npm run release:write
npm run release:rehearse
npm run fields:migrate -- --local /absolute/rehearsal/core-10.sqlite --max-slices 2
npm run fields:migrate -- --local /absolute/rehearsal/core-10.sqlite
```

Use the actual temporary directory printed by the rehearsal. The command rejects recovery copies, unrelated databases and remote targets. It resumes the durable cursor. Production D1 execution is an explicit deployment-adapter action using the same slice function, with actual backup/capacity/operator evidence. Never rewrite an applied migration to install this feature.
