# Running your own installation

The Research Force software is reusable: anyone can run their own independent
installation. The code is the same for every installation; the public identity,
editorial copy, policy statements, initial Project, Responsible Person, and
content licence are **validated installation configuration** that each operator
supplies. The software never presents ResearchForce.org's organizational claims
for another installation, and there is no ResearchForce.org fallback: a missing
or partial configuration refuses site generation, publication, and
licence-agreement collection rather than borrowing those values.

This guide covers the public-facing configuration an installation must provide,
how to migrate and upgrade it, and the separation between the software licence
(MIT) and the content licence.

## 1. Software vs. content licensing

These are two different things and must not be conflated.

- **Software licence (MIT).** The code and development documentation are MIT
  licensed (`LICENSE`). Bundled third-party software and fonts keep their own
  licences and required notices (`NOTICE.md`; the SIL Open Font License grants
  are vendored under `packages/design/fonts/licences/`).
- **Content licence (configured per installation).** Research records,
  attachments, imported journals, and everything in the archive keep their own
  rights. Before any content is published or any licence agreement is collected,
  the operator configures the **Content_Licence**: its name and the address of
  its full text. The public archive's `LICENSE.txt` always carries this
  configured content licence, **never** the MIT software licence by default. No
  content licence is selected for ResearchForce.org yet, and the software licence
  is never used as a fallback.

A change to the content licence still requires the existing current-licence
checks and renewed author agreements; it does not relabel earlier grants or
third-party material.

## 2. Installation_Public_Copy

`Installation_Public_Copy` is one versioned, digest-addressed configuration
object that carries the installation's public identity and editorial copy:

- `version` — a UTC date (`YYYY-MM-DD`) of the last change to any field.
- `name` — the masthead display name (header and start of the home page).
- `strapline` — the masthead strapline.
- `mission` — `{ heading, paragraphs[] }`, shown on the home page **before**
  Featured Projects.
- `about` — the About prose paragraphs. Bootstrap copies these into the required
  "About the group" Policy_Section; later edits use the normal
  preview/Revision/activity/publication workflow.
- `principles` — the ordered Principles, each `{ name, text }`. Shown in order on
  the About page after the fixed legal/status section.

Validation (`validatePublicCopy` in `@researchforce/design/installation`) is
total and rejects: any missing or blank field, a missing mission heading, an
empty mission or an empty About or Principles list, and a missing or **duplicate**
principle name. `assertPublicCopy` returns the bundle with its content `digest`
or throws a `PublicCopyError` that lists every unmet rule.

The `version` and `digest` feed the affected pages' last-updated dates and the
Publisher's invalidation (R40.12): a copy-only release re-publishes the home
page, About page, header/footer derivatives, metadata that names the site, print
output, and exports that include policy pages.

### Configuring it

The installation worker reads the bundle from the `PUBLIC_COPY` environment
binding as a JSON string, alongside the content-licence bindings:

```
PUBLIC_COPY          # JSON of the Installation_Public_Copy bundle (see above)
CONTENT_LICENCE_NAME # e.g. "Creative Commons Attribution 4.0"
CONTENT_LICENCE_URL  # full-text address the name links to on public pages
```

Set these as per-installation Wrangler vars or secrets at deploy time; they are
deliberately **not** committed to `wrangler.jsonc`, so no installation's
organizational wording lives in source. ResearchForce.org uses the bundle in
`docs/instance/researchforce-org-content.md` verbatim, encoded as
`@researchforce/design/researchforce-copy`; every other installation supplies
its own complete bundle (the test suite uses visibly different synthetic
bundles).

A minimal `PUBLIC_COPY` value looks like:

```json
{
  "version": "2026-07-07",
  "name": "Meridian Observatory",
  "strapline": "Charts of the southern sky, kept open",
  "mission": { "heading": "What we do", "paragraphs": ["…"] },
  "about": ["…", "…"],
  "principles": [{ "name": "Measure twice", "text": "…" }]
}
```

### Refusal when unconfigured or partial

If `PUBLIC_COPY` is unset, empty, unparseable, or incomplete — **or** if the
Content_Licence is unset — the Publisher, export, and preview refuse to run with
a clear error instead of producing a page or archive. There is never a silent
fallback and never the ResearchForce.org wording as a default.

## 3. Migration and upgrade

- **Schema migrations.** Database changes ship as hand-written SQL under
  `packages/db/migrations/{core,search,public}` with a matching `_journal.json`
  entry, applied through the compatible rollout (expand → deploy → backfill →
  switch → contract). Follow `scripts/expand.ts` / `scripts/backfill.ts` /
  `scripts/contract.ts` and the release plan; never contract before old
  consumers end.
- **Upgrading the public copy.** Changing the masthead, strapline, mission,
  about prose, or principles is a configuration/release change: bump `version`,
  update `PUBLIC_COPY`, and redeploy. The new `digest` invalidates every affected
  output automatically. The "About the group" Policy_Section, once bootstrapped
  from the about prose, afterwards changes only through the editor's normal
  preview/Revision workflow, not by editing `PUBLIC_COPY`.
- **Upgrading the software.** Pull the new release, run `npm ci`, `npm run ci`
  (lint, spec checks, release check, typecheck, tests), apply any pending
  migrations through the rollout scripts, and redeploy. The release manifest
  (`npm run release:check`) fingerprints the source so a stale manifest is caught
  before deploy.

## 4. Public site size on the Workers Free plan
On the Cloudflare Workers Free plan the Publisher supports a public site of at
most **750 current Public_Views** (every published or Withheld unit: Projects,
Research_Items, attachments, replies, notes). The limit is
`FREE_PLAN_SITE_VIEW_CEILING` in `packages/domain/src/slice-budget.ts`.
- **Why.** The Publisher renders the whole site in one Durable Object
  invocation, and the 128 MB isolate memory limit bounds that render. Measured
  with `node --expose-gc --import tsx scripts/measure-stage-render.ts` (the real
  loader, renderer, shell assets and hashing), one render of 751 views needs
  about 57 MB of heap and 320 ms of CPU. 1,001 views need about 67 MB, 2,001
  about 97 MB, and 4,001 about 158 MB. The ceiling keeps the peak at about half
  the isolate limit.
- **Approaching it.** At 80% (600 views) the Publisher raises a content-free
  System_Alert for Administrators and a `public_site_views` warning on the
  independent rf-ops alert channel, once. They are raised again only after the
  site falls back under 80%.
- **Over it.** The Publisher does not render. A run that only adds content is
  closed without being marked verified, so the live site stays as it was. It
  raises the over-ceiling System_Alert and an rf-ops `breach` alert, once each.
  A run that removes content cannot deploy the removal. It goes straight to the
  Containment path instead: edge Containment at 4 minutes, verified
  Containment at 5 minutes, otherwise an UNCONFIRMED incident and System_Alert.
  It is never reported as a verified removal.
- **Larger sites** need the Workers Paid plan or the incremental renderer
  (planned), which renders a window of pages per invocation.
## 5. Release material hygiene

Source distributions and release archives contain **only** code, migrations,
synthetic fixtures, and documentation. They must never include real research,
personal data, uploads, backups, secrets, or instance state, and preparing a
release does not publish a repository. Secrets (`CONTENT_LICENCE_*`,
`PUBLIC_COPY` for a real installation, provider keys) are supplied at deploy time
through Wrangler vars/secrets, not through source. Run `npm run secrets:check`
before distributing.
