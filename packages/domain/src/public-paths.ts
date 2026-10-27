/**
 * Public_URLs are formed here and nowhere else, only from the Item_Identifier or Project_Slug and fixed text (R29.8, R40.3). The kernel
 * writes them into views and `public-render` builds the Project_Section addresses on top of them. `file` is a path on the public files host.
 */
export const PUBLIC_PATHS = Object.freeze({
  item: (identifier: string): string => `/r/${identifier}`,
  attachment: (identifier: string): string => `/a/${identifier}`,
  file: (identifier: string): string => `/f/${identifier}`,
  project: (slug: string): string => `/p/${slug}`,
});
