#Requires -Modules Microsoft.Graph, ExchangeOnlineManagement

<#
.SYNOPSIS
    Provisions the Research Force Microsoft 365 outbound mail setup (spec task 48.2).

.DESCRIPTION
    An OPERATOR script, run later by a human Microsoft 365 admin (spec task 48.7). Nothing in this
    repository executes it. It performs, in order and with guarded/idempotent operations where
    practical:

      1. Creates the shared mailbox `ResearchForce` at the Sending_Address.
      2. Registers (or reuses) the Entra app registration and attaches the PUBLIC certificate as a
         key credential. It grants NO organization-wide Mail.Send admin consent.
      3. Creates the Exchange service principal for the app, a management scope that matches ONLY the
         single mailbox, and the `Application Mail.Send` role assignment bound to that scope
         (least privilege — no tenant-wide send rights), then runs Test-ServicePrincipalAuthorization.
      4. Hardens the mailbox: single item recovery off, the shortest deleted-item retention, no holds.
      5. Adds a transport rule that rejects inbound mail to the address with an explanation of how to
         respond.

    Requirements: 20.19 (credentials restricted to the one mailbox), 20.21 (certificate credential
    rotated before expiry), 20.24 (no residual retention / Sent Items disclosure), 45.21 (mailbox
    display name `ResearchForce`).

    The application reads these env/secret NAMES in apps/app/src/mail/providers/graph.ts
    (GraphProvider.fromEnv), mirrored in infra/secrets.ts:
      GRAPH_TENANT_ID        - the app registration tenant id.
      GRAPH_CLIENT_ID        - the app registration client id.
      GRAPH_CERT_KEY         - the certificate PRIVATE key (PKCS#8 PEM). A Workers secret; NEVER
                               handled by this script. Only the matching PUBLIC certificate is
                               registered on the app here.
      GRAPH_CERT_THUMBPRINT  - the SHA-1 thumbprint (hex) of that certificate.
      SENDING_ADDRESS        - the mailbox mail is sent from (this script's -SendingAddress).

.PARAMETER TenantId
    The Entra tenant id (GRAPH_TENANT_ID). Used for both Graph and Exchange Online connections.

.PARAMETER SendingAddress
    The shared mailbox primary SMTP address and the app's SENDING_ADDRESS. Default
    researchforce@researchforce.org (mirrors the ResearchForce mailbox display name; the spec fixes
    no literal, so confirm against your tenant).

.PARAMETER MailboxDisplayName
    The shared mailbox display name. Fixed to `ResearchForce` by R45.21.

.PARAMETER MailboxAlias
    The shared mailbox alias. Defaults to the local part of the Sending_Address.

.PARAMETER AppDisplayName
    The Entra app registration display name to create or reuse.

.PARAMETER AppId
    Optional existing app (client) id (GRAPH_CLIENT_ID) to reuse instead of creating a new one.

.PARAMETER CertPublicKeyPath
    Path to the PUBLIC certificate (.cer/.crt, DER or PEM) to register as the app's key credential.
    The private key (GRAPH_CERT_KEY) stays a Workers secret and is never read here.

.PARAMETER CertThumbprint
    The SHA-1 thumbprint (hex) of that certificate (GRAPH_CERT_THUMBPRINT), used for logging and to
    confirm the registered credential matches the Worker secret.

.PARAMETER ManagementScopeName
    Name of the Exchange management scope that matches only the mailbox. Default
    `ResearchForce-MailSend-Scope`.

.PARAMETER RoleAssignmentName
    Name of the `Application Mail.Send` role assignment. Default `ResearchForce-MailSend-Assignment`.

.PARAMETER TransportRuleName
    Name of the inbound-reject transport rule. Default `ResearchForce-Reject-Inbound`.

.PARAMETER ResponseInstructions
    The explanation text senders see when their inbound mail is rejected: how to respond instead of
    replying. Defaults to directing Submitters to the submission form / response link and Members to
    the Workspace.

.NOTES
    Run by a human M365 admin (spec task 48.7). Requires the Microsoft Graph PowerShell SDK and the
    Exchange Online Management module, and an account with Global Administrator (or the matching
    Entra + Exchange admin roles). This script makes real tenant changes; review before running.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string] $TenantId,

    [Parameter()]
    [string] $SendingAddress = 'researchforce@researchforce.org',

    [Parameter()]
    [string] $MailboxDisplayName = 'ResearchForce',

    [Parameter()]
    [string] $MailboxAlias,

    [Parameter()]
    [string] $AppDisplayName = 'Research Force Mail Sender',

    [Parameter()]
    [string] $AppId,

    [Parameter()]
    [string] $CertPublicKeyPath,

    [Parameter()]
    [string] $CertThumbprint,

    [Parameter()]
    [string] $ManagementScopeName = 'ResearchForce-MailSend-Scope',

    [Parameter()]
    [string] $RoleAssignmentName = 'ResearchForce-MailSend-Assignment',

    [Parameter()]
    [string] $TransportRuleName = 'ResearchForce-Reject-Inbound',

    [Parameter()]
    [string] $ResponseInstructions = @'
This mailbox does not accept replies and is not monitored. To reach Research Force:
  - Submitters: use the response link in the message you received, or the outside submission form.
  - Members: post in the Workspace instead of replying by email.
Messages sent to this address are not read.
'@
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $MailboxAlias) { $MailboxAlias = ($SendingAddress -split '@')[0] }

