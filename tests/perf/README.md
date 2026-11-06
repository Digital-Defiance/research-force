# Capacity / performance certification harness (`tests/perf/`)

The capacity suite (task 46.2) that **certifies the selected `Resource_Profile`** against the
`Reference_Archive` and the allowed worst-case inputs. It covers Requirements **R21.2, R28.1, R28.2,
R28.3, R28.4, R28.5, R28.6, R28.7, R28.8, R28.15, R28.17, R30.6, R36.17, R60.7**.

Like `tests/presentation/` (Playwright) and `tests/staging/`, a full **measured** run executes
against a **real deployed/benchmark environment** with a real `Reference_Archive` — a real Cloudflare
account, D1, R2, and the measured curator corpus. That environment does not exist in a plain build
checkout, so this harness is authored, type-checked, and **enumerable** here, and draws an honest
line between the two kinds of certification.

## The honest contract (the important part)

> A profile is certified only by **real measured evidence**. No measured number is ever fabricated,
> and a profile that fails cannot be advertised or deployed for that scope.

Each certification case is one of:

- **MEASURED-here** (`verified_here`) — a **pure / derivable** fact recomputed from the shared
  `packages/domain/src/resource-profile.ts` contract every run (encoded-byte and fragment budgets via
  `encodedJsonBytes`, provider-limit-vs-chosen-margin ordering, the `publicBudget`/`admission` reserve
  math, and the 1/3/5-year growth arithmetic reused from `tools/src/profile-certification.ts`). These
  need no environment and are asserted with real deterministic checks.
- **BLOCKED-pending-real-environment** (`blocked_pending_environment`) — a **runtime measurement**
  against the real environment/`Reference_Archive` (worst-case CPU and peak isolate memory, actual D1
  calls/statements/rows and database growth, the common-term 50 MB search latency with large result
  pages, the 1,000-unit preview path, the 100-file submission path, the publisher epoch/removal, the
  live 30-minute distributed `Abuse_Profile`, and the verified independent RPO/RTO restore). When its
  environment handles are absent, the case is reported **BLOCKED** — a **non-pass** the gate treats as
  "not certified". This is never a green skip and never a stand-in number.

The gate (`support/measurement.ts` → `certify`) mirrors the staging `gateStatus` contract exactly: a
profile is **CERTIFIED only when every case is measured**. In a build checkout the blocked cases are
the expected, honest state — the harness run **succeeds** (it proved the pure facts and honestly
reported the rest) while the **verdict is NOT CERTIFIED** for the blocked scope (R28.17, R60.7).

## Running

```sh
# Dry enumeration + pure checks (this build checkout — no environment needed):
node --import tsx tests/perf/run.ts

# Machine-readable evidence record (profile/versions/assumptions + every case's state and data):
node --import tsx tests/perf/run.ts --json

# Real benchmark/operator environment, full launch gate (exits non-zero unless fully certified):
PERF_BENCHMARK_ENDPOINT=... PERF_BENCHMARK_TOKEN=... PERF_REFERENCE_ARCHIVE=... \
PERF_ABUSE_ENDPOINT=... PERF_ABUSE_TOKEN=... PERF_OPERATING_PROFILE=... \
PERF_CORPUS_ENDPOINT=... PERF_RESTORE_ENDPOINT=... PERF_RESTORE_TOKEN=... PERF_RECOVERY_KEY_ID=... \
  node --import tsx tests/perf/run.ts --assert-certified
```

The harness is a standalone `node`/`tsx` runner. It is **not** part of the Vitest unit pools: the
`vitest.config.ts` projects include only `packages/*/test`, `apps/*/test`, `tools/test`, and the web
dirs, so `tests/perf/**` never runs as a unit test (exactly like `tests/staging`). It type-checks via
the tooling project (`tsconfig.tooling.json` includes `tests/perf/**/*.ts`).

## What each file covers

| File | Certifies | State here |
| --- | --- | --- |
| `cases/profile-budgets.perf.ts` | worst-case Unicode/spans/chunks encoded bytes & fragments; 100-file/draft-proposal graph inputs; worst-case save statement budget (R21.2, R28.2, R28.3, R28.8) | MEASURED-here |
| `cases/provider-margins.perf.ts` | every chosen safety margin sits within its documented provider limit, each labelled (R28.1, R28.3, R28.15, R60.7) | MEASURED-here |
| `cases/abuse-reserve.perf.ts` | `Abuse_Profile` envelope consistency + the pure `reserve`/`settle`/`charge`/`shed` reserve math (R28.5, R28.6, R28.7); the **live** flood (R28.1, R28.17) | MEASURED-here + BLOCKED |
| `cases/growth.perf.ts` | 1/3/5-year growth reproduction (R28.4, R28.8); the **measured corpus** and the **RPO/RTO restore** (R36.17) | MEASURED-here + BLOCKED |
| `cases/measured-environment.perf.ts` | worst-case CPU/memory, actual D1 usage/growth, 50 MB search latency, 1,000-unit preview, 100-file submission, publisher epoch/removal (R28.3, R28.6, R28.15, R30.6) | BLOCKED |

`support/` holds the pure measurement model and gate, the worst-case derivation, the
provider-vs-margin accounting, the abuse reserve walk, and the growth reproduction.

## Environment variables (all absent → the applicable case is BLOCKED, never faked)

| Variable | Case | Purpose |
| --- | --- | --- |
| `PERF_BENCHMARK_ENDPOINT`, `PERF_BENCHMARK_TOKEN`, `PERF_REFERENCE_ARCHIVE` | CPU/memory, D1 usage/growth, search, preview, 100-file, epoch | the real benchmark harness route, its token, and the `Reference_Archive` id |
| `PERF_ABUSE_ENDPOINT`, `PERF_ABUSE_TOKEN`, `PERF_OPERATING_PROFILE` | live `Abuse_Profile` | the distributed-flood harness route, its token, and the certified profile |
| `PERF_CORPUS_ENDPOINT` | measured current corpus | the real corpus-measurement route |
| `PERF_RESTORE_ENDPOINT`, `PERF_RESTORE_TOKEN`, `PERF_RECOVERY_KEY_ID` | RPO/RTO restore | the isolated fresh-restore rehearsal route, its token, and the independent recovery key id |

No handle has a local-dev default: a missing handle **blocks** its case, because measured evidence
must come from the real environment. Operator tokens authorize read-only/rehearsal routes; no secret
or research payload is logged, and the growth/forecast inputs here are illustrative templates, not a
measured corpus.
