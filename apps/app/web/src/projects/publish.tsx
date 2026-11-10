import { useState } from 'react';
import { DisclosureDialog, LEVEL_OPTIONS } from '../disclosure/disclosure';
import { disclosureLineBody, DisclosureLineFields, emptyDisclosureLine } from '../disclosure/line';
import type { DisclosureLineValue } from '../disclosure/line';
import { useSession } from '../session';
import type { MemberRow, ProjectRecord } from '../types';
import { Button, levelName, SelectField } from '../ui';

/** A Project's own and effective Disclosure_Level, changed through the same preview-and-confirm flow as an item (unit key `p:<id>`). */
export function ProjectPublishSettings({ project, members, onApplied }: {
  readonly project: ProjectRecord;
  readonly members: readonly MemberRow[];
  readonly onApplied: () => void;
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [nextLevel, setNextLevel] = useState(project.disclosureLevel);
  const [line, setLine] = useState<DisclosureLineValue>(emptyDisclosureLine);
  const canSet = session.can('disclosure.set');
  return (
    <section className="rf-section" aria-label="Publish settings">
      <h2>Publish settings</h2>
      <p className="rf-meta">{`Disclosure ${levelName(project.disclosureLevel)}, effective ${levelName(project.effectiveDisclosure ?? project.disclosureLevel)}`}</p>
      {project.disclosureLine !== null && <p className="rf-meta">{`Disclosure line: ${project.disclosureLine}`}</p>}
      {!canSet && <p className="rf-meta">Changing the level needs the Publish permission.</p>}
      {canSet && !open && <Button onClick={() => setOpen(true)}>Change disclosure</Button>}
      {canSet && open && (
        <div className="rf-stack">
          <SelectField label="Disclosure level" value={nextLevel} options={LEVEL_OPTIONS} onChange={setNextLevel} />
          {nextLevel === 'withheld' && <DisclosureLineFields value={line} onChange={setLine} />}
          <DisclosureDialog
            key={nextLevel}
            title="Change project disclosure"
            units={[{ key: `p:${project.id}`, level: nextLevel, ...(nextLevel === 'withheld' ? { disclosureLine: disclosureLineBody(line) } : {}) }]}
            members={members}
            onCancel={() => setOpen(false)}
            onProposed={onApplied}
            onApplied={onApplied}
          />
        </div>
      )}
    </section>
  );
}
