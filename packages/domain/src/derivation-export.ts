import { z } from 'zod';
import { DERIVATION_KINDS, REVIEW_STATES } from './derivations';

/**
 * The interchange form of artifact derivations (R55.5, R60.1): the graph, the exact stored text, every identity and hash, uncertainty, and each
 * independent review with its flagged passages, as a Member who can read both ends sees them. A reader checks it with `parseDerivationExport`
 * and compares two of them with `comparableDerivations`, so a restore or another tool can prove nothing was changed on the way.
 */
export const DERIVATION_EXPORT_FORMAT = 'researchforce-derivations';
export const DERIVATION_EXPORT_VERSION = 1;

const hash = z.string().regex(/^[0-9a-f]{64}$/u);
const endpoint = z.strictObject({
  type: z.enum(['attachment', 'text']), unitId: z.string(), field: z.string().optional(), record: z.string(), title: z.string(), sha256: hash, rev: z.number().int().nullable(),
});
const passage = z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(1), note: z.string().nullable() });
const review = z.strictObject({
  reviewerId: z.string(), reviewerName: z.string().nullable(), state: z.enum(['reviewed', 'disputed']), note: z.string().nullable(), reviewedAt: z.string(), passages: z.array(passage),
});
export const exportedDerivationSchema = z.strictObject({
  id: z.string(), kind: z.enum(DERIVATION_KINDS), method: z.string(), methodVersion: z.string().nullable(), language: z.string().nullable(), uncertainty: z.string().nullable(),
  reviewState: z.enum(REVIEW_STATES), createdBy: z.string(), createdAt: z.string(), output: endpoint, inputs: z.array(endpoint).min(1), text: z.string().nullable(),
  correctsId: z.string().nullable(), correctedBy: z.string().nullable(), reviews: z.array(review),
});
export const derivationExportSchema = z.strictObject({
  format: z.literal(DERIVATION_EXPORT_FORMAT), version: z.literal(DERIVATION_EXPORT_VERSION), exportedAt: z.string(), graphEpoch: z.number().int().min(0), derivations: z.array(exportedDerivationSchema),
});
export type ExportedDerivation = z.output<typeof exportedDerivationSchema>;
export type DerivationExport = z.output<typeof derivationExportSchema>;

export function derivationExportDocument(exportedAt: string, graphEpoch: number, derivations: readonly ExportedDerivation[]): DerivationExport {
  return { format: DERIVATION_EXPORT_FORMAT, version: DERIVATION_EXPORT_VERSION, exportedAt, graphEpoch, derivations: [...derivations] };
}

/** The document, or the reason it is not one: an unknown version or a stray field is refused rather than guessed at. */
export function parseDerivationExport(raw: unknown): DerivationExport {
  return derivationExportSchema.parse(raw);
}

/** What two exports must agree on to be the same graph: everything but when it was made, in a fixed order. */
export function comparableDerivations(document: DerivationExport): readonly ExportedDerivation[] {
  return [...document.derivations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
