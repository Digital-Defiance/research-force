# Operator setup runbook — Cloudflare, DNS, and Microsoft 365

This is the step-by-step runbook for the operator-gated setup tasks of the
`research-collab-cms` spec that cannot be run by the build agent because they need
real account access:

- **48.6** — Cloudflare account: provision resources and set Worker secrets.
- **48.8** — DNS for `researchforce.org`: publish SPF/DKIM/DMARC and verify.
- **48.7** — Microsoft 365 administrator: run the mail setup (separate tenant-admin access).

Everything these steps invoke is already built, type-checked, and dry-run-verified in the
repository. Nothing here is destructive until you reach an explicit apply step, and every
check/plan command below is read-only or prints-only.

> **Separate credentials per environment.** Production and staging must use **separate**
> Cloudflare credentials, R2 keys, and Microsoft 365 app registrations. The key *names* are
> the same for both; the *values* are not. Do every step once per environment you are
> standing up.

---

## Prerequisites

- Node 22.16+ and the repo installed: `npm ci` from the repo root.
- A Cloudflare account with the `researchforce.org` zone, and permission to create D1, R2,
  Workers, Access, Turnstile, and zone rules.
- `wrangler` authenticated to that account (`npx wrangler login`), or an API token with the
  scopes the resources need.
- For 48.7: a Microsoft 365 **Global Administrator** (or the matching Entra + Exchange admin
  roles), the Microsoft Graph PowerShell SDK, and the Exchange Online Management module.

---

## Part 1 — Cloudflare (task 48.6)

### 1.1 Review the plan (no account access)

The full resource plan lives in `infra/cloudflare/resources.ts`. Print the ordered list of
Cloudflare API calls it implies, with account/zone IDs left as `:accountId` / `:zoneId`
placeholders — this makes **no** network or account call:

```sh
npm run cloudflare:plan                                              # both environments
node --import tsx infra/cloudflare/provision.ts --dry-run --env production
node --import tsx infra/cloudflare/provision.ts --dry-run --json     # machine-readable
```

Read the output. It enumerates: the three D1 databases (`rf-core`, `rf-search`, `rf-public`);
the two R2 buckets (`rf-private` with PUT CORS from the Workspace+apex origins and the
one-day abort-multipart lifecycle rule; `rf-public` with `r2.dev` off and the
`files.researchforce.org` custom domain); the zone rules (the `www`→apex 301 redirect, the
`files` bypass-cache and response-header rules, the **disabled** `submit` WAF block rule, the
shared `submit`/`dl` rate-limit rule); Bot Fight Mode **off** and Always Online **off**; the
Worker custom domains for `rf-app`/`rf-submit`/`rf-dl`; the Access application with its
24-hour session, one-time PIN / Google / GitHub providers, the `rf-members` list and the
allow policy; and the managed-mode Turnstile widget.

> The endpoint path templates in the dry run are illustrative; use them as a checklist of what
> to create, and apply them through `wrangler` and the Cloudflare dashboard/API as your
> account setup prefers. (The spec deliberately does not ship a live "apply" that touches your
> account.)

### 1.2 Create the resources

Working from the plan, create each resource in your account. The exact names and settings are
in `infra/cloudflare/resources.ts` (the single source of truth). In particular, confirm:

- `r2.dev` managed access is **off** on both buckets.
- `rf-public` is served through the `files.researchforce.org` custom domain only.
- `rf-private` CORS allows `PUT` from `https://app.researchforce.org` and
  `https://researchforce.org` with the `content-length`, `x-amz-checksum-sha256`, and
  `if-none-match` headers, and has the 1-day abort-incomplete-multipart lifecycle rule.