function Write-Step {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 1. Connect to Microsoft Graph and Exchange Online.
#    Graph scopes cover app-registration + service-principal management; the mailbox, management
#    scope, role assignment, hardening and transport rule are all Exchange Online operations.
# ---------------------------------------------------------------------------
function Connect-Services {
    Write-Step "Connecting to Microsoft Graph (tenant $TenantId)"
    Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'Directory.Read.All' -NoWelcome

    Write-Step "Connecting to Exchange Online (tenant $TenantId)"
    Connect-ExchangeOnline -Organization $TenantId -ShowBanner:$false
}

# ---------------------------------------------------------------------------
# 2. Create the shared mailbox `ResearchForce` at the Sending_Address (guarded: reuse if present).
#    R45.21: display name `ResearchForce`.
# ---------------------------------------------------------------------------
function New-ResearchForceMailbox {
    Write-Step "Ensuring shared mailbox '$MailboxDisplayName' <$SendingAddress>"
    $existing = Get-Mailbox -Identity $SendingAddress -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "    Mailbox already exists; leaving it in place."
        return $existing
    }
    if ($PSCmdlet.ShouldProcess($SendingAddress, 'New-Mailbox -Shared')) {
        New-Mailbox -Shared -Name $MailboxDisplayName -DisplayName $MailboxDisplayName `
            -Alias $MailboxAlias -PrimarySmtpAddress $SendingAddress | Out-Null
    }
    return Get-Mailbox -Identity $SendingAddress
}

# ---------------------------------------------------------------------------
# 3. Register (or reuse) the app and attach the PUBLIC certificate credential.
#    NO organization-wide Mail.Send admin consent is granted here: send rights come solely from the
#    mailbox-scoped Exchange role assignment in step 4 (least privilege, R20.19). The private key
#    (GRAPH_CERT_KEY) is a Workers secret and is never read; only the public certificate is attached
#    (R20.21 — rotate this credential before expiry).
# ---------------------------------------------------------------------------
function Register-MailApp {
    Write-Step "Ensuring app registration '$AppDisplayName'"
    $app = $null
    if ($AppId) {
        $app = Get-MgApplication -Filter "appId eq '$AppId'" -ErrorAction SilentlyContinue
    }
    if (-not $app) {
        $app = Get-MgApplication -Filter "displayName eq '$AppDisplayName'" -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if (-not $app) {
        if ($PSCmdlet.ShouldProcess($AppDisplayName, 'New-MgApplication')) {
            $app = New-MgApplication -DisplayName $AppDisplayName -SignInAudience 'AzureADMyOrg'
        }
    } else {
        Write-Host "    App already exists (appId $($app.AppId)); reusing it."
    }

    # Attach the PUBLIC certificate as a key credential (guarded by thumbprint so re-runs are idempotent).
    if ($CertPublicKeyPath) {
        if (-not (Test-Path -LiteralPath $CertPublicKeyPath)) {
            throw "CertPublicKeyPath not found: $CertPublicKeyPath"
        }
        $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertPublicKeyPath)
        $thumb = $cert.Thumbprint
        if ($CertThumbprint -and ($CertThumbprint -replace '\s', '').ToUpperInvariant() -ne $thumb.ToUpperInvariant()) {
            throw "CertThumbprint ($CertThumbprint) does not match the certificate at CertPublicKeyPath ($thumb)."
        }
        $current = Get-MgApplication -ApplicationId $app.Id
        $already = $current.KeyCredentials | Where-Object { $_.CustomKeyIdentifier -and ([System.BitConverter]::ToString($_.CustomKeyIdentifier) -replace '-', '') -eq $thumb }
        if ($already) {
            Write-Host "    Certificate credential (thumbprint $thumb) already registered; leaving it."
        } elseif ($PSCmdlet.ShouldProcess($app.DisplayName, "Add certificate credential $thumb")) {
            $keyCredential = @{
                Type                = 'AsymmetricX509Cert'
                Usage               = 'Verify'
                Key                 = $cert.RawData
                DisplayName         = "ResearchForce mail cert $thumb"
                CustomKeyIdentifier = $cert.GetCertHash()
            }
            $keys = @($current.KeyCredentials) + $keyCredential
            Update-MgApplication -ApplicationId $app.Id -KeyCredentials $keys
        }
    } else {
        Write-Warning 'No -CertPublicKeyPath supplied; skipping certificate registration. Register the public cert before go-live.'
    }

    # IMPORTANT: no Mail.Send application permission grant / admin consent is created here.
    Write-Host "    No organization-wide Mail.Send consent granted (send rights are mailbox-scoped in step 4)."
    return $app
}

# ---------------------------------------------------------------------------
# 4. Exchange service principal + mailbox-only management scope + scoped Application Mail.Send
#    assignment (least privilege: the app may send ONLY as this one mailbox), then verify.
# ---------------------------------------------------------------------------
function Grant-ScopedMailSend {
    param([Parameter(Mandatory = $true)] $App)

    $appId = $App.AppId
    $objectId = $App.Id

    Write-Step "Ensuring Exchange service principal for appId $appId"
    $sp = Get-ServicePrincipal -Identity $appId -ErrorAction SilentlyContinue
    if (-not $sp) {
        if ($PSCmdlet.ShouldProcess($appId, 'New-ServicePrincipal')) {
            $sp = New-ServicePrincipal -AppId $appId -ObjectId $objectId -DisplayName $AppDisplayName
        }
    } else {
        Write-Host "    Exchange service principal already exists."
    }

    Write-Step "Ensuring management scope '$ManagementScopeName' matching ONLY <$SendingAddress>"
    # RecipientFilter restricts the scope to the single mailbox by its primary SMTP address.
    $recipientFilter = "PrimarySmtpAddress -eq '$SendingAddress'"
    $scope = Get-ManagementScope -Identity $ManagementScopeName -ErrorAction SilentlyContinue
    if (-not $scope) {
        if ($PSCmdlet.ShouldProcess($ManagementScopeName, 'New-ManagementScope')) {
            $scope = New-ManagementScope -Name $ManagementScopeName -RecipientRestrictionFilter $recipientFilter
        }
    } else {
        Write-Host "    Management scope already exists."
    }

    Write-Step "Ensuring '$RoleAssignmentName' (Application Mail.Send) scoped to that mailbox"
    $assignment = Get-ManagementRoleAssignment -Identity $RoleAssignmentName -ErrorAction SilentlyContinue
    if (-not $assignment) {
        if ($PSCmdlet.ShouldProcess($RoleAssignmentName, 'New-ManagementRoleAssignment')) {
            New-ManagementRoleAssignment -Name $RoleAssignmentName -App $appId `
                -Role 'Application Mail.Send' -CustomResourceScope $ManagementScopeName | Out-Null
        }
    } else {
        Write-Host "    Role assignment already exists."
    }

    Test-MailSendAuthorization -AppId $appId
}

