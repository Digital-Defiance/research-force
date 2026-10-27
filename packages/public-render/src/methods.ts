import type { LabelKind } from '@researchforce/domain/label-marks';
import { termAnchor as anchorOf, termHref as hrefOf } from '@researchforce/domain/methods-anchors';
import type { FixedTermGroup, FixedTermKey, MethodsSetKind } from './site';

/** Methods page headings, one per value set and one per group of fixed terms, in page order (R46.11). */
export const METHODS_SET_HEADINGS: Readonly<Record<MethodsSetKind, string>> = {
  campaign_status: 'Campaign statuses', finding_status: 'Finding statuses', run_outcome: 'Run outcomes', hypothesis_status: 'Hypothesis statuses',
  archival_request_status: 'Archival request statuses', reliability: 'Reliability ratings', rights_status: 'Rights statuses', relation: 'Relation labels',
};
export const METHODS_GROUP_HEADINGS: Readonly<Record<FixedTermGroup, string>> = {
  source_kind: 'Source kinds', disclosure_level: 'Disclosure levels', label_kind: 'Label kinds', term: 'Other terms',
};

export { valueAnchor, valueHref } from '@researchforce/domain/methods-anchors';
export const termAnchor = (key: FixedTermKey): string => anchorOf(key);
export const termHref = (key: FixedTermKey): string => hrefOf(key);

export const labelKindTerm = (kind: LabelKind): FixedTermKey => `label_kind.${kind}`;
export const labelKindHref = (kind: LabelKind): string => termHref(labelKindTerm(kind));
export const WITHHELD_HREF = termHref('disclosure_level.withheld');
export const WITHDRAWN_HREF = termHref('term.withdrawn');
export const SUPERSEDED_HREF = termHref('term.superseded');
