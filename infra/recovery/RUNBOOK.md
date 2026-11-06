# Fresh-environment recovery rehearsal — operator runbook

_Task 58.5 · Requirements R36.12, R36.13, R36.15, R36.16, R36.17, R60.4, R60.6, R60.9._

This runbook describes how an operator rehearses restoring an Internal_Backup into an **isolated
fresh environment**, demonstrating the recovery objectives, and how the resulting evidence feeds the
launch gate. The rehearsal tooling is `tools/recovery/rehearse.ts`. It orchestrates the real restore
primitives — it does not reimplement them — and makes **no account, key, or network call itself**.

## The two things that are NOT acceptance

Record this at the top of every rehearsal, because the requirement (R36.17) is explicit:

1. **A package download alone is NOT a recovery test.** Delivery of package bytes — a manual
   download, a copy sitting in a bucket — proves nothing about whether it restores.
2. **An application-only alert is NOT a recovery test.** An in-app backup-age alert (the 18h warning
   / 24h breach of R36.7) tells you a point is stale; it is not a restore into a fresh environment.

Acceptance is **only** a live restore into a fresh **isolated** environment that **completed and
verified**, within the **≤24-hour RPO** and the **≤8-hour Reference_Archive RTO**. The tooling enforces
this in `acceptanceRejection(...)`; both non-acceptances are rejected there and in the CLI verdict.

## Schedule (R36.17)

Run the full live rehearsal:

- **Quarterly**, at minimum; and
- **Before any breaking storage or identity change** (a schema contraction, a bootstrap/identity
  model change, a backup-format change). The release pipeline (`assertContraction`) already requires a
  matching fresh restore rehearsal within 24 hours before a destructive contraction.

Retain each rehearsal record as immutable evidence. A record is sanitized: counts, hashes, schema,
independent-copy age, elapsed time, and failures only — never a research body, bearer link, or recovery
secret (R60.6).

## What the operator must supply (independent of the production account)

The FULL rehearsal runs against **independent replacement infrastructure**, an **independent
inventory**, and **operator-held recovery keys** — none of which live in the repository or the
production account. Supply them as environment handles (the tool reads handles, never production
secrets):

| Handle (env var)                     | What it is                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `RF_RECOVERY_INDEPENDENT_INVENTORY`  | Path to the independent deployment inventory (see `deployment.example.json`). |
| `RF_RECOVERY_REPLACEMENT_INFRA`      | Handle/descriptor for the independent replacement infrastructure (a fresh, empty install). |
| `RF_RECOVERY_KEY_IDS`                | The recovery-key custodian **identifiers** held outside the production account. Identifiers only — never key bytes (R36.17). |
| `RF_RECOVERY_INDEPENDENT_COPY`       | The verified independent copy the restore reads from (not the production account's own bucket). |

Recovery keys are referenced **by identifier only**. The tool never reads, prints, or records key
bytes. The recovery-key custody model lives outside production (R36.13, task 58.1); this runbook only
consumes identifiers.

When any handle is absent, the live restore cases are reported **BLOCKED** — a non-pass, never a green
skip and never a fabricated result. This mirrors the staging gate contract in
`tests/staging/support/gate.ts`.

## How to run `rehearse.ts`

Dry / enumerate mode (what runs in CI and a build checkout — exercises the deterministic decisions,
reports the live cases BLOCKED, makes no account/key access):

```sh
node --import tsx tools/recovery/rehearse.ts
```

Live mode (operator, with the independent environment configured):

```sh
RF_RECOVERY_INDEPENDENT_INVENTORY=/path/to/independent-inventory.json \
RF_RECOVERY_REPLACEMENT_INFRA=independent://fresh-install \
RF_RECOVERY_KEY_IDS=recovery-key-id-1,recovery-key-id-2 \
RF_RECOVERY_INDEPENDENT_COPY=independent://verified-copy \
node --import tsx tools/recovery/rehearse.ts
```

In live mode the operator drives the actual restore **inside the independent replacement install** (the
app-side restore job: preflight → bootstrap reconcile → resumable insert under checkpoints → quarantine
→ explicit release), then records the measured elapsed time, the verified independent-copy age, and the
sanitized counts/hashes. This tool orchestrates and records that run; it does not re-run app code across
the `tools → apps/app` import boundary.

## The scenarios the rehearsal exercises (R36.17)

Each required failure scenario must be demonstrated. The **pure, deterministic decisions** are asserted
here with synthetic fixtures and in-memory SQLite (so they are proven in every environment, including
CI); the **live restore and the measured RPO/RTO** are proven only against the independent environment
and are BLOCKED otherwise.

| Scenario                        | Proven here (deterministic)                         | Needs the live environment |
| ------------------------------- | --------------------------------------------------- | -------------------------- |
| Production-account loss         | —                                                   | restore into fresh replacement infra |
| Older backup format             | schema transform selection (R36.16)                 | full restore through the transform |
| Same-email new bootstrap id     | reconcile maps onto the original id (R36.15)        | applied in the live bootstrap txn |
| Bootstrap-identity conflict     | preflight refuses the conflict (R36.8)              | — |
| Corruption                      | preflight refuses a tampered manifest (R36.8)       | byte-level refusal in situ |
| Every checkpoint interruption   | rollback + resume exactly once (in-memory engine)   | under real restore load |
| Post-snapshot withdrawal        | later suppression re-applied; not resurrected       | honoured in the live rebuild |
| Measured RPO / RTO              | classification logic (`classifyRpo`/`classifyRto`)  | the measured values themselves |

## How to read the restore proof

A successful live rehearsal produces a **restore proof** shaped like
`infra/recovery/restore-proof.example.json`: the counts / hashes / references / authorization / consent /
suppression / bootstrapIdentity checks must all be `true`, `freshIsolatedEnvironment` must be `true`,
`completedAt` and `verificationDigest` must be set. A proof with `freshIsolatedEnvironment: false`, any
check `false`, or a null `completedAt`/`verificationDigest` is **not** acceptance — it is a download or a
partial run, which the schema (`restoreRehearsalSchema`) and the release pipeline both reject.

## How the evidence feeds the 68.4 launch gate

The runtime launch-gate checker (`tools/check-launch.ts`, `tools/src/launch-gates.ts`) requires an
`infra-restore` evidence entry for the `team_archive` gate's `independent_recovery` requirement (and the
final checkpoint's `final_restore`). That entry is satisfied **only** by a passing rehearsal run against a
**real deployed scope** (`deployed-staging` / `deployed-production`). `rehearse.ts` maps its record to
that evidence via `rehearsalEvidence(...)`:

- a verified live rehearsal within RPO/RTO → `result: passed`, `scope: deployed-production`;
- a dry/sandbox run (or any download / alert-only input) → `result: blocked`, `scope: local-synthetic`,
  which the checker reads as **not satisfied**.

So a dry run, a package download, or an application alert can never certify the recovery gate. Only the
operator's real fresh-environment restore, with its measured RPO/RTO, can.

## Verification in this build checkout

- `node --import tsx tools/recovery/rehearse.ts` exits cleanly, makes no account/key/network access, and
  reports the two live cases BLOCKED.
- `npx vitest run tools/test/recovery-rehearse.test.ts` asserts the deterministic scenarios pass and the
  live cases are BLOCKED (never faked), and that a download-only / alert-only input is rejected as
  acceptance.
