import type { SearchRequest, SearchResponse } from '@researchforce/search-public/engine';

export interface WorkerRequest { readonly id: number; readonly request: SearchRequest; }
export type WorkerReply = { readonly id: number; readonly response: SearchResponse } | { readonly id: number; readonly failed: true };

/** Index files are same-origin static files under `/idx`. */
export const fetchIndexFile = async (file: string): Promise<unknown> => {
  const response = await fetch(`/${file}`);
  if (!response.ok) throw new Error(`Index file ${file} answered ${response.status}.`);
  return response.json();
};
