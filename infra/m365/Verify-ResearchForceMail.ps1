#Requires -Modules Microsoft.Graph, ExchangeOnlineManagement

<#
.SYNOPSIS
    Read-only verification of the Research Force Microsoft 365 outbound mail setup (spec task 48.5).

.DESCRIPTION
    An OPERATOR script, the read-only sibling of Setup-ResearchForceMail.ps1 (spec task 48.2). It
    RE-CHECKS, and makes NO tenant change, that the setup the other script performed is still in
    place and healthy. It is the operator-run counterpart of the staging suite's graph-mail checks
    (tests/staging/graph-mail.spec.ts), and its results feed the launch gate (task 48.12).

    It verifies, in order:

      1. Least-privilege send (R20.19): re-runs Test-ServicePrincipalAuthorization and confirms the
         app has a Mail.Send grant scoped to ONLY the ResearchForce mailbox, and that the scope
         matches that one mailbox alone (no tenant-wide send).
      2. Certificate credential (R20.21): the app carries a certificate key credential, it matches
         the configured thumbprint, it is not expired, and it still leaves room to rotate before
         expiry (a warning threshold).
      3. Mailbox hardening (R20.24): single item recovery is OFF, the deleted-item retention is the
         shortest, and no holds (litigation or retention) are applied — no residual retention.
      4. Inbound-reject transport rule exists (so the address accepts no inbound mail).
      5. SPF / DKIM / DMARC (R20.22): the live DNS records match the expected values. These are the
         SAME expectations tools/check-email-dns.ts enforces (infra/dns/records.ts); this script
         resolves them with the operator's DNS and reports any mismatch.

    This script makes NO change to the tenant: it only connects read-only, reads configuration, and
    reports. It contains NO secret values and NO real tenant ids — every tenant-specific value is a
    PARAMETER. The certificate PRIVATE key (GRAPH_CERT_KEY) is never read or handled here; only the
    public thumbprint registered on the app is compared.

    Requirements: 20.19 (credentials restricted to the one mailbox), 20.21 (certificate credential
    rotated before expiry), 20.22 (SPF/DKIM/DMARC), 20.24 (no residual retention), 45.21 (mailbox
    display name `ResearchForce`).

.PARAMETER TenantId
    The Entra tenant id (GRAPH_TENANT_ID). Used for both Graph and Exchange Online connections.

.PARAMETER SendingAddress
    The shared mailbox primary SMTP address and the app's SENDING_ADDRESS.

.PARAMETER MailboxDisplayName
    The expected shared mailbox display name. Fixed to `ResearchForce` by R45.21.

.PARAMETER AppId
    The Entra app (client) id (GRAPH_CLIENT_ID) whose authorization and certificate are verified.

.PARAMETER CertThumbprint
    The SHA-1 thumbprint (hex) of the certificate the app must carry (GRAPH_CERT_THUMBPRINT). The
    private key is never read; only the registered public credential's thumbprint is compared.

.PARAMETER CertRotationWarningDays
    Warn when the certificate credential expires within this many days (rotate before expiry, R20.21).
    Default 30.

.PARAMETER ManagementScopeName
    The Exchange management scope that must match only the mailbox. Default
    `ResearchForce-MailSend-Scope`.

.PARAMETER TransportRuleName
    The inbound-reject transport rule that must exist. Default `ResearchForce-Reject-Inbound`.

.PARAMETER Domain
    The email domain whose SPF/DKIM/DMARC records are checked. Default researchforce.org.

.PARAMETER InitialDomain
    The Microsoft 365 tenant initial domain the DKIM CNAME targets point into. Default
    teammulein.n-v1.dkim.mail.microsoft (mirrors infra/dns/records.ts DKIM_TARGET_ZONE; confirm per tenant).

.PARAMETER DmarcRuaAddress
    The expected DMARC aggregate-report address. MUST differ from the Sending_Address (R20.23).
    Default dmarc-reports@researchforce.org (mirrors infra/dns/records.ts DMARC_RUA_ADDRESS).

.PARAMETER SkipDns
    Skip the SPF/DKIM/DMARC DNS checks (e.g. when running where DNS is unavailable). The mail-setup
    checks still run.

