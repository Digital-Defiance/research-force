import type { Context } from 'hono';
import { z } from 'zod';
import { derivationExportDocument } from '@researchforce/domain/derivation-export';
import type { DerivationExport, ExportedDerivation } from '@researchforce/domain/derivation-export';
import { idSchema } from '@researchforce/domain/schemas/common';
import type { ApiEnv } from '../api/app';
import { parse } from '../api/input';
import { DERIVATION_LIMITS } from '@researchforce/domain/derivations';
import { listDerivations } from './derivations';
import type { EndpointView } from './derivations';

const querySchema = z.strictObject({ rootId: idSchema, after: idSchema.optional() });

const endpoint = (view: EndpointView): ExportedDerivation['output'] => ({
  type: view.type, unitId: view.unitId, ...(view.field === undefined ? {} : { field: view.field }), record: view.identifier, title: view.title, sha256: view.sha256, rev: view.rev,
});

/**
 * One page of the derivations that make a record's artifacts, with every earlier version of each output, for the derivations the Member can read
 * now. Identities, hashes, stored text, uncertainty and reviews come through unchanged (R55.5); a derivation with an end the Member cannot read is
 * absent and nothing counts what was left out (R55.4).
 */
export async function exportDerivations(c: Context<ApiEnv>, raw: unknown): Promise<{ readonly body: DerivationExport; readonly next: string | null }> {
  const query = parse(querySchema, raw);
  const page = await listDerivations(c, { outputRootId: query.rootId, ...(query.after === undefined ? {} : { after: query.after }), limit: DERIVATION_LIMITS.page });
  const derivations = page.derivations.map((view): ExportedDerivation => ({
    id: view.id, kind: view.kind, method: view.method, methodVersion: view.methodVersion, language: view.language, uncertainty: view.uncertainty, reviewState: view.reviewState,
    createdBy: view.createdBy, createdAt: view.createdAt, output: endpoint(view.output), inputs: view.inputs.map(endpoint), text: view.text, correctsId: view.correctsId,
    correctedBy: view.correctedBy, reviews: view.reviews.map((review) => ({ reviewerId: review.reviewerId, reviewerName: review.reviewerName, state: review.state, note: review.note, reviewedAt: review.reviewedAt,
      passages: review.passages.map((passage) => ({ start: passage.start, end: passage.end, note: passage.note })) })),
  }));
  const epoch = page.derivations[0]?.graphEpoch ?? 0;
  return { body: derivationExportDocument(c.get('now'), epoch, derivations), next: page.next };
}
