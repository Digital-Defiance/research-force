# Cloudflare resources as code

`resources.ts` encodes every Cloudflare resource the Research Force stack needs, for both the `production` and `staging` environments: the D1 databases; the `rf-private` and `rf-public` R2 buckets with CORS, the one-day abort-multipart lifecycle rule, `r2.dev` off and the `files.researchforce.org` custom domain; the zone rules (the `www` redirect, the files bypass-cache and response-header rules, the disabled `submit` WAF block rule and the shared `submit`/`dl` rate-limit rule); Bot Fight Mode and Always Online off; the Worker custom domains; the Access application with its `rf-members` list and allow policy; and the managed-mode Turnstile widget. It is pure data: no I/O, no network, no account access, and no real account, zone or `database_id` values. Real IDs are provisioned later (tasks 48.4/48.6).

`provision.ts` turns that plan into an ordered list of Cloudflare API calls, with account and zone IDs left as `:accountId` and `:zoneId` placeholders. It never reads credentials and never calls out.

```sh
npm run cloudflare:plan                 # dry run, both environments
node --import tsx infra/cloudflare/provision.ts --dry-run --env production
node --import tsx infra/cloudflare/provision.ts --dry-run --json
```

`--dry-run` only prints the planned calls (method, endpoint template, one-line summary and a redacted payload summary). There is **no live apply** in this task: a bare invocation prints usage and exits non-zero, provisions nothing and accesses no account. Endpoint path templates are illustrative and are not validated against a live account here.

## Secrets

`infra/secrets.ts` is the single source of truth listing every secret and installation var per Worker (`rf-app`, `rf-submit`, `rf-dl`, `rf-ops`), mirrored from the per-Worker `Env` types and wrangler configs. Production and staging must use separate credentials; the key names are the same for both.

```sh
npm run secrets:check                                  # check process.env only
node --import tsx tools/check-secrets.ts --vars .dev.vars
node --import tsx tools/check-secrets.ts --worker rf-submit
```

`check-secrets.ts` performs a local presence check only (a `.dev.vars`-style file and/or `process.env`). It accesses no Cloudflare account, never prints secret values, lists only the missing key names and exits non-zero when any required key is missing.
