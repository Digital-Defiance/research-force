import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useLoad } from '../ui';
import type { CitationPage, CitationRow } from './model';

interface Scope { readonly citations: readonly CitationRow[]; readonly locators: ReadonlyMap<string, string>; readonly reload: () => void }
const NONE: Scope = { citations: [], locators: new Map(), reload: () => undefined };
const ScopeContext = createContext<Scope>(NONE);

/**
 * The current citations of the record on screen, shared by its labels (which show each cited locator), its label editor (which offers them) and
 * its citations panel. A citation the Member cannot read is not in it, so no label shows a locator for one (R54.4, R54.5). A page that cannot
 * load them shows its labels as written.
 */
export function CitationScope({ rootId, children }: { readonly rootId: string; readonly children: ReactNode }) {
  const loaded = useLoad<CitationPage>(`/citations?citingRootId=${rootId}`);
  const scope = useMemo<Scope>(() => {
    const citations = loaded.data?.citations ?? [];
    return { citations, locators: new Map(citations.map((citation) => [citation.id, citation.locatorLabel])), reload: loaded.reload };
  }, [loaded.data, loaded.reload]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
export const useCitationScope = (): Scope => useContext(ScopeContext);
