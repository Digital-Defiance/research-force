import { snapshotHeading, snapshotLines } from './model';
import type { ConsentSnapshot } from './model';

/**
 * The Consent_Page preview the Administrator sees before sending: each named element's stored snapshot, rendered
 * exactly as the public Consent_Page will present it (R51.5, R51.16). The heading and lines come from the shared
 * helpers, so the Workspace preview and the public page read identically; no file bytes are ever shown.
 */
export function SnapshotPreview({ snapshots }: { readonly snapshots: readonly ConsentSnapshot[] }) {
  return (
    <section className="rf-section" aria-label="Consent page preview">
      <h3>What the External Party will see on the Consent Page</h3>
      {snapshots.length === 0
        ? <p className="rf-meta">No element is named yet.</p>
        : (
          <ul className="rf-list">
            {snapshots.map((snapshot) => (
              <li key={snapshot.key} className="rf-companion">
                <p><strong>{snapshotHeading(snapshot)}</strong></p>
                {snapshotLines(snapshot).map((line, index) => <p key={index} className="rf-meta">{line}</p>)}
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
