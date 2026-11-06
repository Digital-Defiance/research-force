# Third-party notices

The Research Force software is distributed under the MIT License (see `LICENSE`).
It bundles or depends on third-party software and assets that keep their own
licences and required notices. This file collects those notices for software
distributions. It is **not** a content licence: research records, attachments,
imported journals, and other instance content keep their own rights, and the
installation owner configures the public archive's content licence separately
(see `docs/instance/installation.md`).

## Typefaces (SIL Open Font License 1.1)

The Design_System self-hosts and subsets the following faces. Each face's full
OFL grant is vendored beside the font binaries under
`packages/design/fonts/licences/` and is copied into every Public_Archive_Export
under `assets/fonts/LICENCES.txt`.

- Fraunces — SIL Open Font License 1.1
- Inter — SIL Open Font License 1.1
- JetBrains Mono — SIL Open Font License 1.1
- STIX Two Text — SIL Open Font License 1.1
- STIX Two Math — SIL Open Font License 1.1
- Noto Sans / Noto Sans Math (fallback coverage) — SIL Open Font License 1.1

## Runtime and build dependencies

These are declared in `package.json` and installed from the npm registry; each
keeps the licence stated in its own package metadata. The notable ones are:

- Hono — MIT
- Zod — MIT
- Drizzle ORM / Drizzle Kit — Apache-2.0
- `@noble/hashes` — MIT
- React / React DOM — MIT
- Wrangler and the Cloudflare Workers tooling — MIT / Apache-2.0
- Vite, Vitest, oxlint, stylelint, TypeScript, Playwright, fast-check — their
  respective OSS licences (MIT / Apache-2.0 / BSD), as recorded in each
  package's own `LICENSE`.

Run `npm ls --all` against a built install to enumerate the exact resolved
versions and their licences for a given distribution.

## What this file does not cover

- **Content.** The public archive's `LICENSE.txt` carries the installation's
  configured **content** licence (`Installation_Public_Copy` / Content_Licence),
  never the MIT software licence by default. See
  `docs/instance/installation.md`.
- **Instance data.** Source distributions contain code, migrations, synthetic
  fixtures, and documentation only. Real research, personal data, uploads,
  backups, secrets, and instance state are never part of the source history or
  a release archive.
