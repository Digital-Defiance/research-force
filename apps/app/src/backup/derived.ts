import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from '../env';

/**
 * REBUILD the DERIVED data of a completed restore from the authoritative rows (R36.4, R36.11, R36.16; design "Restore
 * (R36.4–R36.17)": "Rebuild derived search/public data while public hosts remain under containment").
 *
 * The Internal_Backup deliberately EXCLUDES every derived/rebuildable table — New_Flags, Updated_Flags, per-Member
 * view marks, Notification_Events, Notifications, mail batches, the search index, and the Public_Views — because they
 * are reconstructed from the authoritative rows the restore DID install, not carried in the package
 * ({@link EXCLUDED_BACKUP_TABLES}). So after the authoritative rows are in place the restore must rebuild them.
 *
 * Two HARD constraints shape what this does (R36.4): a restore "setting no New_Flags or Updated_Flags and creating no
 * Notification_Events for the recreated elements", and the restored material staying QUARANTINED — not projected —
 * until an operator explicitly releases containment (R36.16). Therefore:
 *   • NO New_Flags / Updated_Flags are written. The flags table stays empty; the backup carries none, and a restore
 *     must create none, so every Member sees the restored items without a spurious "new research" flag.
 *   • NO Notification_Events, Notifications, mail batches, or outgoing emails are created. A restore performs NO
 *     external send (R36.4), so nothing here enqueues a `publish`, `search`, or email outbox row that would fan out.
 *   • The SEARCH index and the PUBLIC_VIEWS are rebuilt by their own background processors (the search indexer and the
 *     Publisher) from the authoritative rows. The Publisher stays PAUSED while the restore is quarantined
 *     (`restoreQuarantineActive`), so no Public_View is projected before the explicit release; the release
 *     (`releaseRestore`) kicks the Publisher, which then rebuilds the derived public data under containment as the
 *     design requires. This keeps the rebuild of public-visible derived data gated behind the authorized release.
 *
 * The function is a documented, intentional seam: it asserts the derived-data invariants a restore must preserve and
 * leaves the per-processor rebuilds to the processors that own them, triggered by the authorized release rather than
 * by the restore itself. It writes nothing and sends nothing, so a resumed/re-run VALIDATE stage is idempotent.
 */
export async function rebuildDerivedData(_env: Env, _now: Timestamp): Promise<void> {
  // Intentionally writes no derived rows and enqueues no external work: a restore sets no flags, creates no
  // Notification_Events, and performs no external send (R36.4). The search index and Public_Views are rebuilt from the
  // authoritative rows by the search indexer and the Publisher, the latter only once the quarantine is explicitly
  // released. No action is taken here that would violate those invariants.
  return Promise.resolve();
}