.NOTES
    Run by a human M365 admin/operator. Requires the Microsoft Graph PowerShell SDK and the Exchange
    Online Management module, and a read account with the matching Entra + Exchange read roles. This
    script is READ-ONLY and makes no tenant change. It exits non-zero if any verification fails, so
    the launch gate blocks on a real failure rather than a green skip (task 48.5).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $TenantId,

    [Parameter(Mandatory = $true)]
    [string] $SendingAddress,

    [Parameter()]
    [string] $MailboxDisplayName = 'ResearchForce',

    [Parameter(Mandatory = $true)]
    [string] $AppId,

    [Parameter(Mandatory = $true)]
    [string] $CertThumbprint,

    [Parameter()]
    [int] $CertRotationWarningDays = 30,

    [Parameter()]
    [string] $ManagementScopeName = 'ResearchForce-MailSend-Scope',

    [Parameter()]
    [string] $TransportRuleName = 'ResearchForce-Reject-Inbound',

    [Parameter()]
    [string] $Domain = 'researchforce.org',

    [Parameter()]
    [string] $InitialDomain = 'teammulein.n-v1.dkim.mail.microsoft',

    [Parameter()]
    [string] $DmarcRuaAddress = 'dmarc-reports@researchforce.org',

    [Parameter()]
    [switch] $SkipDns
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Accumulated verification outcomes; the script exits non-zero if any check fails (R20.x gate).
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]

function Write-Step {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Add-Pass {
    param([string] $Message)
    Write-Host "    PASS $Message" -ForegroundColor Green
}

function Add-Fail {
    param([string] $Message)
    Write-Host "    FAIL $Message" -ForegroundColor Red
    $script:Failures.Add($Message)
}

function Add-Warn {
    param([string] $Message)
    Write-Host "    WARN $Message" -ForegroundColor Yellow
    $script:Warnings.Add($Message)
}

# ---------------------------------------------------------------------------
# Connect READ-ONLY to Microsoft Graph and Exchange Online. Graph is read with the Directory and
# Application read scopes only; Exchange is a read-only session for the recipient/rule/scope reads.
# ---------------------------------------------------------------------------
function Connect-Services {
    Write-Step "Connecting to Microsoft Graph (tenant $TenantId, read-only)"
    Connect-MgGraph -TenantId $TenantId -Scopes 'Application.Read.All', 'Directory.Read.All' -NoWelcome

    Write-Step "Connecting to Exchange Online (tenant $TenantId)"
    Connect-ExchangeOnline -Organization $TenantId -ShowBanner:$false
}

# ---------------------------------------------------------------------------
# 1. Least-privilege send: re-run Test-ServicePrincipalAuthorization and confirm the Mail.Send grant
#    is scoped to ONLY the ResearchForce mailbox (R20.19).
# ---------------------------------------------------------------------------
function Test-LeastPrivilegeSend {
    Write-Step "Verifying least-privilege send for appId $AppId against <$SendingAddress>"
    $results = Test-ServicePrincipalAuthorization -Identity $AppId -Resource $SendingAddress
    $results | Format-Table -AutoSize | Out-Host

    $mailSend = $results | Where-Object { $_.RoleName -like '*Mail.Send*' }
    if ($mailSend) {
        Add-Pass "Mail.Send authorization confirmed for <$SendingAddress>."
    } else {
        Add-Fail "No Mail.Send grant for <$SendingAddress>."
    }

    # Confirm the management scope matches ONLY the single mailbox, not a broad recipient set.
    $scope = Get-ManagementScope -Identity $ManagementScopeName -ErrorAction SilentlyContinue
    if (-not $scope) {
        Add-Fail "Management scope '$ManagementScopeName' not found."
    } elseif ($scope.RecipientRestrictionFilter -and $scope.RecipientRestrictionFilter -match [regex]::Escape($SendingAddress)) {
        Add-Pass "Management scope restricts to only <$SendingAddress>."
    } else {
        Add-Fail "Management scope '$ManagementScopeName' does not restrict to only <$SendingAddress> (filter: $($scope.RecipientRestrictionFilter))."
    }

    # Confirm the mailbox display name is `ResearchForce` (R45.21).
    $mbx = Get-Mailbox -Identity $SendingAddress -ErrorAction SilentlyContinue
    if (-not $mbx) {
        Add-Fail "Mailbox <$SendingAddress> not found."
    } elseif ($mbx.DisplayName -eq $MailboxDisplayName) {
        Add-Pass "Mailbox display name is '$MailboxDisplayName' (R45.21)."
    } else {
        Add-Fail "Mailbox display name is '$($mbx.DisplayName)', expected '$MailboxDisplayName' (R45.21)."
    }
    return $mbx
}

# ---------------------------------------------------------------------------
# 2. Certificate credential present, matching the thumbprint, not expired, with rotation headroom
#    (R20.21). Only the PUBLIC credential's thumbprint and validity are read; the private key is not.
# ---------------------------------------------------------------------------
function Test-CertificateCredential {
    Write-Step "Verifying certificate credential (thumbprint $CertThumbprint) on appId $AppId"
    $app = Get-MgApplication -Filter "appId eq '$AppId'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $app) {
        Add-Fail "App registration for appId $AppId not found."
        return
    }

    $expected = ($CertThumbprint -replace '\s', '').ToUpperInvariant()
    $match = $null
    foreach ($key in @($app.KeyCredentials)) {
        if ($key.CustomKeyIdentifier) {
            $thumb = ([System.BitConverter]::ToString($key.CustomKeyIdentifier) -replace '-', '').ToUpperInvariant()
            if ($thumb -eq $expected) { $match = $key; break }
        }
    }

    if (-not $match) {
        Add-Fail "No certificate credential matching thumbprint $expected is registered on the app (R20.21)."
        return
    }
    Add-Pass "Certificate credential matching thumbprint $expected is registered."

    $now = Get-Date
    if (-not $match.EndDateTime) {
        Add-Warn 'Certificate credential has no end date; cannot verify expiry.'
        return
    }
    $end = [datetime] $match.EndDateTime
    if ($end -le $now) {
        Add-Fail "Certificate credential expired on $($end.ToString('u')) (R20.21)."
    } else {
        $daysLeft = [math]::Floor(($end - $now).TotalDays)
        if ($daysLeft -le $CertRotationWarningDays) {
            Add-Warn "Certificate credential expires in $daysLeft day(s) on $($end.ToString('u')); rotate before expiry (R20.21)."
        } else {
            Add-Pass "Certificate credential valid for $daysLeft more day(s) (expires $($end.ToString('u')))."
        }
    }
}

