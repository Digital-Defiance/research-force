import { useState } from 'react';
import { useSession } from '../session';
import type { MemberRow, PartyRecord } from '../types';
import { Button, useLoad } from '../ui';
import { ConsentRequestDialog } from './dialog';
import type { ConsentElement } from './dialog';
import type { ConsentKind } from './model';

/**
 * The affordance on a Correspondence, Source, or Attachment page to send a Consent_Request naming that element
 * (R51.2). The element is prefilled; the Administrator chooses the External_Party and the proposed values. On a
 * Correspondence the kind is publication; on a Source or Attachment it is rights. Only an Administrator with
 * `consent.request` sees it; the dialog surfaces the R51.3 gate-failure reasons.
 */
export function ConsentRequestLaunch({ element, kind, defaultPartyId, members }: {
  readonly element: ConsentElement;
  readonly kind: ConsentKind;
  /** The External_Party to prefill, when the element has one obvious Party (a Correspondence's External_Party). */
  readonly defaultPartyId?: string;
  readonly members: readonly MemberRow[];
}) {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const parties = useLoad<{ parties: PartyRecord[] }>(open ? '/parties' : undefined);
  if (!session.can('consent.request')) return null;
  const all = parties.data?.parties ?? [];
  const prefilled = defaultPartyId === undefined ? undefined : all.find((candidate) => candidate.id === defaultPartyId);
  return (
    <section className="rf-section" aria-label="Request consent for this element">
      <h2>Request consent or permission</h2>
      {!open
        ? <Button onClick={() => setOpen(true)}>Send a Consent Request</Button>
        : (
          <ConsentRequestDialog
            {...(prefilled === undefined ? {} : { party: prefilled })}
            parties={all}
            elements={[element]}
            kind={kind}
            members={members}
            onSent={() => undefined}
            onCancel={() => setOpen(false)}
          />
        )}
    </section>
  );
}
