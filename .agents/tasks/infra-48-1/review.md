# Review — Spec task 48.1: Write the Cloudflare resources as code

Branch: `infra/task-48-1-cloudflare-resources`
Worktree: `/Volumes/Code/research-force/.worktrees/infra-48-1`
Diff reviewed: `35295b2..HEAD` (commits `cefb6ec` feat, `4b26e7e` fix).

Verdict: **APPROVED** — no blocking findings.

## Scope

Diff touches only: `infra/cloudflare/{resources,provision}.ts`, `infra/cloudflare/README.md`,
`infra/secrets.ts`, `tools/check-secrets.ts`, `tools/test/cloudflare-provision.test.ts`,
`tools/tsconfig.json`, `package.json`. No file under `apps/app/web/src/files/**` or
`apps/app/src/files/**` was touched (verified by name-only diff). Stays within `infra/` and
`tools/` plus the allowed `package.json`/`tsconfig` wiring.

## Requirement verification

Resources (`resources.ts`), confirmed against the file and asserted by the test:
- D1: `rf-core`, `rf-search`, `rf-public` with `-staging` variants and bindings `RF_CORE`/`RF_SEARCH`/`RF_PUBLIC`.
- R2 `rf-private`: CORS method `PUT`; origins `https://app.researchforce.org` (Workspace) + `https://researchforce.org` (apex); allowed headers `content-length`, `x-amz-checksum-sha256`, `if-none-match`; expose `ETag`; 1-day abort-incomplete-multipart lifecycle; `publicDevAccess:false`; no custom domain.
- R2 `rf-public`: `publicDevAccess:false`; custom domain `files.researchforce.org`.
- Zone: `www`→apex 301 redirect; `files` bypass-cache rule; `files` response-header rule (`Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`); disabled (`enabled:false`) WAF block rule for `submit.researchforce.org`; shared rate-limit rule for `submit`+`dl`; zone settings `bot_fight_mode=off` and `always_online=off`.
- Worker custom domains: `rf-app`→`app.researchforce.org`, `rf-submit`→`submit.researchforce.org`, `rf-dl`→`dl.researchforce.org`; `rf-ops` has none.
- Access application on `app.researchforce.org`: `sessionDuration:'24h'`; cookie `{httpOnly:true, sameSite:'lax', enableBindingCookie:true}`; identity providers `onetimepin`, `google`, `github`; `rf-members` email list; allow policy including `rf-members`.
- Turnstile: managed-mode widget.
- Purity: single `cloudflareResources` export built from pure data; deep-frozen via a local `deepFreeze`; no I/O, network, or `process` access at module load.

Provisioner (`provision.ts`):
- `planApiCalls`/`planEnvironmentCalls` are pure, returning ordered `PlannedCall[]`. Order: D1 → R2 (bucket before its public-access/CORS/lifecycle/custom-domain) → zone rules → Access (list → application → policy) → Turnstile → Worker custom domains (last). Verified in code and by the ordering tests.
- Account/zone IDs are `:accountId`/`:zoneId` placeholders via `PLACEHOLDER_CONTEXT`; no real IDs resolved. No network import (only `node:url`).
- `--dry-run` is required; a bare invocation returns "Live provisioning is not implemented in task 48.1." with exit 1. There is NO apply/live code path at all, so nothing network-touching is reachable from dry-run or the test suite. `--json`/`--env` supported; unknown flags → usage + non-zero.

Secrets (`infra/secrets.ts`) — cross-checked name-by-name against sources:
- `rf-app`: secrets `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `DOWNLOAD_HMAC_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CERT_KEY`, `GRAPH_CERT_THUMBPRINT`, `SENDING_ADDRESS`; vars `WORKSPACE_ORIGIN`, `DOWNLOAD_ORIGIN`, `R2_ACCOUNT_ID`, `PRIVATE_BUCKET_NAME`. Matches `apps/app/src/env.ts` (ACCESS_* documented as secrets; R2/DOWNLOAD inputs) and `graph.ts` `GraphProvider.fromEnv` destructuring (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`/`GRAPH_CERT_KEY`/`GRAPH_CERT_THUMBPRINT`/`SENDING_ADDRESS`). `WORKSPACE_ORIGIN`/`DOWNLOAD_ORIGIN` present as vars in `apps/app/wrangler.jsonc`.
- `rf-submit`: secret `TURNSTILE_SECRET` only; `BUDGET`/`MAILER` correctly excluded (DO bindings in `apps/submit/src/index.ts` Env).
- `rf-dl`: secret `DOWNLOAD_HMAC_KEY`; var `WORKSPACE_ORIGIN`. Matches `apps/dl/src/index.ts` Env.
- `rf-ops`: secret `CF_ACCESS_API_TOKEN`; vars `CF_ACCOUNT_ID`, `ACCESS_MEMBER_LIST_ID`. Matches `apps/ops/src/index.ts` `OpsEnv`. This is the fix in `4b26e7e` resolving the prior CHANGES_REQUESTED finding that rf-ops was under-reported as empty — confirmed correct against the current source.

`tools/check-secrets.ts`:
- Imports `workerSecrets` (relative), exports pure `missingSecrets`/`hasMissing`/`parsePresentKeys`, local presence check against a `.dev.vars`-style file and/or `process.env`. Never prints values (test asserts the placeholder value is absent from output). Exits non-zero when any required key missing. CLI guard matches the `tools/check-specs.ts` pattern.

## Conventions
- `infra/cloudflare/` added alongside `profiles/`/`recovery/`/`releases/`, each with a README; new `README.md` follows the "nothing is provisioned" framing.
- CLI guards, ESM, `node:` imports, no new dependencies (tsx only). `tools/tsconfig.json` `rootDir` widened to `..` and the three infra files added to `include`; `package.json` gains `secrets:check` and `cloudflare:plan` scripts consistent with existing `profile:certify`/`release:*` wiring.

## Tests and recorded verification
- `tools/test/cloudflare-provision.test.ts` covers all three required groups: (a) resources shape incl. frozen/immutability, (b) provision dry-run ordering + placeholder-only + no-secret-leak + CLI exit codes, (c) check-secrets missing detection incl. rf-ops expectations and no value leakage.
- Commit messages record: `npx vitest --run tools/test/cloudflare-provision.test.ts` → 18 passed; dry-run production → 24 ordered calls, placeholders only, exit 0; bare run → usage, exit 1; `check-secrets --vars /dev/null` → missing, exit 1; complete vars → exit 0; `npm run lint` passes; `npm run typecheck` clean for infra/tools with only pre-existing unrelated `packages/db` D1Database errors remaining. Required verification is present; no re-run performed and no articulable doubt justified a spot-check.

## Non-blocking observations (not findings)
- Staging hostnames in `resources.ts` use `staging.researchforce.org` (matching `apps/app` staging `WORKSPACE_ORIGIN`), while `apps/dl` staging `WORKSPACE_ORIGIN` is `https://app-staging.researchforce.org`. This is a pre-existing inconsistency within the wrangler configs, not introduced here, and staging hostnames are not an enumerated task requirement. No production (enumerated) value is affected.
- `provision.ts` CLI guard omits the `resolve()` wrapper used in `check-specs.ts`; functionally equivalent for entrypoint detection.
