# Security tests (`tests/security/`)

Real browser security tests for the file-delivery, preview, and Download_Link paths (task 45.3).
They cover Requirements **14.6**, **14.10**, **25.5**, **25.6**, and **60.4**.

These checks are **mandatory for the team-archive (team-file) and public-release gates** (R60.4):
the public gate requires actual public-channel canaries and public browser security, not an MVP
omission. A registered constant refusal is not evidence — the suites push freshly generated canaries
through the live adapters and prove the live path refuses or neutralizes them.

## What each spec covers

| Spec | Requirement | What it proves |
| --- | --- | --- |
| `file-delivery-isolation.spec.ts` | R14.6, R14.10 | rf-dl and the public-files host deliver HTML/SVG/PDF/polyglot files inertly (attachment, `application/octet-stream` on rf-dl, `Content-Security-Policy: sandbox` + `X-Content-Type-Options: nosniff`); no script runs and no accepted cross-origin request reaches the Workspace origin as the Member; the CSP and resource-limit (oversized/invalid) failure paths refuse with the not-found response. |
| `preview-isolation.spec.ts` | R14.6, R14.9 | The Workspace serves a CSP that forbids inline and cross-origin scripts; a canary rendered as an in-page Blob/data preview does not execute and makes no Workspace-origin request. |
| `download-link-security.spec.ts` | R25.5, R25.6 | Member-bound `/t/` and `/x/` links, driven end to end through the real rf-dl verification, are refused with the host's indistinguishable 404 when expired (>15 min), when the Member is revoked, when current restricted access no longer permits the unit, when the object key is wrong, and when the purpose is wrong. |
| `channel-adapter-canaries.spec.ts` | R60.4 | The real file-delivery adapters refuse freshly signed/generated canary payloads (fresh tokens and keys each run, never a constant), and the live rf-dl delivery neutralizes delivered canary bytes. |

## Running

These are Playwright tests that need **real browsers** and the **served hosts** (the Workspace, the
rf-dl host, and the public-files host). They do not run under Vitest and are separate from the
`tests/presentation/` suite.

```sh
# Enumerate the specs (no browser or served host needed):
npx playwright test --config playwright.security.config.ts --list

# Run against the configured hosts (needs browsers + served hosts, i.e. CI/staging):
npm run test:security
```

A full, non-skipped run belongs in CI against a staging deployment, because the Workspace sits behind
Cloudflare Access and the Download_Link and canary checks need the served rf-dl/files hosts and real
content.

## Configuration (environment variables)

Origins default to the local dev/preview origins (`npm run dev`), so the suite is enumerable and
partially runnable without staging. CI/staging overrides the origins and supplies the content
handles. Checks whose handles are unset are reported **skipped** — never silently passed.

| Variable | Purpose | Default |
| --- | --- | --- |
| `SECURITY_WORKSPACE_ORIGIN` | The authenticated Workspace origin | `http://127.0.0.1:5173` |
| `SECURITY_DL_ORIGIN` | The protected-file host (rf-dl) | `http://127.0.0.1:8787` |
| `SECURITY_FILES_ORIGIN` | The public-files host | `http://127.0.0.1:5174` |
| `SECURITY_DOWNLOAD_HMAC_KEY` | rf-dl download secret, to mint real links end to end | unset → token checks skipped |
| `SECURITY_DOWNLOAD_OBJECT_KEY` | A served protected-file R2 key | unset → token checks skipped |
| `SECURITY_DOWNLOAD_MEMBER_ID` | The Member id entitled to that file | unset → token checks skipped |
| `SECURITY_EXPORT_OBJECT_KEY` | A served export/backup R2 key for the `/x/` checks | optional |
| `SECURITY_PUBLIC_FILE_PATH` | A served public Attachment path (e.g. `f/ABCD-EFGH`) | unset → public-delivery checks skipped |
| `SECURITY_REVOKED_MEMBER_ID` | A served Member whose access is revoked | unset → revocation case skipped |
| `SECURITY_RESTRICTED_OBJECT_KEY` | A served object the Member may not read (Restricted item) | unset → restricted case skipped |
| `SECURITY_WORKSPACE_STORAGE_STATE` | Playwright storage-state file for a signed-in Member | unset → preview checks skipped |

The download links are minted with the shared signer (`@researchforce/db/downloads`), the same code
rf-dl verifies with, so a drift between issuing and verifying fails the suite rather than hiding.
