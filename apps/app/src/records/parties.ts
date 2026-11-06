import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { GuardedBatch, GuardViolation } from '@researchforce/db/batch';
import { externalParties } from '@researchforce/db/schema/core';
import { newULID } from '@researchforce/domain/identifiers';
import { externalPartySchema } from '@researchforce/domain/schemas/people';
import { normalizeSearchText } from '@researchforce/domain/search-text';
import { isULID } from '@researchforce/domain/types';
import type { Timestamp, ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';

export interface PartyRecord {
  readonly id: ULID; readonly name: string; readonly doNotName: boolean; readonly genericLabel: string | null;
  /** The Contact_Email, shown only to Members; null when none was recorded or it was erased (R51.1). */
  readonly contactEmail: string | null;
  /** The Administrator who erased the Contact_Email and the time; the erased value itself is never kept (R51.1). */
  readonly contactEmailErasedBy: ULID | null; readonly contactEmailErasedAt: Timestamp | null;
  readonly createdAt: Timestamp; readonly rev: number;
}
type PartyRow = Omit<PartyRecord, 'doNotName'> & { doNotName: number };
const COLUMNS = 'id, name, do_not_name AS doNotName, generic_label AS genericLabel, contact_email AS contactEmail, contact_email_erased_by AS contactEmailErasedBy, contact_email_erased_at AS contactEmailErasedAt, created_at AS createdAt, rev';
const record = (row: PartyRow): PartyRecord => ({ ...row, doNotName: row.doNotName === 1 });

/** The name with letter case, diacritics, and spacing folded away, which decides whether two names are the same (R9.2). */
export function foldPartyName(name: string): string {
  return normalizeSearchText(name).trim().replace(/\s+/gu, ' ');
}

export async function listParties(c: Context<ApiEnv>): Promise<PartyRecord[]> {
  return (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM external_parties ORDER BY name_fold, id`).all<PartyRow>())).results.map(record);
}

export async function loadParty(c: Context<ApiEnv>, id: string): Promise<PartyRecord> {
  const row = isULID(id) ? (await c.get('accountant').track(c.env.RF_CORE.prepare(`SELECT ${COLUMNS} FROM external_parties WHERE id = ?1`).bind(id).all<PartyRow>())).results[0] : undefined;
  if (!row) throw new ApiError('not_found');
  return record(row);
}

export interface NewParty { readonly name: string; readonly doNotName?: boolean | undefined; readonly genericLabel?: string | undefined; readonly contactEmail?: string | undefined; readonly confirmDistinct?: boolean | undefined }

/**
 * Create an External_Party. A name equal to an existing one ignoring case and diacritics is refused, listing the
 * matches, until the Member confirms the two are different (R9.2). Turning Do_Not_Name on is open to every Member
 * with a Generic_Label (R34.4, R34.8).
 */
export async function createParty(c: Context<ApiEnv>, input: NewParty): Promise<PartyRecord> {
  const party = parse(externalPartySchema(), {
    name: input.name, doNotName: input.doNotName ?? false,
    ...(input.genericLabel === undefined ? {} : { genericLabel: input.genericLabel }),
    ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail }),
  });
  if (party.doNotName) await authorize(c, [{ permission: 'party.doNotName.on' }]);
  // Recording a Contact_Email is an Administrator-only action (R2.5, R51.1).
  if (party.contactEmail !== undefined) await authorize(c, [{ permission: 'party.contact' }]);
  const fold = foldPartyName(party.name);
  if (input.confirmDistinct !== true) {
    const matches = await c.get('accountant').track(c.env.RF_CORE.prepare('SELECT id, name FROM external_parties WHERE name_fold = ?1 ORDER BY id').bind(fold).all<{ id: ULID; name: string }>());
    if (matches.results.length > 0) {
      throw new ApiError('rule', { details: {
        rule: 'party_name_exists', message: 'An External Party with this name already exists. Confirm that this is a different person or organization.', parties: matches.results,
      } });
    }
  }
  const now = c.get('now');
  const id = newULID(now);
  await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
    .insert(externalParties, { id, name: party.name, nameFold: fold, doNotName: party.doNotName, genericLabel: party.genericLabel ?? null, contactEmail: party.contactEmail ?? null, createdAt: now })
    .outbox('publish', `party:${id}`)
    .commit(c.get('accountant'));
  return loadParty(c, id);
}

export interface PartyEdit {
  readonly rev: number; readonly name?: string | undefined; readonly doNotName?: boolean | undefined;
  readonly genericLabel?: string | null | undefined; readonly contactEmail?: string | null | undefined;
}

/**
 * Change a name, the Do_Not_Name flag, the Generic_Label, or the Contact_Email; only an Administrator turns the
 * flag off (R34.10) or records a Contact_Email (R2.5, R51.1). A null `contactEmail` erases the address: it records
 * the acting Administrator and the time but never the erased value (R51.1).
 */
export async function editParty(c: Context<ApiEnv>, current: PartyRecord, edit: PartyEdit): Promise<PartyRecord> {
  const genericLabel = edit.genericLabel === undefined ? current.genericLabel : edit.genericLabel;
  // The erased value is never kept, so a parse validates a new address but a null is an erasure, not a value.
  const settingEmail = edit.contactEmail !== undefined && edit.contactEmail !== null;
  const erasingEmail = edit.contactEmail === null && current.contactEmail !== null;
  const next = parse(externalPartySchema(), {
    name: edit.name ?? current.name, doNotName: edit.doNotName ?? current.doNotName,
    ...(genericLabel === null ? {} : { genericLabel }),
    ...(settingEmail ? { contactEmail: edit.contactEmail } : {}),
  });
  if (next.doNotName && !current.doNotName) await authorize(c, [{ permission: 'party.doNotName.on' }]);
  if (!next.doNotName && current.doNotName) await authorize(c, [{ permission: 'party.doNotName.off' }]);
  if (settingEmail || erasingEmail) await authorize(c, [{ permission: 'party.contact' }]);
  const now = c.get('now');
  const nextEmail = settingEmail ? next.contactEmail! : erasingEmail ? null : current.contactEmail;
  const emailChanged = settingEmail ? next.contactEmail !== current.contactEmail : erasingEmail;
  const changed = next.name !== current.name || next.doNotName !== current.doNotName || (next.genericLabel ?? null) !== current.genericLabel || emailChanged;
  if (!changed && edit.rev === current.rev) return current;
  // An erasure records the Administrator and time (R51.1); setting or changing an address clears any prior erasure stamp.
  const emailColumns = erasingEmail
    ? { contactEmail: null, contactEmailErasedBy: c.get('session').member.id, contactEmailErasedAt: now }
    : settingEmail
      ? { contactEmail: nextEmail, contactEmailErasedBy: null, contactEmailErasedAt: null }
      : {};
  try {
    await new GuardedBatch(c.env.RF_CORE, { id: c.get('session').member.id, now })
      .guard('rev', sql`(SELECT rev FROM external_parties WHERE id = ${current.id}) = ${edit.rev}`)
      .update(externalParties, { name: next.name, nameFold: foldPartyName(next.name), doNotName: next.doNotName, genericLabel: next.genericLabel ?? null, ...emailColumns }, eq(externalParties.id, current.id))
      .outbox('publish', `party:${current.id}`)
      .commit(c.get('accountant'));
  } catch (error) {
    if (error instanceof GuardViolation && error.code === 'rev') throw new ApiError('conflict', { details: { rev: (await loadParty(c, current.id)).rev } }, { cause: error });
    throw error;
  }
  return loadParty(c, current.id);
}
