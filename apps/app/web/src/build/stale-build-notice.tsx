import { Button, Notice } from '../ui';
import { staleBuild, useStaleBuild } from './stale-build';
import type { StaleBuildStore } from './stale-build';
/** Tells the Member this tab runs an older build. Reloading is always the Member's choice; unsent input lives in tab storage and survives it. */
export function StaleBuildNotice({ store = staleBuild }: { readonly store?: StaleBuildStore }) {
  const { stale, held } = useStaleBuild(store);
  if (!stale) return null;
  return (
    <Notice tone="neutral" title="The Workspace was updated. Reload to use the latest version.">
      <p>Anything you have typed but not sent in this tab is kept.</p>
      {held && <p>An upload is in progress. Reloading stops it, and you will need to select the file again.</p>}
      <Button onClick={() => store.reload()}>{held ? 'Reload anyway' : 'Reload to update'}</Button>
    </Notice>
  );
}
