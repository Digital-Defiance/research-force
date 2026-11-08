# Staging verification suites (`tests/staging/`)

The MANDATORY staging verification suites (task 48.5). They run against a **real deployed staging
installation** — a real Cloudflare account and R2 bucket, real Microsoft Graph, real
Access/Turnstile — and are the evidence the deployment gate (task 48.12 / the 68.4 checker)
consumes. They cover Requirements **1.1, 1.3, 12.10, 20.19, 20.21, 20.22, 20.24, 20.26, 24.11,
24.12, 24.16, 24.17, 28.1, 28.2, 28.6, 28.7, 28.17, 36.17, 45.21, 60.4, 60.9**.

Like `tests/presentation/` (Playwright) and `tests/security/`, these suites are authored,
type-checked, and enumerated in CI and run against a staging deployment — they are **not** part of
the Vitest unit pools.

## Gating contract (the important part)

> "missing operator infrastructure blocks the applicable gate rather than skipping tests."

When a suite's real staging endpoints and operator credentials are **absent**, the suite does **not**
`test.skip`. It reports its gate **BLOCKED/UNVERIFIED** via a failing test (`support/gate.ts`), which
the gate checker treats as "not satisfied" — never a green skip. So a build checkout with no deployed
install fails the applicable gate rather than appearing to satisfy it. The pure contract that
enforces this (`gateStatus`) is proven by `gate-contract.spec.ts`, which runs green here with no
endpoints.

## What each spec covers

| Spec | Requirements | What it verifies against staging | Gate |
| --- | --- | --- | --- |
| `gate-contract.spec.ts` | (contract) | `gateStatus` blocks (never skips/ready) on any missing handle | — (runs everywhere) |
| `access-and-bearer.spec.ts` | R1.1, R1.3 | Access redirects the Workspace host to the configured IdP; a live `/t/` or `/x/` download link admits only its own path on the download host (tampered token, other prefix and other paths are refused) and is no Workspace credential | Workspace |
| `r2-upload-checksums.spec.ts` | R12.10 | real single-part and multipart upload checksum behaviour and CORS (PUT from Workspace+apex origins with checksum headers) against the real bucket | team-archive |
| `graph-mail.spec.ts` | R20.19, R20.21, R20.22, R20.24, R20.26, R45.21, R28.17 | least-privilege send (only the ResearchForce mailbox), certificate rotation, SPF/DKIM/DMARC, acceptance-vs-delivery, MIME/plain text, no residual retention; Turnstile sitekey | outbound-mail |
| `public-change-containment.spec.ts` | R24.11, R24.12, R24.16, R24.17 | public change timing; independently verified containment across pages/index/files/People/policy/release assets; injected deploy/quota failures; old-generation retries | public-release |
| `abuse-reserve.spec.ts` | R28.1, R28.2, R28.6, R28.7, R28.17 | distributed Abuse_Profile while Members save/download; measured resource/spend reserve vs the certified profile | abuse-resilience |
| `backup-restore.spec.ts` | R36.17, R60.4 | independent encrypted backup/key recovery; fresh restore with bootstrap identity conflict, older schema, crash/resume, later suppression; sanitized evidence | recovery |
| `team-walkthroughs.spec.ts` | R60.9 | required team walkthroughs ran against the deployed staging versions and are recorded | team-acceptance |

## Running

```sh
# Enumerate the specs (no deployed install needed) — the authoring/wiring check:
npx playwright test --config playwright.staging.config.ts --list

# Run against the deployed staging install (CI/operator), with the handles below set:
npm run test:staging
```

A full, non-skipped run belongs in CI/operator context against the deployed staging versions,
because the suites drive the real Access policy, the real R2 bucket, real Microsoft Graph, the
operator containment/abuse/backup routes, and the recorded team walkthroughs. In a plain build
checkout, `--list` enumerates every suite, `gate-contract.spec.ts` runs green, and every
infrastructure-dependent suite reports its gate **BLOCKED**.