- The `submit` WAF block rule is created **disabled** (rf-ops toggles it; it is not left on).
- **Bot Fight Mode is off** and **Always Online is off** (both would corrupt the public
  archive's behavior — R45.18).
- `workers.dev` / preview URLs are **off** for every Worker.

### 1.3 Set the Worker secrets and vars

`infra/secrets.ts` is the single source of truth for every secret and installation var each
Worker needs. Check what is still missing against a local `.dev.vars`-style file or the
current `process.env`:

```sh
npm run secrets:check                                   # checks process.env only
node --import tsx tools/check-secrets.ts --vars .dev.vars
node --import tsx tools/check-secrets.ts --worker rf-submit
```

It prints **only the missing key names**, never any value, and exits non-zero while anything
is missing. Set each one with `wrangler secret put` per Worker, e.g.:

```sh
npx wrangler secret put R2_ACCESS_KEY_ID        --name rf-app
npx wrangler secret put DOWNLOAD_HMAC_KEY       --name rf-app     # SAME value in rf-dl
npx wrangler secret put DOWNLOAD_HMAC_KEY       --name rf-dl
npx wrangler secret put TURNSTILE_SECRET        --name rf-submit
npx wrangler secret put CF_ACCESS_API_TOKEN     --name rf-ops
# …one per key in infra/secrets.ts, per Worker
```

Keys to note:
- `DOWNLOAD_HMAC_KEY` must be the **same value** in `rf-app` and `rf-dl`.
- `rf-ops` carries narrowly-scoped Cloudflare API tokens (Access list edit, analytics read,
  site deploy, the public-host WAF deny for containment, the submit-host WAF for the budget
  shed) and an independent incident-alert credential. Scope each token to **this account
  only** and the **narrowest** resource it needs.
- Plaintext installation inputs (`WORKSPACE_ORIGIN`, `R2_ACCOUNT_ID`, `CF_ACCOUNT_ID`,
  `ACCESS_MEMBER_LIST_ID`, the containment/WAF ruleset+rule IDs, etc.) go in wrangler `vars`,
  not `secret put`.

Re-run `npm run secrets:check` until it exits 0.

### 1.4 Final Cloudflare checks (task 48.6 acceptance)

- Re-run `npm run secrets:check` → exits 0 (every required key present).
- Confirm in the dashboard: `workers.dev`/preview off, Bot Fight Mode off, Always Online off,
  `r2.dev` off on both buckets.
- Report the results (which resources exist, which secrets are set) back for the launch-gate
  evidence.

---

## Part 2 — DNS for researchforce.org (task 48.8)

The three records are encoded in `infra/dns/records.ts`. **DKIM targets depend on your
Microsoft 365 tenant initial domain** — confirm the real targets in the M365 admin center
(Settings → Domains → `researchforce.org` → DKIM) and, if the tenant initial domain is not
`researchforce.onmicrosoft.com`, update `INITIAL_DOMAIN` in `infra/dns/records.ts` first.

### 2.1 Publish these records in the Cloudflare DNS dashboard

| Type | Name | Value | Proxy |
| --- | --- | --- | --- |
| TXT | `researchforce.org` (apex) | `v=spf1 include:spf.protection.outlook.com -all` | n/a |
| CNAME | `selector1._domainkey` | `selector1-researchforce-org._domainkey.<tenant>.onmicrosoft.com` | **DNS only** |
| CNAME | `selector2._domainkey` | `selector2-researchforce-org._domainkey.<tenant>.onmicrosoft.com` | **DNS only** |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc-reports@researchforce.org` | n/a |

Rules that matter:
- The SPF record ends in `-all` (hard fail) and names **only** `spf.protection.outlook.com`.
  Do not add a Cloudflare include.
- The two DKIM CNAMEs must be **DNS only** (grey cloud) — if Cloudflare proxies or flattens
  them, the M365 delegation breaks.
- The DMARC `rua` address must **not** be the Sending_Address (`researchforce@researchforce.org`),
  so report mail never loops back into the sending mailbox. `records.ts` enforces this at
  import time.
- After publishing, enable **DKIM signing** for `researchforce.org` in the M365 admin center
  (this is the switch that activates the selectors you just pointed at).

### 2.2 Verify

```sh
npm run dns:check          # resolves live DNS and validates all three records
```

It prints an `OK`/`FAIL` line per record and exits non-zero naming any record that is missing
or wrong. Paste the output back here if you want me to read it. DNS can take time to
propagate; re-run until all three are `OK`.

---

## Part 3 — Microsoft 365 mail (task 48.7) — needs a tenant admin

This one needs **Microsoft 365 Global Administrator** access (separate from Cloudflare). The
script is `infra/m365/Setup-ResearchForceMail.ps1`; its companion verifier is
`infra/m365/Verify-ResearchForceMail.ps1`. See `infra/m365/README.md` for the full parameter
list.

1. Preview first with `-WhatIf`:
   ```powershell
   ./infra/m365/Setup-ResearchForceMail.ps1 -TenantId '<GRAPH_TENANT_ID>' -WhatIf
   ```
2. Run it for real (creates the shared `ResearchForce` mailbox, registers the app with the
   **public** certificate credential and **no** org-wide Mail.Send consent, creates the
   mailbox-scoped `Application Mail.Send` assignment, hardens the mailbox, adds the
   inbound-reject transport rule):
   ```powershell
   ./infra/m365/Setup-ResearchForceMail.ps1 `
       -TenantId '<GRAPH_TENANT_ID>' `
       -SendingAddress 'researchforce@researchforce.org' `
       -CertPublicKeyPath './researchforce-mail.cer' `
       -CertThumbprint '<GRAPH_CERT_THUMBPRINT>'
   ```
3. Wait 30 minutes – 2 hours, then re-run `Test-ServicePrincipalAuthorization` (the script
   prints how), check the **Tenant Outbound External Recipients** report, and set the
   Recipient_Cap below the tenant's shared external limit.
4. Store the Graph tenant id, client id, and the certificate **private** key as `rf-app`
   Workers secrets (`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CERT_KEY`,
   `GRAPH_CERT_THUMBPRINT`) — the private key never leaves the Workers secret store; the setup
   script only ever handles the public certificate.

---

## What comes after setup

Once Cloudflare, DNS, and M365 are done, the remaining spec tasks are:

- **48.11** — bootstrap an isolated **staging** install (`tools/bootstrap.ts`), with a
  synthetic identity and independent recovery keys.
- **48.12** — run the real acceptance suites against staging and retain the evidence:
  `npm run test:staging`, the `tests/perf/` harness (`node --import tsx tests/perf/run.ts
  --assert-certified` with the `PERF_*` handles set), the recovery rehearsal
  (`node --import tsx tools/recovery/rehearse.ts` with the `RF_RECOVERY_*` handles set), and
  the R60.9 team walkthroughs.
- **48.9** — activate production scopes only after the launch-gate checker certifies them:
  ```sh
  npm run check:launch team_archive public_archive outside_services
  ```
  This reads the recorded evidence ledger and refuses any scope whose gate is not satisfied by
  real deployed-scope evidence. A dry run with no evidence reports every gate **BLOCKED** — that
  is the correct, honest state until you have run 48.11/48.12.

Report results from each step and I can help interpret the check output and decide the next
move.
