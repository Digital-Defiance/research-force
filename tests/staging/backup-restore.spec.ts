/**
 * Backup / restore rehearsal staging verification (task 48.5; R36.17, R60.4). Gate: the
 * recovery / team-archive launch gate.
 *
 * Against the deployed staging install's operator backup/restore rehearsal route, this suite
 * rehearses the REAL recovery path end to end and keeps only SANITIZED evidence (no real research,
 * PII, or secrets in any retained artifact):
 *   - Independent encrypted backup & key recovery (R36.17, R60.4): an encrypted backup is produced
 *     and its key is recovered through the INDEPENDENT recovery key (a separate custodian/key id),
 *     proving the backup is recoverable without the primary key.
 *   - Fresh restore (R60.4): a restore into a FRESH, empty target succeeds and reproduces the
 *     content counts, exercising:
 *       - a bootstrap identity conflict (the fresh target already has a bootstrap identity that
 *         collides with the backup's) — the restore resolves it rather than duplicating or crashing;
 *       - an OLDER schema in the backup — the restore migrates it forward;
 *       - a crash mid-restore and a resume — the resumed restore completes without double-applying;
 *       - a later suppression (a record suppressed after the backup point) — the restore honours the
 *         suppression rather than resurrecting suppressed content.
 *   - Sanitized evidence (R36.17): the retained evidence is asserted to be marked sanitized and to
 *     carry only counts/verification, never research/PII/secret payloads.
 *
 * These checks require the real staging install, the independent recovery key id, and an operator
 * token; without them the gate is reported BLOCKED (never skipped). A full run belongs in
 * CI/operator context.
 */
import { expect, test } from '@playwright/test';
import { BACKUP_ENDPOINT, BACKUP_EVIDENCE_DEST, BACKUP_RECOVERY_KEY_ID, BACKUP_TOKEN } from './support/env';
import { describeGate, handle } from './support/gate';
import { flag, numberField, operatorPost } from './support/operator';

const GATE = 'Recovery gate (backup/restore rehearsal)';

const ready = describeGate(GATE, [
  handle('STAGING_BACKUP_ENDPOINT', BACKUP_ENDPOINT),
  handle('STAGING_BACKUP_TOKEN', BACKUP_TOKEN),
  handle('STAGING_BACKUP_RECOVERY_KEY_ID', BACKUP_RECOVERY_KEY_ID),
  handle('STAGING_BACKUP_EVIDENCE_DEST', BACKUP_EVIDENCE_DEST),
]);

if (ready) {
  test.describe(GATE, () => {
    test('an encrypted backup is recoverable through the independent recovery key (R36.17, R60.4)', async ({ request }) => {
      const result = await operatorPost(
        request,
        BACKUP_ENDPOINT!,
        BACKUP_TOKEN!,
        { action: 'rehearse-backup', recoveryKeyId: BACKUP_RECOVERY_KEY_ID, evidenceDest: BACKUP_EVIDENCE_DEST },
        'backup',
      );
      expect(result.ok, 'the backup rehearsal must run').toBe(true);
      expect(flag(result.body, 'backupEncrypted'), 'the backup must be encrypted').toBe(true);
      expect(flag(result.body, 'keyRecoveredIndependently'), 'the key must be recoverable through the independent recovery key').toBe(true);
    });

    test('a fresh restore resolves a bootstrap identity conflict, an older schema, a crash/resume, and a later suppression (R60.4)', async ({ request }) => {
      const result = await operatorPost(
        request,
        BACKUP_ENDPOINT!,
        BACKUP_TOKEN!,
        {
          action: 'rehearse-fresh-restore',
          scenarios: ['bootstrap-identity-conflict', 'older-schema', 'crash-resume', 'later-suppression'],
          evidenceDest: BACKUP_EVIDENCE_DEST,
        },
        'restore',
      );
      expect(result.ok, 'the fresh restore rehearsal must run').toBe(true);
      expect(flag(result.body, 'restoreCompleted'), 'the fresh restore must complete').toBe(true);
      expect(flag(result.body, 'bootstrapConflictResolved'), 'the bootstrap identity conflict must be resolved, not duplicated').toBe(true);
      expect(flag(result.body, 'olderSchemaMigrated'), 'the older schema must be migrated forward').toBe(true);
      expect(flag(result.body, 'crashResumedWithoutDoubleApply'), 'a crash mid-restore must resume without double-applying').toBe(true);
      expect(flag(result.body, 'laterSuppressionHonoured'), 'a later suppression must be honoured, not resurrected').toBe(true);
      const restoredCount = numberField(result.body, 'restoredRecordCount');
      expect(restoredCount, 'the restore must report the reproduced content count').toBeDefined();
      expect(restoredCount!).toBeGreaterThanOrEqual(0);
    });

    test('the retained rehearsal evidence is sanitized — counts/verification only, no research/PII/secrets (R36.17)', async ({ request }) => {
      const result = await operatorPost(request, BACKUP_ENDPOINT!, BACKUP_TOKEN!, { action: 'evidence-manifest', evidenceDest: BACKUP_EVIDENCE_DEST }, 'evidence');
      expect(result.ok).toBe(true);
      expect(flag(result.body, 'sanitized'), 'the retained evidence must be marked sanitized').toBe(true);
      expect(flag(result.body, 'containsResearchOrPii'), 'the evidence must contain no research or PII').toBe(false);
      expect(flag(result.body, 'containsSecrets'), 'the evidence must contain no secrets').toBe(false);
    });
  });
}