## Configuration (environment variables)

There are **no local-dev defaults** for the operator handles: a missing handle **blocks** its gate
(it does not fall back to a local origin), because staging evidence must come from the real deployed
install.

| Variable | Gate | Purpose |
| --- | --- | --- |
| `STAGING_WORKSPACE_ORIGIN` | Workspace, R2 | the authenticated Workspace origin behind Access |
| `STAGING_IDP_HOST` | Workspace | the configured Identity_Provider host the Access redirect targets |
| `STAGING_BEARER_LINK` | Workspace | the full URL of one live `/t/<token>` or `/x/<token>` download link on the download host (secret while valid; links last 15 minutes) |
| `STAGING_PUBLIC_ORIGIN` | R2, mail, containment | the apex / Public_Site origin |
| `STAGING_FILES_ORIGIN` | R2 | the public-files origin (CORS PUT origin check) |
| `STAGING_R2_ENDPOINT`, `STAGING_R2_BUCKET` | team-archive | the real R2 S3 endpoint and bucket name |
| `STAGING_R2_ACCESS_KEY_ID`, `STAGING_R2_SECRET_ACCESS_KEY`, `STAGING_R2_REGION` | team-archive | operator R2 credentials (secrets; never committed) |
| `STAGING_GRAPH_VERIFY_ENDPOINT`, `STAGING_GRAPH_VERIFY_TOKEN` | outbound-mail | the operator Graph verification route and its bearer token |
| `STAGING_SENDING_ADDRESS`, `STAGING_MAILBOX_DISPLAY_NAME` | outbound-mail | the Sending_Address and the mailbox display name (`ResearchForce`, R45.21) |
| `STAGING_TURNSTILE_SITEKEY` | outbound-mail | the configured Turnstile sitekey the forms must serve |
| `STAGING_CONTAINMENT_ENDPOINT`, `STAGING_CONTAINMENT_TOKEN` | public-release | the operator containment/timing route and its token |
| `STAGING_ABUSE_ENDPOINT`, `STAGING_ABUSE_TOKEN`, `STAGING_OPERATING_PROFILE` | abuse-resilience | the Abuse_Profile harness route, its token, and the certified operating profile |
| `STAGING_DISTRIBUTED_ABUSE_ENDPOINT`, `STAGING_DISTRIBUTED_ABUSE_TOKEN` | public launch | the distributed-abuse / removal-failure harness route and its token (`distributed-abuse.spec.ts`) |
| `STAGING_BACKUP_ENDPOINT`, `STAGING_BACKUP_TOKEN` | recovery | the operator backup/restore rehearsal route and its token |
| `STAGING_BACKUP_RECOVERY_KEY_ID`, `STAGING_BACKUP_EVIDENCE_DEST` | recovery | the independent recovery key id and the sanitized-evidence destination |
| `STAGING_WALKTHROUGH_ENDPOINT`, `STAGING_WALKTHROUGH_TOKEN` | team-acceptance | the operator walkthrough-evidence route and its token |
| `STAGING_LIVE` | — | set to `1` to mark the run as targeting the deployed staging install |

The operator tokens authorize read-only or rehearsal routes on the staging Worker; no token or secret
value is logged, and the backup/walkthrough evidence the suites read back is sanitized (counts and
verification only — no research, PII, or secrets).

## Which handles each suite needs

Only the first two rows can run today. The rest call operator routes that do not exist in the
deployed code yet, so they report BLOCKED even with every variable set.

