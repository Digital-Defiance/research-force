import { describe, expect, it } from 'vitest';
import { DMARC_RUA_ADDRESS, emailDnsRecords, SENDING_ADDRESS, type EmailDnsRecords } from '../../infra/dns/records';
import { checkAll, runCli, type DnsResolver } from '../check-email-dns';

/**
 * A fake, network-free `DnsResolver` built from in-memory maps. A host mapped to `undefined` (or
 * absent) rejects with an ENOTFOUND-style error, mirroring a missing record.
 */
function fakeResolver(options: {
  txt?: Record<string, string[][]>;
  cname?: Record<string, string[]>;
}): DnsResolver {
  const txt = options.txt ?? {};
  const cname = options.cname ?? {};
  return {
    resolveTxt: async (host) => {
      const value = txt[host];
      if (!value) throw Object.assign(new Error(`queryTxt ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return value;
    },
    resolveCname: async (host) => {
      const value = cname[host];
      if (!value) throw Object.assign(new Error(`queryCname ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return value;
    },
  };
}

/** A resolver whose responses exactly match the encoded records (the happy path). */
function correctResolver(records: EmailDnsRecords = emailDnsRecords): DnsResolver {
  return fakeResolver({
    txt: {
      [records.spf.host]: [[records.spf.value]],
      [records.dmarc.host]: [[records.dmarc.value]],
    },
    cname: Object.fromEntries(records.dkim.map((dkim) => [dkim.host, [dkim.target]])),
  });
}

describe('email DNS records data', () => {
  it('encodes the exact SPF policy', () => {
    expect(emailDnsRecords.spf.value).toBe('v=spf1 include:spf.protection.outlook.com -all');
    expect(emailDnsRecords.spf.type).toBe('TXT');
    expect(emailDnsRecords.spf.host).toBe('researchforce.org');
  });

  it('encodes the two DNS-only DKIM selector CNAMEs with the M365 targets', () => {
    expect(emailDnsRecords.dkim.map((d) => d.selector)).toEqual(['selector1', 'selector2']);
    for (const dkim of emailDnsRecords.dkim) {
      expect(dkim.type).toBe('CNAME');
      expect(dkim.dnsOnly).toBe(true);
      expect(dkim.host).toBe(`${dkim.selector}._domainkey.researchforce.org`);
      expect(dkim.target).toBe(`${dkim.selector}-researchforce-org._domainkey.researchforce.onmicrosoft.com`);
    }
  });

  it('encodes a p=none DMARC with a rua that is not the Sending_Address', () => {
    expect(emailDnsRecords.dmarc.host).toBe('_dmarc.researchforce.org');
    expect(emailDnsRecords.dmarc.value).toContain('p=none');
    expect(emailDnsRecords.dmarc.value).toContain(`rua=mailto:${DMARC_RUA_ADDRESS}`);
    expect(emailDnsRecords.dmarc.ruaAddress).toBe(DMARC_RUA_ADDRESS);
    // The rua address must differ from the Sending_Address so report mail never loops back (R20.23).
    // records.ts enforces this at import time; importing the module above would have thrown otherwise.
    expect(DMARC_RUA_ADDRESS.toLowerCase()).not.toBe(SENDING_ADDRESS.toLowerCase());
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(emailDnsRecords)).toBe(true);
    expect(Object.isFrozen(emailDnsRecords.dkim)).toBe(true);
    expect(() => {
      (emailDnsRecords.dkim as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

describe('check-email-dns CLI with an injected fake resolver', () => {
  it('exits 0 and reports all three records validate when every record is correct', async () => {
    const result = await runCli([], { resolver: correctResolver() });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('All email DNS records for researchforce.org validate.');
    expect(result.output).toContain('OK   SPF');
    expect(result.output).toContain('OK   DKIM selector1');
    expect(result.output).toContain('OK   DKIM selector2');
    expect(result.output).toContain('OK   DMARC');
  });

  it('refuses unexpected arguments with usage and a non-zero exit', async () => {
    const result = await runCli(['--oops'], { resolver: correctResolver() });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Usage:');
  });

  it('fails and names the SPF record when the SPF value is wrong (missing -all)', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [['v=spf1 include:spf.protection.outlook.com ~all']],
        [emailDnsRecords.dmarc.host]: [[emailDnsRecords.dmarc.value]],
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL SPF');
    expect(result.output).toContain('v=spf1 include:spf.protection.outlook.com -all');
  });

  it('fails and names the specific DKIM selector when its CNAME is missing', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        [emailDnsRecords.dmarc.host]: [[emailDnsRecords.dmarc.value]],
      },
      // selector1 present, selector2 absent → selector2 lookup rejects.
      cname: { [emailDnsRecords.dkim[0]!.host]: [emailDnsRecords.dkim[0]!.target] },
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DKIM selector2');
    expect(result.output).toContain('OK   DKIM selector1');
  });

  it('fails and names the specific DKIM selector when its CNAME points elsewhere', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        [emailDnsRecords.dmarc.host]: [[emailDnsRecords.dmarc.value]],
      },
      cname: {
        [emailDnsRecords.dkim[0]!.host]: [emailDnsRecords.dkim[0]!.target],
        // selector2 resolves, but to someone else's target (e.g. a stray/attacker CNAME).
        [emailDnsRecords.dkim[1]!.host]: ['selector2-impostor._domainkey.evil.example.com'],
      },
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DKIM selector2');
    expect(result.output).toContain(emailDnsRecords.dkim[1]!.target);
    expect(result.output).toContain('evil.example.com');
    expect(result.output).toContain('OK   DKIM selector1');
  });

  it('fails and names the DMARC record when it is absent entirely', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        // No TXT published at _dmarc.<domain> → the lookup rejects (ENOTFOUND).
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DMARC');
    expect(result.output).toContain('OK   SPF');
  });

  it('fails and names the DMARC record when a p=none record omits the rua', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        [emailDnsRecords.dmarc.host]: [['v=DMARC1; p=none']],
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DMARC');
    expect(result.output).toContain('rua');
  });

  it('fails and names the DMARC record when the rua equals the Sending_Address', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        [emailDnsRecords.dmarc.host]: [[`v=DMARC1; p=none; rua=mailto:${SENDING_ADDRESS}`]],
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DMARC');
    expect(result.output).toContain('must NOT be the Sending_Address');
  });

  it('fails and names the DMARC record when the policy is not p=none', async () => {
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[emailDnsRecords.spf.value]],
        [emailDnsRecords.dmarc.host]: [[`v=DMARC1; p=reject; rua=mailto:${DMARC_RUA_ADDRESS}`]],
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const result = await runCli([], { resolver });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('FAIL DMARC');
    expect(result.output).toContain('p=none');
  });

  it('joins multi-chunk TXT records before comparing', async () => {
    const half = emailDnsRecords.spf.value.slice(0, 10);
    const rest = emailDnsRecords.spf.value.slice(10);
    const resolver = fakeResolver({
      txt: {
        [emailDnsRecords.spf.host]: [[half, rest]],
        [emailDnsRecords.dmarc.host]: [[emailDnsRecords.dmarc.value]],
      },
      cname: Object.fromEntries(emailDnsRecords.dkim.map((dkim) => [dkim.host, [dkim.target]])),
    });
    const results = await checkAll(emailDnsRecords, resolver);
    expect(results.find((r) => r.record.startsWith('SPF'))!.ok).toBe(true);
  });
});
