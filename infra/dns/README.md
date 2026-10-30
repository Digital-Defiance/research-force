# Email DNS records

`records.ts` encodes the three DNS records `researchforce.org` needs so Microsoft 365 can send
authenticated mail and nothing else can spoof the domain (spec task 48.3, requirements 20.22/20.23):

- **SPF** (TXT at the apex): `v=spf1 include:spf.protection.outlook.com -all` — only Microsoft 365
  is authorized; everything else hard-fails.
- **DKIM** (two CNAMEs, DNS-only): `selector1._domainkey.researchforce.org` and
  `selector2._domainkey.researchforce.org` point at the tenant's M365 DKIM targets
  (`selectorN-researchforce-org._domainkey.<tenant>.onmicrosoft.com`). These are published
  **DNS-only** (never proxied/flattened) or the M365 delegation breaks.
- **DMARC** (TXT at `_dmarc.researchforce.org`): `v=DMARC1; p=none; rua=mailto:dmarc-reports@researchforce.org`
  — monitor-only to start, with aggregate reports sent to an address that is **not** the
  Sending_Address (`researchforce@researchforce.org`).

It is pure data: no I/O, no network. The DKIM targets depend on the tenant initial domain
(`INITIAL_DOMAIN`, default `researchforce.onmicrosoft.com`); the operator confirms the real targets
in the Microsoft 365 admin center and overrides `records.ts` if they differ.

## Operator usage

```sh
npm run dns:check                                   # resolve live DNS and validate all three records
node --import tsx tools/check-email-dns.ts
```

`check-email-dns.ts` resolves the SPF/DKIM/DMARC records with `node:dns/promises` and validates each
against `records.ts`. It prints an `OK`/`FAIL` line per record and exits non-zero when any record is
missing or wrong, naming the specific failing record. The resolver is injected, so the unit tests
(`tools/test/check-email-dns.test.ts`) pass a fake resolver with synthetic responses and never touch
the network; the real resolver only runs when the CLI is invoked directly by an operator.