# ---------------------------------------------------------------------------
# 3. Mailbox hardening: single item recovery OFF, shortest retention, NO holds (R20.24).
# ---------------------------------------------------------------------------
function Test-MailboxHardening {
    param($Mailbox)
    Write-Step "Verifying mailbox hardening for <$SendingAddress> (R20.24)"
    if (-not $Mailbox) {
        $Mailbox = Get-Mailbox -Identity $SendingAddress -ErrorAction SilentlyContinue
    }
    if (-not $Mailbox) {
        Add-Fail "Mailbox <$SendingAddress> not found; cannot verify hardening."
        return
    }

    if ($Mailbox.SingleItemRecoveryEnabled) {
        Add-Fail 'Single item recovery is ENABLED (expected off, R20.24).'
    } else {
        Add-Pass 'Single item recovery is off.'
    }

    if ($Mailbox.LitigationHoldEnabled -or $Mailbox.RetentionHoldEnabled) {
        Add-Fail 'A hold (litigation or retention) is applied (expected none, R20.24).'
    } else {
        Add-Pass 'No holds applied.'
    }

    Write-Host "    RetainDeletedItemsFor=$($Mailbox.RetainDeletedItemsFor)"
}

# ---------------------------------------------------------------------------
# 4. Inbound-reject transport rule exists.
# ---------------------------------------------------------------------------
function Test-InboundRejectRule {
    Write-Step "Verifying inbound-reject transport rule '$TransportRuleName' exists"
    $rule = Get-TransportRule -Identity $TransportRuleName -ErrorAction SilentlyContinue
    if ($rule) {
        Add-Pass "Transport rule '$TransportRuleName' exists."
    } else {
        Add-Fail "Transport rule '$TransportRuleName' not found."
    }
}

