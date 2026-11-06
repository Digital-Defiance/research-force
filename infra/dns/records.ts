/**
 * Email DNS records as code (spec task 48.3). Pure data: a declarative description of the three
 * email-authentication DNS records `researchforce.org` needs for Microsoft 365 outbound mail —
 * the SPF TXT record, the two DKIM selector CNAMEs (DNS-only), and the DMARC TXT record. There are
 * NO side effects, NO I/O and NO network calls here; the file exports a single frozen tree plus the
 * types that describe it. `tools/check-email-dns.ts` resolves live DNS and validates against it.
 *
 * Sources for the encoded values (requirements.md items 47 and 48; design "Email"):
 *   - SPF: exactly `v=spf1 include:spf.protection.outlook.com -all` — only Microsoft 365 sends for
 *     the domain, and everything else is a hard fail (`-all`). No Cloudflare include (R20.22).
 *   - DKIM: M365 signs mail for `researchforce.org`; the two selector CNAMEs (`selector1`,
 *     `selector2`) point at the tenant's fixed M365 DKIM targets and are DNS-only / not proxied
 *     (CNAME flattening or proxying would break the delegation M365 expects) (R20.22).
 *   - DMARC: starts at `p=none` (monitor-only) with aggregate reports (`rua`) sent to an address
 *     that is NOT the Sending_Address, so report mail never loops back into the sending mailbox
 *     (R20.23).
 *
 * The tenant initial domain (`<tenant>.onmicrosoft.com`) that the DKIM targets hang off is an
 * operator input confirmed in the Microsoft 365 admin center; it is encoded as a named default
 * (`DKIM_TARGET_ZONE`, confirmed from Get-DkimSigningConfig for this tenant) and the operator overrides `records.ts` if the admin center reports different
 * targets. Requirements referenced: 20.22, 20.23.
 */

/** The DNS zone these records belong to. */
export const DOMAIN = 'researchforce.org';

/**
 * The mailbox outbound mail is sent from (the Sending_Address). The spec fixes no literal, so one
 * concrete value is chosen to mirror the `ResearchForce` mailbox display name; the M365 setup script
 * takes it as a parameter defaulting to the same value. Encoded here so the DMARC `rua` address can
 * be asserted to differ from it (R20.23).
 */
export const SENDING_ADDRESS = 'researchforce@researchforce.org';

/** The DMARC aggregate-report (`rua`) address. MUST differ from the Sending_Address (R20.23). */
export const DMARC_RUA_ADDRESS = 'dmarc-reports@researchforce.org';

/**
 * Guarantee at import time that the DMARC aggregate-report address is never the Sending_Address, so
 * report mail can never loop back into the sending mailbox (R20.23). The comparison is
 * case-insensitive because receiving mail servers treat the local part case-insensitively in
 * practice. This throws before any record is exported if the two constants are ever edited to
 * collide, turning a dangerous misconfiguration into a loud, early failure.
 */
if (DMARC_RUA_ADDRESS.toLowerCase() === SENDING_ADDRESS.toLowerCase()) {
  throw new Error(
    `DMARC_RUA_ADDRESS (${DMARC_RUA_ADDRESS}) must not equal the Sending_Address (${SENDING_ADDRESS}); ` +
      'aggregate reports would loop back into the sending mailbox (R20.23).',
  );
}

/**
 * The Microsoft 365 tenant initial domain the DKIM CNAME targets point into. This is an operator
 * input; the default is a placeholder the operator confirms against the M365 admin center and
 * overrides here if the real targets differ.
 */
export const DKIM_TARGET_ZONE = 'teammulein.n-v1.dkim.mail.microsoft';

/** The SPF record, published as a TXT record at the zone apex. */
export interface SpfTxtRecord {
  readonly kind: 'spf';
  readonly type: 'TXT';
  /** The apex host the TXT record is published at. */
  readonly host: string;
  /** The exact SPF policy string (R20.22). */
  readonly value: string;
}

/** One DKIM selector CNAME. DNS-only: never proxied/flattened or the M365 delegation breaks. */
export interface DkimCnameRecord {
  readonly kind: 'dkim';
  readonly type: 'CNAME';
  /** The selector name, e.g. `selector1`. */
  readonly selector: string;
  /** The `<selector>._domainkey.<domain>` host the CNAME is published at. */
  readonly host: string;
  /** The M365 DKIM target the CNAME points to. */
  readonly target: string;
  /** Always true: the record is published DNS-only (not proxied) (R20.22). */
  readonly dnsOnly: true;
}

/** The DMARC record, published as a TXT record at `_dmarc.<domain>`. */
export interface DmarcTxtRecord {
  readonly kind: 'dmarc';
  readonly type: 'TXT';
  /** The `_dmarc.<domain>` host the TXT record is published at. */
  readonly host: string;
  /** The DMARC policy string with `p=none` and the `rua` report address (R20.23). */
  readonly value: string;
  /** The aggregate-report address embedded in `value`; asserted to differ from the Sending_Address. */
  readonly ruaAddress: string;
}

/** The full email-DNS record set for the domain. */
export interface EmailDnsRecords {
  readonly domain: string;
  readonly spf: SpfTxtRecord;
  /** Exactly two DKIM selector CNAMEs: `selector1` and `selector2`. */
  readonly dkim: readonly DkimCnameRecord[];
  readonly dmarc: DmarcTxtRecord;
}

/** Deep-freeze helper so the exported records are immutable at runtime, not merely `readonly` in types. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Build one M365 DKIM selector CNAME. M365's target shape replaces the domain's dots with hyphens. */
function dkim(selector: string): DkimCnameRecord {
  return {
    kind: 'dkim',
    type: 'CNAME',
    selector,
    host: `${selector}._domainkey.${DOMAIN}`,
    target: `${selector}-${DOMAIN.replaceAll('.', '-')}._domainkey.${DKIM_TARGET_ZONE}`,
    dnsOnly: true,
  };
}

export const emailDnsRecords: EmailDnsRecords = deepFreeze({
  domain: DOMAIN,
  // Only Microsoft 365 is authorized; everything else hard-fails (R20.22).
  spf: {
    kind: 'spf',
    type: 'TXT',
    host: DOMAIN,
    value: 'v=spf1 include:spf.protection.outlook.com -all',
  },
  // The two M365 selector CNAMEs, DNS-only (R20.22).
  dkim: [dkim('selector1'), dkim('selector2')],
  // Monitor-only policy; reports go to a non-Sending_Address mailbox (R20.23).
  dmarc: {
    kind: 'dmarc',
    type: 'TXT',
    host: `_dmarc.${DOMAIN}`,
    value: `v=DMARC1; p=none; rua=mailto:${DMARC_RUA_ADDRESS}`,
    ruaAddress: DMARC_RUA_ADDRESS,
  },
});
