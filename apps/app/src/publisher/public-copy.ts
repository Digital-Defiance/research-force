import { assertPublicCopy, type InstallationPublicCopy, type ValidatedInstallationPublicCopy } from '@researchforce/design/installation';

/**
 * Parse and validate the installation's `Installation_Public_Copy` from the `PUBLIC_COPY` env binding, which holds the
 * bundle as a JSON string. A missing, unparseable, or partial bundle throws, which refuses site generation,
 * publication, and export: there is no ResearchForce.org fallback and never the ResearchForce.org wording as a default
 * (design "Site display name…", R46.41, R46.42). The returned value carries the validated content digest the
 * Publisher records in the site-build manifest so a copy change invalidates every affected output (R40.12).
 */
export function publicCopyOf(env: { readonly PUBLIC_COPY?: string }): ValidatedInstallationPublicCopy {
  const raw = (env.PUBLIC_COPY ?? '').trim();
  if (raw === '') {
    return assertPublicCopy(undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return assertPublicCopy(undefined);
  }
  return assertPublicCopy(parsed as InstallationPublicCopy);
}
