/** Methods page entries are addressed by value id or fixed term key, so renaming a value keeps every link (R46.14). */
export const METHODS_PATH = '/methods';
export const valueAnchor = (id: string): string => `value-${id.toLowerCase()}`;
export const termAnchor = (key: string): string => key.replace(/[._]/gu, '-');
export const valueHref = (id: string): string => `${METHODS_PATH}#${valueAnchor(id)}`;
export const termHref = (key: string): string => `${METHODS_PATH}#${termAnchor(key)}`;

/** The status label a Source shows for its Source_Kind, linked to `source_kind.{kind}`. */
export const SOURCE_KIND_LABELS = { primary: 'Primary source', secondary: 'Secondary source' } as const;