# ---------------------------------------------------------------------------
#    Helper: verify the service principal is authorized to send only as the mailbox.
# ---------------------------------------------------------------------------
function Test-MailSendAuthorization {
    param([Parameter(Mandatory = $true)] [string] $AppId)

    Write-Step "Test-ServicePrincipalAuthorization for appId $AppId against <$SendingAddress>"
    $results = Test-ServicePrincipalAuthorization -Identity $AppId -Resource $SendingAddress
    $results | Format-Table -AutoSize | Out-Host

    $mailSend = $results | Where-Object { $_.RoleName -like '*Mail.Send*' }
    if (-not $mailSend) {
        Write-Warning "Test-ServicePrincipalAuthorization returned no Mail.Send grant for <$SendingAddress>. Review the scope and assignment above."
    } else {
        Write-Host "    Mail.Send authorization confirmed for <$SendingAddress>." -ForegroundColor Green
    }
    return $results
}

# ---------------------------------------------------------------------------
# 5. Mailbox hardening: single item recovery OFF, shortest deleted-item retention, NO holds (R20.24).
# ---------------------------------------------------------------------------
function Set-MailboxHardening {
    Write-Step "Hardening mailbox <$SendingAddress>: single item recovery off, shortest retention, no holds"
    if ($PSCmdlet.ShouldProcess($SendingAddress, 'Set-Mailbox hardening')) {
        # Shortest deleted-item retention Exchange Online accepts is 1 day.
        Set-Mailbox -Identity $SendingAddress `
            -SingleItemRecoveryEnabled $false `
            -RetainDeletedItemsFor '1.00:00:00' `
            -RetentionHoldEnabled $false `
            -LitigationHoldEnabled $false
    }

    $mbx = Get-Mailbox -Identity $SendingAddress
    if ($mbx.SingleItemRecoveryEnabled) { Write-Warning 'Single item recovery is still enabled.' }
    if ($mbx.LitigationHoldEnabled -or $mbx.RetentionHoldEnabled) { Write-Warning 'A hold is still applied to the mailbox.' }
    Write-Host "    SingleItemRecovery=$($mbx.SingleItemRecoveryEnabled) RetainDeletedItemsFor=$($mbx.RetainDeletedItemsFor)"
}

# ---------------------------------------------------------------------------
# 6. Inbound-reject transport rule with an explanation of how to respond (guarded: reuse if present).
# ---------------------------------------------------------------------------
function New-InboundRejectRule {
    Write-Step "Ensuring transport rule '$TransportRuleName' rejecting inbound mail to <$SendingAddress>"
    $existing = Get-TransportRule -Identity $TransportRuleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "    Transport rule already exists; leaving it in place."
        return $existing
    }
    if ($PSCmdlet.ShouldProcess($TransportRuleName, 'New-TransportRule')) {
        New-TransportRule -Name $TransportRuleName `
            -SentTo $SendingAddress `
            -RejectMessageReasonText $ResponseInstructions `
            -RejectMessageEnhancedStatusCode '5.7.1' | Out-Null
    }
    return Get-TransportRule -Identity $TransportRuleName
}

# ---------------------------------------------------------------------------
# Orchestration.
# ---------------------------------------------------------------------------
Connect-Services
$null = New-ResearchForceMailbox
$app = Register-MailApp
Grant-ScopedMailSend -App $app
Set-MailboxHardening
$null = New-InboundRejectRule

Write-Step 'Research Force mail setup complete. Review the Test-ServicePrincipalAuthorization output above.'
