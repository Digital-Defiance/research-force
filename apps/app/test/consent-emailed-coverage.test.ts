import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedBatch } from '@researchforce/db/batch';
import {
  consentAnswers, correspondenceParties, correspondences, externalParties, identifiers, researchItems, units,
} from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import type { ULID } from '@researchforce/domain/types';
import { unitKey } from '@researchforce/kernel/views';
import type { GateFailure } from '@researchforce/kernel/preview';
import { applyChange } from '@researchforce/kernel/preview';
import { approvedSnapshot } from '@researchforce/kernel/consent';
import { loadProjectionInput } from '../src/kernel-input';
import { itemWorld } from './items';
import type { Who } from './items';
import { addSubmissionRow } from './units';

/**
 * R51.9: a Consent_Status set through an emailed Consent_Answer covers only the exact material the Consent_Page
 * showed. The disclosure pipeline refuses a change that would make the element present more than the seen
 * snapshot did, and a Consent_Status set by hand (no Consent_Answer) grants no emailed coverage at all.
 */

const SECRET = 'synthetic-preview-hmac-secret-for-tests';
const LICENCE = 'Synthetic Content Licence 1.0';
const world = itemWorld(undefined, { contentLicence: LICENCE });

interface PreviewSnapshot { readonly kind: string; readonly key: string; readonly view: unknown }
interface DisclosurePreview { readonly failures: readonly GateFailure[]; readonly token: string | null }

/** A Public-Project correspondence owned by `admin` with one External_Party as a Party; the Party has a Contact_Email. */
async function correspondenceWithParty(): Promise<{ unitId: ULID; partyId: ULID }> {
  const now = world.at;
  const partyId = newULID(now) as ULID;
  const unitId = newULID(now) as ULID;
  const { identifier, registryKey } = newItemIdentifier();
  const submissionId = await addSubmissionRow(world.core(), world.ids.admin, now);
  await new GuardedBatch(world.core(), { id: world.ids.admin, now })
    .insert(externalParties, { id: partyId, name: 'A synthetic correspondent', nameFold: 'a synthetic correspondent', contactEmail: 'party@example.test', createdAt: now })
    .insert(units, { id: unitId, unitType: 'research_item', projectId: world.projectId, rootId: unitId, ownerId: world.ids.admin, credit: [{ member: world.ids.admin }], submissionId, createdAt: now })
    .insert(researchItems, { unitId, kind: 'correspondence', itemIdentifier: identifier, projectId: world.projectId, title: 'A synthetic correspondence', itemDateKey: '2026-10-01', logDateKey: '2026-10-01' })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId, issuedAt: now })
    .insert(correspondences, { unitId, date: '2026-10-01', direction: 'sent' })
    .insert(correspondenceParties, { unitId, position: 0, partyKind: 'external', partyId, consentStatus: 'not_asked' })
    .commit();
  return { unitId, partyId };
}

/**
 * The exact Public_View the person saw for a proposed change, computed with the kernel the same way the gate
 * reads a stored seen snapshot (the unit's own view under prospective-public ancestors). Wrapping it as a
 * ConsentSnapshot's `.view` mirrors what the Consent_Page stored, so loadProjectionInput reads it back verbatim.
 */
async function seenSnapshot(unitId: ULID, change: Record<string, unknown>): Promise<PreviewSnapshot> {
  const { input } = await loadProjectionInput(world.core(), [unitId], world.at, { withConsent: true });
  const key = unitKey(unitId);
  const after = applyChange(input, { units: [{ key, ...change } as never] });
  const unit = after.units.find((candidate) => candidate.id === unitId)!;
  const values = {
    level: unit.level,
    ...(unit.type === 'research_item' ? { presentation: unit.item.presentation } : {}),
    ...(unit.type === 'research_item' && unit.item.publicSummary ? { publicSummary: unit.item.publicSummary } : {}),
    ...(unit.disclosureLine ? { disclosureLine: unit.disclosureLine } : {}),
  };
  const view = approvedSnapshot(after, key, values, []).view;
  return { kind: 'publication', key, view };
}

