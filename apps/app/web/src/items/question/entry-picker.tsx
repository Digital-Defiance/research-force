import { useState } from 'react';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { ItemKind } from '@researchforce/domain/types';
import { useApi } from '../../api';
import { Button, TextField } from '../../ui';
import type { EntryValue } from './model';

interface Found { readonly id: string; readonly unitType: string; readonly kind: ItemKind; readonly title: string }

/** Find a Research_Item or Attachment of the Project by searching, and choose it as an entry (R50.1). */
export function EntryPicker({ label, chosen, onChoose }: { readonly label: string; readonly chosen: ReadonlySet<string>; readonly onChoose: (entry: EntryValue) => void }) {
  const client = useApi();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<readonly Found[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const search = async () => {
    if (query.trim() === '') return;
    setFailed(false);
    try {
      const page = await client.get<{ results: Found[] }>(`/search?q=${encodeURIComponent(query.trim())}`);
      setFound(page.results.filter((result) => result.unitType === 'research_item' || result.unitType === 'attachment'));
    } catch {
      setFailed(true);
    }
  };
  const nameOf = (result: Found) => `${result.unitType === 'attachment' ? 'Attachment' : ITEM_KIND_NAMES[result.kind]}: ${result.title}`;
  return (
    <div className="rf-stack">
      <TextField label={label} value={query} onChange={setQuery} hint="Search for a record or an Attachment to add." />
      <Button onClick={() => void search()}>Search</Button>
      {failed && <p className="rf-field__error">The search failed. Try again.</p>}
      {found !== undefined && (found.length === 0
        ? <p className="rf-meta">No records match.</p>
        : (
          <ul className="rf-list">
            {found.map((result) => (
              <li key={result.id}>
                {nameOf(result)}{' '}
                {chosen.has(result.id)
                  ? <span className="rf-meta">Already an entry</span>
                  : <Button variant="quiet" label={`Add ${nameOf(result)}`} onClick={() => onChoose({ targetId: result.id, label: nameOf(result) })}>Add</Button>}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
