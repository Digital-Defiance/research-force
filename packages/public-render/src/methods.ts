import { SITE_PATHS } from '@researchforce/design/fixed-texts';
import type { LabelKind } from '@researchforce/domain/label-marks';
import type { FixedTermGroup, FixedTermKey, MethodsSetKind } from './site';

/** Methods page headings, one per value set and one per group of fixed terms, in page order (R46.11). */
export const METHODS_SET_HEADINGS: Readonly<Record<MethodsSetKind, string>> = {
  campaign_status: 'Campaign statuses', finding_status: 'Finding statuses', run_outcome: 'Run outcomes', hypothesis_status: 'Hypothesis statuses',
  archival_request_status: 'Archival request statuses', reliability: 'Reliability ratings', rights_status: 'Rights statuses', relation: 'Relation labels',
};
export const METHODS_GROUP_HEADINGS: Readonly<Record<FixedTermGroup, string>> = {
  source_kind: 'Source kinds', disclosure_level: 'Disclosure levels', label_kind: 'Label kinds', term: 'Other terms',
};

/** Methods page entries are addressed by value id or fixed term key, so renaming a value keeps every link (R46.14). */
export const valueAnchor = (id: string): string => `value-${id.toLowerCase()}`;
export const termAnchor = (key: FixedTermKey): string => key.replace(/[._]/gu, '-');
export const valueHref = (id: string): string => `${SITE_PATHS.methods}#${valueAnchor(id)}`;
export const termHref = (key: FixedTermKey): string => `${SITE_PATHS.methods}#${termAnchor(key)}`;

export const labelKindTerm = (kind: LabelKind): FixedTermKey => `label_kind.${kind}`;
export const labelKindHref = (kind: LabelKind): string => termHref(labelKindTerm(kind));
export const WITHHELD_HREF = termHref('disclosure_level.withheld');
export const WITHDRAWN_HREF = termHref('term.withdrawn');
export const SUPERSEDED_HREF = termHref('term.superseded');