/** Record an emailed Consent_Answer that granted consent, with the given seen snapshot as its evidence. */
async function grantByEmail(unitId: ULID, snapshot: PreviewSnapshot): Promise<void> {
  const now = world.at;
  const json = JSON.stringify(snapshot);
  const hash = await sha256Hex(json);
  await new GuardedBatch(world.core(), { id: world.ids.admin, now })
    .insert(consentAnswers, {
      id: newULID(now), requestId: newULID(now), itemId: newULID(now), unitId, rootId: unitId,
      choice: 'named', resultStatus: 'granted', seenSnapshot: snapshot as unknown as Record<string, unknown>, seenSnapshotHash: hash, answeredAt: now,
    })
    .commit();
  await world.core().prepare("UPDATE correspondence_parties SET consent_status = 'granted' WHERE unit_id = ?1").bind(unitId).run();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function previewDisclosure(who: Who, change: Record<string, unknown>): Promise<DisclosurePreview> {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  const response = await world.request(who, 'POST', '/disclosure/preview', change);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response.json<DisclosurePreview>();
}

const WITHHELD_LINE = { kindOfMaterial: 'A letter', date: { value: '2026-10-01', approx: false }, partyIds: [] };

beforeEach(async () => {
  world.bindings.DOWNLOAD_HMAC_KEY = SECRET;
  // The Administrator holds a Licence_Agreement, so the licence gate never masks the emailed-consent gate.
  await world.core().prepare('UPDATE profiles SET licence_name = ?1, licence_given_on = ?2 WHERE member_id = ?3').bind(LICENCE, '2026-10-27', world.ids.admin).run();
});

describe('emailed consent covers only the content shown (R51.9)', () => {
  it('refuses a widening beyond the emailed snapshot, naming the recorded answer', async () => {
    const { unitId } = await correspondenceWithParty();
    // The person saw a Withheld Consent_Page and granted consent for exactly that.
    const snapshot = await seenSnapshot(unitId, { level: 'withheld', disclosureLine: WITHHELD_LINE });
    await grantByEmail(unitId, snapshot);

    // Making the Correspondence Public with full content presents far more than the Withheld snapshot showed.
    const preview = await previewDisclosure('admin', { units: [{ key: unitKey(unitId), level: 'public' }] });
    const refusal = preview.failures.find((failure) => failure.reason === 'emailed_consent');
    expect(refusal).toBeDefined();
    expect(refusal!.key).toBe(unitKey(unitId));
    expect(refusal!.details).toHaveLength(1);
    expect(preview.token).toBeNull();
  });

  it('allows a change that stays within the emailed snapshot', async () => {
    const { unitId } = await correspondenceWithParty();
    // The person saw the Public_View for the exact Withheld proposal that is then applied, so the result presents nothing more.
    const snapshot = await seenSnapshot(unitId, { level: 'withheld', disclosureLine: WITHHELD_LINE });
    await grantByEmail(unitId, snapshot);
    const preview = await previewDisclosure('admin', { units: [{ key: unitKey(unitId), level: 'withheld', disclosureLine: WITHHELD_LINE }] });
    expect(preview.failures.filter((failure) => failure.reason === 'emailed_consent')).toEqual([]);
  });

  it('a Consent_Status set by hand grants no emailed coverage: no emailed-consent gate runs', async () => {
    const { unitId } = await correspondenceWithParty();
    // No Consent_Answer is recorded; an Administrator simply flips the Consent_Status to granted by hand.
    await world.core().prepare("UPDATE correspondence_parties SET consent_status = 'granted' WHERE unit_id = ?1").bind(unitId).run();
    // The widening to Public carries no emailed Permission_Evidence, so the emailed-consent gate adds no refusal;
    // a hand-set status never stands in for an emailed grant (R51.9, R51.15).
    const preview = await previewDisclosure('admin', { units: [{ key: unitKey(unitId), level: 'public' }] });
    expect(preview.failures.filter((failure) => failure.reason === 'emailed_consent')).toEqual([]);
  });
});
