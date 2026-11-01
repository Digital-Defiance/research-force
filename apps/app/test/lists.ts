import { GuardedBatch } from '@researchforce/db/batch';
import {
  archivalRequests, correspondenceParties, correspondences, findings, hypotheses, identifiers, researchItems, runCounts, runs, units,
} from '@researchforce/db/schema/core';
import { newItemIdentifier, newULID } from '@researchforce/domain/identifiers';
import type { CreditEntry, ItemKind, PartialDate, ULID, Timestamp } from '@researchforce/domain/types';
import { addSubmissionRow } from './units';

export interface Place { readonly core: D1Database; readonly projectId: ULID; readonly ownerId: ULID; readonly now: Timestamp }

/** Shared options for every kind inserter: who, when, Credit, Restricted Access_List, completion, and withdrawal. */
export interface ItemOptions {
  readonly ownerId?: ULID;
  readonly createdAt?: Timestamp;
  readonly projectId?: ULID;
  readonly credit?: readonly CreditEntry[];
  readonly status?: ULID | null;
  readonly restrictedTo?: readonly ULID[];
  readonly completed?: boolean;
  readonly withdrawn?: boolean;
}

interface Inserted { readonly id: ULID; readonly identifier: string }

async function base(place: Place, kind: ItemKind, options: ItemOptions): Promise<{ readonly id: ULID; readonly identifier: string; readonly batch: GuardedBatch; readonly ownerId: ULID }> {
  const ownerId = options.ownerId ?? place.ownerId;
  const createdAt = options.createdAt ?? place.now;
  const projectId = options.projectId ?? place.projectId;
  const id = newULID(createdAt);
  const { identifier, registryKey } = newItemIdentifier();
  const submissionId = await addSubmissionRow(place.core, ownerId, createdAt, options.completed ?? true);
  const batch = new GuardedBatch(place.core, { id: ownerId, now: createdAt })
    .insert(units, {
      id, unitType: 'research_item', projectId, rootId: id, ownerId, credit: options.credit ?? [{ member: ownerId }], submissionId, createdAt,
      ...(options.withdrawn ? { withdrawnAt: createdAt, withdrawnBy: ownerId, withdrawalReason: 'Synthetic withdrawal.' } : {}),
    })
    .insert(researchItems, {
      unitId: id, kind, itemIdentifier: identifier, projectId, title: `Item ${id}`, itemDateKey: createdAt.slice(0, 10), logDateKey: createdAt.slice(0, 10),
      ...(options.status === undefined ? {} : { statusValueId: options.status }),
      ...(options.restrictedTo === undefined ? {} : { accessLevel: 'restricted' as const }),
    })
    .insert(identifiers, { identifierLc: registryKey, identifier, unitId: id, issuedAt: createdAt });
  return { id, identifier, batch, ownerId };
}

async function finish(place: Place, built: { readonly id: ULID; readonly identifier: string; readonly batch: GuardedBatch; readonly ownerId: ULID }, options: ItemOptions): Promise<Inserted> {
  await built.batch.commit();
  for (const member of options.restrictedTo ?? []) {
    await place.core.prepare('INSERT INTO access_grants (root_id, member_id, granted_by, granted_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(built.id, member, built.ownerId, options.createdAt ?? place.now).run();
  }
  return { id: built.id, identifier: built.identifier };
}

export async function addFinding(place: Place, options: ItemOptions & { readonly supersededById?: ULID } = {}): Promise<Inserted> {
  const built = await base(place, 'finding', { status: options.status ?? null, ...options });
  built.batch.insert(findings, {
    unitId: built.id, claim: `Claim of ${built.id}`, claimSpans: [], scopeCaveat: `Caveat of ${built.id}`, scopeCaveatSpans: [],
    ...(options.supersededById === undefined ? {} : { supersededById: options.supersededById }),
  });
  return finish(place, built, options);
}

export async function addRun(place: Place, options: ItemOptions & {
  readonly startKey?: string; readonly startTime?: string; readonly endTime?: string; readonly outcome?: ULID;
  readonly toolName?: string; readonly toolVersion?: string; readonly computeResource?: string; readonly resumePoint?: string;
  readonly counts?: readonly { readonly name: string; readonly value: string }[];
} = {}): Promise<Inserted> {
  const outcome = options.outcome ?? ('0000000000000000000000R002' as ULID);
  const startKey = options.startKey ?? (options.createdAt ?? place.now);
  const built = await base(place, 'run', { status: options.status ?? outcome, ...options });
  built.batch.insert(runs, {
    unitId: built.id, scope: `Scope of ${built.id}`, scopeSpans: [], parameters: 'Params.', parametersSpans: [],
    toolName: options.toolName ?? 'synthtool', toolVersion: options.toolVersion ?? '1.0', computeResource: options.computeResource ?? 'test rig',
    startTime: options.startTime ?? '2026-10-01T09:30:15Z', startKey,
    ...(options.endTime === undefined ? {} : { endTime: options.endTime }), outcomeId: outcome,
    ...(options.resumePoint === undefined ? {} : { resumePoint: options.resumePoint }),
  });
  (options.counts ?? []).forEach((count, position) => built.batch.insert(runCounts, { unitId: built.id, position, name: count.name, value: count.value }));
  return finish(place, built, options);
}

export async function addHypothesis(place: Place, options: ItemOptions & { readonly eliminationScope?: string } = {}): Promise<Inserted> {
  const built = await base(place, 'hypothesis', { status: options.status ?? ('00000000000000000000000001' as ULID), ...options });
  built.batch.insert(hypotheses, {
    unitId: built.id, statement: `Statement of ${built.id}`, statementSpans: [],
    ...(options.eliminationScope === undefined ? {} : { eliminationScope: options.eliminationScope, eliminationScopeSpans: [] }),
  });
  return finish(place, built, options);
}

export type Party = { readonly kind: 'member' | 'external'; readonly id: ULID };
export async function addCorrespondence(place: Place, options: ItemOptions & {
  readonly date?: string; readonly direction?: 'sent' | 'received'; readonly parties?: readonly Party[];
} = {}): Promise<Inserted> {
  const built = await base(place, 'correspondence', { status: null, ...options });
  built.batch.insert(correspondences, { unitId: built.id, date: options.date ?? '2026-10-01', direction: options.direction ?? 'sent', content: 'Synthetic content.', contentSpans: [] });
  (options.parties ?? []).forEach((party, position) => built.batch.insert(correspondenceParties, {
    unitId: built.id, position, partyKind: party.kind, partyId: party.id, consentStatus: party.kind === 'external' ? 'not_asked' : null,
  }));
  return finish(place, built, options);
}

export async function addArchival(place: Place, options: ItemOptions & {
  readonly archive?: Party; readonly contact?: Party; readonly dateSent?: string;
} = {}): Promise<Inserted> {
  const archive = options.archive ?? { kind: 'member' as const, id: options.ownerId ?? place.ownerId };
  const built = await base(place, 'archival_request', { status: options.status ?? ('00000000000000000000000003' as ULID), ...options });
  built.batch.insert(archivalRequests, {
    unitId: built.id, archiveKind: archive.kind, archiveId: archive.id,
    ...(options.contact === undefined ? {} : { contactKind: options.contact.kind, contactId: options.contact.id }),
    requestText: `Request of ${built.id}`, requestTextSpans: [],
    ...(options.dateSent === undefined ? {} : { dateSent: options.dateSent }),
  });
  return finish(place, built, options);
}

/** A PartialDate helper for assertions. */
export const date = (value: string, approx = false): PartialDate => ({ value, approx });
