/**
 * Live DNS check for the email-authentication records (spec task 48.3). It resolves the SPF TXT,
 * the two DKIM selector CNAMEs and the DMARC TXT for `researchforce.org` and validates each against
 * the encoded expectations in `infra/dns/records.ts`: the SPF value must match exactly, each DKIM
 * CNAME must point at its expected M365 target, and the DMARC record must be `p=none` with a `rua`
 * address that is NOT the Sending_Address (R20.22, R20.23).
 *
 * The DNS resolver is INJECTED: `runCli` and the check helpers take a `DnsResolver`, so tests pass a
 * fake with synthetic responses and never touch the network. The real resolver wraps
 * `node:dns/promises` and is constructed ONLY inside the entrypoint guard at the bottom — it is never
 * built at import time, so importing this module in a test performs no network access.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailDnsRecords, SENDING_ADDRESS, type EmailDnsRecords } from '../infra/dns/records';

/**
 * The two lookups the checker needs, shaped to match `node:dns/promises`:
 *   - `resolveTxt` returns an array of TXT records, each split into one or more string chunks;
 *   - `resolveCname` returns the CNAME target hostnames.
 * Either may reject (e.g. `ENOTFOUND`/`ENODATA`) when a record is missing.
 */
export interface DnsResolver {
  resolveTxt(host: string): Promise<string[][]>;
  resolveCname(host: string): Promise<string[]>;
}

/** One record's validation outcome. `record` names the specific record so failures are actionable. */
export interface CheckResult {
  readonly record: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Join the multi-string chunks of a single TXT record into one string (DNS splits long TXT values). */
function joinTxt(chunks: readonly string[]): string {
  return chunks.join('');
}

/** Normalize a hostname for comparison: lowercase and strip a single trailing dot. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/u, '');
}

/** Validate the SPF TXT record equals the expected policy string exactly. */
export async function checkSpf(records: EmailDnsRecords, resolver: DnsResolver): Promise<CheckResult> {
  const record = `SPF (TXT ${records.spf.host})`;
  let txts: string[][];
  try {
    txts = await resolver.resolveTxt(records.spf.host);
  } catch (error) {
    return { record, ok: false, detail: `lookup failed: ${(error as Error).message}` };
  }
  const values = txts.map(joinTxt);
  const spfValues = values.filter((value) => value.toLowerCase().startsWith('v=spf1'));
  if (spfValues.length === 0) return { record, ok: false, detail: `no SPF (v=spf1) TXT record found at ${records.spf.host}` };
  if (spfValues.length > 1) return { record, ok: false, detail: `multiple SPF records found (RFC 7208 allows one): ${spfValues.join(' | ')}` };
  const actual = spfValues[0]!;
  if (actual !== records.spf.value) return { record, ok: false, detail: `expected "${records.spf.value}" but found "${actual}"` };
  return { record, ok: true, detail: `matches "${records.spf.value}"` };
}

/** Validate each DKIM selector CNAME resolves to its expected M365 target (case/dot tolerant). */
export async function checkDkim(records: EmailDnsRecords, resolver: DnsResolver): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const dkim of records.dkim) {
    const record = `DKIM ${dkim.selector} (CNAME ${dkim.host})`;
    let targets: string[];
    try {
      targets = await resolver.resolveCname(dkim.host);
    } catch (error) {
      results.push({ record, ok: false, detail: `lookup failed: ${(error as Error).message}` });
      continue;
    }
    const expected = normalizeHost(dkim.target);
    const found = targets.map(normalizeHost);
    if (found.includes(expected)) results.push({ record, ok: true, detail: `points to ${dkim.target}` });
    else results.push({ record, ok: false, detail: `expected CNAME target ${dkim.target} but found ${targets.length ? targets.join(', ') : '(none)'}` });
  }
  return results;
}