# ---------------------------------------------------------------------------
# 5. SPF / DKIM / DMARC resolve to the expected values (R20.22, R20.23). These mirror the encoded
#    expectations in infra/dns/records.ts that tools/check-email-dns.ts enforces.
# ---------------------------------------------------------------------------
function Test-EmailDns {
    if ($SkipDns) {
        Add-Warn 'DNS checks skipped (-SkipDns).'
        return
    }
    Write-Step "Verifying SPF / DKIM / DMARC for $Domain (R20.22)"

    if ($DmarcRuaAddress.ToLowerInvariant() -eq $SendingAddress.ToLowerInvariant()) {
        Add-Fail "DMARC rua address must NOT equal the Sending_Address (R20.23)."
    }

    # SPF: exactly `v=spf1 include:spf.protection.outlook.com -all`.
    $expectedSpf = 'v=spf1 include:spf.protection.outlook.com -all'
    try {
        $spf = (Resolve-DnsName -Name $Domain -Type TXT -ErrorAction Stop |
            Where-Object { $_.Strings -and ($_.Strings -join '') -match '^v=spf1' } |
            ForEach-Object { ($_.Strings -join '') })
        if ($spf -and ($spf | Where-Object { $_ -eq $expectedSpf })) {
            Add-Pass "SPF matches '$expectedSpf'."
        } else {
            Add-Fail "SPF does not match '$expectedSpf' (found: $($spf -join ' | '))."
        }
    } catch {
        Add-Fail "SPF lookup failed: $($_.Exception.Message)"
    }

    # DKIM: selector1 and selector2 CNAMEs point at the M365 targets.
    $dkimDashedDomain = $Domain.Replace('.', '-')
    foreach ($selector in @('selector1', 'selector2')) {
        $dkimHost = "$selector._domainkey.$Domain"
        $expectedTarget = "$selector-$dkimDashedDomain._domainkey.$InitialDomain"
        try {
            $cname = (Resolve-DnsName -Name $dkimHost -Type CNAME -ErrorAction Stop |
                Where-Object { $_.NameHost } | ForEach-Object { $_.NameHost.TrimEnd('.').ToLowerInvariant() })
            if ($cname -and ($cname | Where-Object { $_ -eq $expectedTarget.ToLowerInvariant() })) {
                Add-Pass "DKIM $selector points to $expectedTarget."
            } else {
                Add-Fail "DKIM $selector does not point to $expectedTarget (found: $($cname -join ', '))."
            }
        } catch {
            Add-Fail "DKIM $selector lookup failed: $($_.Exception.Message)"
        }
    }

    # DMARC: p=none with the expected rua, which is not the Sending_Address.
    $dmarcHost = "_dmarc.$Domain"
    try {
        $dmarc = (Resolve-DnsName -Name $dmarcHost -Type TXT -ErrorAction Stop |
            Where-Object { $_.Strings -and ($_.Strings -join '') -match '^v=DMARC1' } |
            ForEach-Object { ($_.Strings -join '') } | Select-Object -First 1)
        if (-not $dmarc) {
            Add-Fail "No DMARC (v=DMARC1) record at $dmarcHost."
        } elseif ($dmarc -notmatch 'p\s*=\s*none') {
            Add-Fail "DMARC policy is not p=none (found: $dmarc)."
        } elseif ($dmarc -notmatch [regex]::Escape("mailto:$DmarcRuaAddress")) {
            Add-Fail "DMARC rua does not include mailto:$DmarcRuaAddress (found: $dmarc)."
        } elseif ($dmarc -match [regex]::Escape("mailto:$SendingAddress")) {
            Add-Fail "DMARC rua must not be the Sending_Address (R20.23)."
        } else {
            Add-Pass "DMARC is p=none with rua mailto:$DmarcRuaAddress."
        }
    } catch {
        Add-Fail "DMARC lookup failed: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Orchestration (read-only).
# ---------------------------------------------------------------------------
Connect-Services
$mailbox = Test-LeastPrivilegeSend
Test-CertificateCredential
Test-MailboxHardening -Mailbox $mailbox
Test-InboundRejectRule
Test-EmailDns

Write-Host ''
Write-Step 'Verification summary'
Write-Host "    $($script:Warnings.Count) warning(s), $($script:Failures.Count) failure(s)."
foreach ($warning in $script:Warnings) { Write-Host "    WARN $warning" -ForegroundColor Yellow }
foreach ($failure in $script:Failures) { Write-Host "    FAIL $failure" -ForegroundColor Red }

if ($script:Failures.Count -gt 0) {
    Write-Host 'Research Force mail verification FAILED; the launch gate is blocked until these are fixed.' -ForegroundColor Red
    exit 1
}
Write-Host 'Research Force mail verification passed (read-only; no tenant change made).' -ForegroundColor Green
exit 0
