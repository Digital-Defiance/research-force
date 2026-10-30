# Microsoft 365 mail setup

`Setup-ResearchForceMail.ps1` provisions the Research Force outbound mail setup in Microsoft 365
(spec task 48.2). In one run it:

- creates the shared mailbox `ResearchForce` at the Sending_Address;
- registers (or reuses) the Entra app and attaches the **public** certificate as a key credential,
  granting **no** organization-wide Mail.Send consent;
- creates the Exchange service principal, a management scope matching **only** that one mailbox, and
  the `Application Mail.Send` role assignment bound to that scope (least privilege), then runs
  `Test-ServicePrincipalAuthorization` to confirm the app can send only as the mailbox;
- hardens the mailbox: single item recovery off, the shortest deleted-item retention, no holds;
- adds a transport rule that rejects inbound mail to the address with an explanation of how to
  respond.

Requirements: 20.19, 20.21, 20.24, 45.21.

This script is run **later by a human Microsoft 365 admin** (spec task 48.7). Nothing in this
repository executes it.

## Secrets and the certificate

The application reads these names (see `apps/app/src/mail/providers/graph.ts` and `infra/secrets.ts`):
`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CERT_KEY`, `GRAPH_CERT_THUMBPRINT`, `SENDING_ADDRESS`.

`GRAPH_CERT_KEY` is the certificate **private** key (PKCS#8 PEM) and stays a Cloudflare Workers
secret — this script never reads or handles it. The script registers only the matching **public**
certificate (`-CertPublicKeyPath`) on the app registration. Rotate the certificate credential before
it expires (R20.21).

## Operator usage

Prerequisites: the [Microsoft Graph PowerShell SDK](https://learn.microsoft.com/powershell/microsoftgraph/installation)
and the [Exchange Online Management module](https://learn.microsoft.com/powershell/exchange/exchange-online-powershell-v2),
and an account with the required Entra + Exchange Online admin roles.

```powershell
./Setup-ResearchForceMail.ps1 `
    -TenantId        '<GRAPH_TENANT_ID>' `
    -SendingAddress  'researchforce@researchforce.org' `
    -AppDisplayName  'Research Force Mail Sender' `
    -CertPublicKeyPath './researchforce-mail.cer' `
    -CertThumbprint  '<GRAPH_CERT_THUMBPRINT>'
```

Run it with `-WhatIf` first to preview the changes. `-SendingAddress` defaults to
`researchforce@researchforce.org`; the spec fixes no literal, so confirm the value against your
tenant. Review the `Test-ServicePrincipalAuthorization` output at the end to confirm the app is
authorized to send only as the `ResearchForce` mailbox.

Content was rephrased for compliance with licensing restrictions.