/** Validate the DMARC TXT record is `p=none`, carries the expected `rua`, and the rua is not the Sending_Address. */
export async function checkDmarc(records: EmailDnsRecords, resolver: DnsResolver): Promise<CheckResult> {
  const record = `DMARC (TXT ${records.dmarc.host})`;
  let txts: string[][];
  try {
    txts = await resolver.resolveTxt(records.dmarc.host);
  } catch (error) {
    return { record, ok: false, detail: `lookup failed: ${(error as Error).message}` };
  }
  const values = txts.map(joinTxt);
  const dmarcValues = values.filter((value) => value.toLowerCase().startsWith('v=dmarc1'));
  if (dmarcValues.length === 0) return { record, ok: false, detail: `no DMARC (v=DMARC1) TXT record found at ${records.dmarc.host}` };
  if (dmarcValues.length > 1) return { record, ok: false, detail: `multiple DMARC records found (only one is valid): ${dmarcValues.join(' | ')}` };
  const actual = dmarcValues[0]!;
  const tags = new Map(
    actual
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.includes('='))
      .map((part) => {
        const eq = part.indexOf('=');
        return [part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim()] as const;
      }),
  );
  const policy = tags.get('p');
  if (policy !== 'none') return { record, ok: false, detail: `expected p=none but found p=${policy ?? '(missing)'}` };
  const rua = tags.get('rua');
  const expectedRua = `mailto:${records.dmarc.ruaAddress}`;
  if (!rua) return { record, ok: false, detail: 'missing rua aggregate-report address' };
  const ruaAddresses = rua.split(',').map((entry) => entry.trim());
  // Report an address-reuse violation specifically, before the generic expected-rua mismatch (R20.23).
  if (ruaAddresses.some((entry) => entry.toLowerCase() === `mailto:${SENDING_ADDRESS.toLowerCase()}`)) {
    return { record, ok: false, detail: `rua report address must NOT be the Sending_Address (${SENDING_ADDRESS})` };
  }
  if (!ruaAddresses.some((entry) => entry.toLowerCase() === expectedRua.toLowerCase())) {
    return { record, ok: false, detail: `expected rua ${expectedRua} but found ${rua}` };
  }
  return { record, ok: true, detail: `p=none with rua ${expectedRua}` };
}

/** Run all three checks and return the per-record results. */
export async function checkAll(records: EmailDnsRecords, resolver: DnsResolver): Promise<readonly CheckResult[]> {
  const [spf, dkim, dmarc] = await Promise.all([checkSpf(records, resolver), checkDkim(records, resolver), checkDmarc(records, resolver)]);
  return [spf, ...dkim, dmarc];
}

function formatResults(results: readonly CheckResult[]): string {
  return results.map((result) => `${result.ok ? 'OK  ' : 'FAIL'} ${result.record}: ${result.detail}`).join('\n');
}

export interface RunCliDeps {
  readonly resolver: DnsResolver;
  readonly records?: EmailDnsRecords;
}

export async function runCli(argv: readonly string[], deps: RunCliDeps): Promise<{ readonly output: string; readonly exitCode: number }> {
  if (argv.length > 0) {
    return { output: 'Usage: tools/check-email-dns.ts  (resolves live DNS; no arguments)', exitCode: 1 };
  }
  const records = deps.records ?? emailDnsRecords;
  const results = await checkAll(records, deps.resolver);
  const failed = results.filter((result) => !result.ok);
  const header =
    failed.length === 0
      ? `All email DNS records for ${records.domain} validate.`
      : `Email DNS validation failed for ${records.domain} (${failed.length} of ${results.length} record(s)):`;
  return { output: `${header}\n${formatResults(results)}`, exitCode: failed.length === 0 ? 0 : 1 };
}

/** The real resolver, built only at the entrypoint so importing this module performs no DNS. */
async function defaultResolver(): Promise<DnsResolver> {
  const dns = await import('node:dns/promises');
  return {
    resolveTxt: (host) => dns.resolveTxt(host),
    resolveCname: (host) => dns.resolveCname(host),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resolver = await defaultResolver();
  const result = await runCli(process.argv.slice(2), { resolver });
  if (result.exitCode === 0) console.log(result.output);
  else console.error(result.output);
  process.exitCode = result.exitCode;
}