| Suite | Runnable today | Handles it needs |
| --- | --- | --- |
| `gate-contract.spec.ts` | yes, no handles | none |
| `access-and-bearer.spec.ts` | yes | `STAGING_WORKSPACE_ORIGIN`, `STAGING_IDP_HOST`, `STAGING_BEARER_LINK` |
| `r2-upload-checksums.spec.ts` | yes | `STAGING_R2_ENDPOINT`, `STAGING_R2_BUCKET`, `STAGING_R2_ACCESS_KEY_ID`, `STAGING_R2_SECRET_ACCESS_KEY`, `STAGING_WORKSPACE_ORIGIN`, `STAGING_PUBLIC_ORIGIN` (`STAGING_FILES_ORIGIN` and `STAGING_R2_REGION` are optional) |
| `graph-mail.spec.ts` | no (route missing) | `STAGING_GRAPH_VERIFY_ENDPOINT`, `STAGING_GRAPH_VERIFY_TOKEN`, `STAGING_SENDING_ADDRESS`, `STAGING_TURNSTILE_SITEKEY`, `STAGING_PUBLIC_ORIGIN` |
| `public-change-containment.spec.ts` | no (route missing) | `STAGING_CONTAINMENT_ENDPOINT`, `STAGING_CONTAINMENT_TOKEN` |
| `abuse-reserve.spec.ts` | no (route missing) | `STAGING_ABUSE_ENDPOINT`, `STAGING_ABUSE_TOKEN`, `STAGING_OPERATING_PROFILE` |
| `distributed-abuse.spec.ts` | no (route missing) | `STAGING_DISTRIBUTED_ABUSE_ENDPOINT`, `STAGING_DISTRIBUTED_ABUSE_TOKEN` |
| `backup-restore.spec.ts` | no (route missing) | `STAGING_BACKUP_ENDPOINT`, `STAGING_BACKUP_TOKEN`, `STAGING_BACKUP_RECOVERY_KEY_ID`, `STAGING_BACKUP_EVIDENCE_DEST` |
| `team-walkthroughs.spec.ts` | no (route missing) | `STAGING_WALKTHROUGH_ENDPOINT`, `STAGING_WALKTHROUGH_TOKEN` |

The authoritative list per suite is the `describeGate(...)` call at the top of each spec.

## Recording results as launch evidence

A passing run is not evidence until it is written to `docs/acceptance/launch-evidence.json`, which
`npm run check:launch` reads. Only record what a real run produced.

```sh
# 1. Run the runnable suites against staging and keep the JSON report:
PLAYWRIGHT_JSON_OUTPUT_NAME=staging-results.json npx playwright test \
  --config playwright.staging.config.ts --reporter=json access-and-bearer r2-upload-checksums

# 2. Dry run: show what would be recorded (nothing is written):
npm run -s record:staging-results -- --results staging-results.json \
  --release <releaseId> --evidence-ref <path-to-sanitized-summary>

# 3. Record it (add --replace to overwrite an earlier entry for the same release):
npm run -s record:staging-results -- --results staging-results.json \
  --release <releaseId> --evidence-ref <path-to-sanitized-summary> --write

# Or record one entry by hand (for example a manual check):
npm run -s record:evidence -- --gate team_archive --requirement drafts_files \
  --result passed --scope deployed-staging --release <releaseId> --evidence-ref <path>
```

The mapping from spec file to gate requirement lives in one table, `RESULT_MAPPINGS` in
`tools/src/staging-results.ts`. A spec file counts only when every test in it passed. A file that
covers only part of a requirement is reported but not recorded as passed, because the requirement
would still be unproven. Failed files are recorded as `failed`; blocked, skipped or missing runs are
not recorded. The `tests/security` canary and file-safety suites and the presentation accessibility
suite are mapped but disabled: they default to local dev origins and the security suite needs the
download HMAC key, so a report cannot show they ran against staging.

The raw Playwright report can contain response text. Write a short sanitized summary (suite names and
pass/fail counts) and use that as `--evidence-ref`; the recorder refuses references or notes that look
like tokens, keys or bearer links.

## Operator mail verifier

`infra/m365/Verify-ResearchForceMail.ps1` is the read-only PowerShell sibling to
`Setup-ResearchForceMail.ps1` that an operator runs to confirm the same Graph/mail facts this
suite's `graph-mail.spec.ts` asserts through the staging route. It makes **no tenant change** and
contains no secret values or real tenant ids (parameters only).
