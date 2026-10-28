import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ITEM_KIND_NAMES } from '@researchforce/domain/kind-names';
import type { RichText } from '@researchforce/domain/richtext';
import { ITEM_KINDS } from '@researchforce/domain/types';
import type { ItemKind } from '@researchforce/domain/types';
import { BUILT_IN_VALUE_IDS, RESUMABLE_RUN_OUTCOME_IDS } from '@researchforce/domain/value-sets';
import type { ValueSetKind } from '@researchforce/domain/value-sets';
import { AccessSummary, RestrictedMark } from '../access/access';
import { RichTextView } from '../editor/RichTextView';
import { Thread, mentionOptions } from '../discussion/thread';
import { DeletedItem, deletionOf } from '../history/delete';
import { PendingReview, ReviewList, ReviewRequestForm, reviewOptions } from '../reviews/reviews';
import type { CreditView, ItemView, LinkEntry, MemberRow, PartyRecord, ThreadEntryView, ValueSets } from '../types';
import { useApi } from '../api';
import { useSession } from '../session';
import { DisclosureStatus, formatDate, LoadState, Notice, PersonLink, useLoad } from '../ui';
import { partyName } from './forms/inputs';
import { KIND_FIELDS } from './forms/model';
import type { CorrespondencePartyValue, CountValue, DateValue, DocumentDateValue, FieldSpec, PartyValue } from './forms/model';

export interface ItemPageData {
  readonly item: ItemView;
  readonly valueSets: ValueSets;
  readonly parties: readonly PartyRecord[];
  readonly members: readonly MemberRow[];
  readonly links: readonly LinkEntry[];
  readonly backlinks: readonly LinkEntry[];
  /** The Thread's Replies in any order, with placeholders of deleted Replies. */
  readonly thread: readonly ThreadEntryView[];
  /** Load the item and its Thread again after a Reply or a review change. */
  readonly onChanged?: () => void;
}

const valueName = (sets: ValueSets, set: ValueSetKind | undefined, id: unknown): string => {
  if (typeof id !== 'string') return '';
  return (set === undefined ? undefined : sets[set]?.find((value) => value.id === id)?.name) ?? id;
};
const formatPartial = (date: DateValue): string => (date.approx ? `about ${date.value}` : date.value);
const isRich = (value: unknown): value is RichText => typeof value === 'object' && value !== null && 'text' in value && 'spans' in value;

const END_KIND_NAMES: Readonly<Record<string, string>> = { entry_section: 'Entry Section of', reply: 'Reply on', attachment: 'Attachment' };
const endKindName = (kind: string): string => (ITEM_KINDS as readonly string[]).includes(kind) ? ITEM_KIND_NAMES[kind as ItemKind] : END_KIND_NAMES[kind] ?? kind;

function creditLabel(entry: CreditView): ReactNode {
  if ('member' in entry) return <PersonLink person={entry.member} />;
  const value = 'outside' in entry ? entry.outside : entry.imported;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string') return value.name;
  return 'outside' in entry ? 'Outside submitter' : 'Imported credit';
}

function Entry({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <><dt>{label}</dt><dd>{children}</dd></>;
}

/** One stored field as the page shows it. */
function FieldValue({ spec, value, data }: { readonly spec: FieldSpec; readonly value: unknown; readonly data: ItemPageData }): ReactNode {
  const memberName = (id: string) => data.members.find((member) => member.id === id)?.displayName ?? null;
  const party = (entry: PartyValue | CorrespondencePartyValue): ReactNode => {
    if (entry.kind === 'member') return <PersonLink person={{ id: entry.id, displayName: memberName(entry.id) }} />;
    const record = data.parties.find((candidate) => candidate.id === entry.id);
    return record === undefined ? entry.id : partyName(record);
  };
  switch (spec.kind) {
    case 'rich': return isRich(value) ? <RichTextView value={value} /> : null;
    case 'value': return valueName(data.valueSets, spec.set, value);
    case 'choice': return spec.options?.find((option) => option.value === value)?.label ?? String(value);
    case 'partial-date': case 'full-date': return formatPartial(value as DateValue);
    case 'document-date': {
      const date = value as DateValue | DocumentDateValue;
      return 'start' in date ? `${formatPartial(date.start)} to ${formatPartial(date.end)}` : formatPartial(date);
    }
    case 'party': return party(value as PartyValue);
    case 'members': return <ul className="rf-list">{(value as string[]).map((id) => <li key={id}><PersonLink person={{ id, displayName: memberName(id) }} /></li>)}</ul>;
    case 'correspondence-parties': return (
      <ul className="rf-list">{(value as CorrespondencePartyValue[]).map((entry) => (
        <li key={`${entry.kind}:${entry.id}`}>{party(entry)}{entry.kind === 'external' && ` (consent: ${(entry.consent ?? 'not_asked').replace('_', ' ')})`}</li>
      ))}</ul>
    );
    case 'counts': return <ul className="rf-list">{(value as CountValue[]).map((count) => <li key={count.name}>{`${count.name}: ${count.value}`}</li>)}</ul>;
    case 'item-ref': return <Link to={`/items/${String(value)}`}>{String(value)}</Link>;
    default: return String(value);
  }
}

/** Fields shown in their companion blocks rather than in the general list. */
const COMPANION_FIELDS: Readonly<Partial<Record<ItemKind, readonly string[]>>> = {
  finding: ['claim', 'statusValueId', 'scopeCaveat', 'supersededById', 'withdrawalReason'],
  source: ['sourceKind', 'reliabilityId'],
  run: ['outcomeId', 'resumePoint'],
  hypothesis: ['statusValueId', 'eliminationScope'],
};
const HIDDEN_FIELDS = new Set(['title', 'logSummary', 'groupNote', 'sections']);

/** Companion fields in one block with the field they qualify (R5.6, R5.10, R6.3, R7.4, R8.3). */
function Companions({ data }: { readonly data: ItemPageData }) {
  const { item, valueSets } = data;
  switch (item.kind) {
    case 'finding': {
      const status = item['statusValueId'];
      return (
        <section className="rf-companion" aria-label="Claim">
          <h2>Claim</h2>
          {isRich(item['claim']) && <RichTextView value={item['claim']} />}
          <dl>
            <Entry label="Finding status">{valueName(valueSets, 'finding_status', status)}</Entry>
            {status === BUILT_IN_VALUE_IDS.findingSuperseded && typeof item['supersededById'] === 'string' && (
              <Entry label="Superseded by"><Link to={`/items/${item['supersededById']}`}>The superseding Finding</Link></Entry>
            )}
            <Entry label="Scope caveat">{isRich(item['scopeCaveat']) ? <RichTextView value={item['scopeCaveat']} /> : null}</Entry>
            {typeof item['withdrawalReason'] === 'string' && <Entry label="Withdrawal reason">{item['withdrawalReason']}</Entry>}
          </dl>
        </section>
      );
    }
    case 'source':
      return (
        <section className="rf-companion" aria-label="Source kind and reliability">
          <dl>
            <Entry label="Source kind">{item['sourceKind'] === 'primary' ? 'Primary' : 'Secondary'}</Entry>
            <Entry label="Reliability">{valueName(valueSets, 'reliability', item['reliabilityId'])}</Entry>
          </dl>
        </section>
      );
    case 'run': {
      const outcome = item['outcomeId'];
      const resumable = typeof outcome === 'string' && RESUMABLE_RUN_OUTCOME_IDS.has(outcome as never);
      const resumePoint = typeof item['resumePoint'] === 'string' ? item['resumePoint'] : undefined;
      return (
        <section className="rf-companion" aria-label="Run outcome">
          <dl>
            <Entry label="Run outcome">{valueName(valueSets, 'run_outcome', outcome)}</Entry>
            {(resumable || resumePoint !== undefined) && <Entry label="Resume point">{resumePoint ?? 'No resume point is recorded.'}</Entry>}
          </dl>
        </section>
      );
    }
    case 'hypothesis': {
      const eliminated = item['statusValueId'] === BUILT_IN_VALUE_IDS.hypothesisEliminated;
      return (
        <section className="rf-companion" aria-label="Hypothesis status">
          <dl>
            <Entry label="Hypothesis status">{valueName(valueSets, 'hypothesis_status', item['statusValueId'])}</Entry>
            {eliminated && <Entry label="Elimination scope">{isRich(item['eliminationScope']) ? <RichTextView value={item['eliminationScope']} /> : null}</Entry>}
          </dl>
        </section>
      );
    }
    default:
      return null;
  }
}

function LinkList({ title, entries, empty }: { readonly title: string; readonly entries: readonly LinkEntry[]; readonly empty: string }) {
  return (
    <section className="rf-section" aria-label={title}>
      <h2>{title}</h2>
      {entries.length === 0 ? <p className="rf-meta">{empty}</p> : (
        <ul className="rf-list">
          {entries.map((entry) => {
            const { end } = entry;
            const name = `${endKindName(end.kind)} ${end.identifier ?? ''}${end.title === null ? '' : `: ${end.title}`}`.trim();
            return (
              <li key={entry.id}>
                {entry.relation !== null && <span className="rf-status">{entry.relation.name}</span>}{' '}
                {end.deletedAt === undefined ? <Link to={`/items/${end.rootId ?? end.id}`}>{name}</Link> : <span>{name}</span>}
                {end.restricted === true && <>{' '}<RestrictedMark /></>}
                {end.source !== undefined && <span className="rf-meta">{` (${end.source.sourceKind === 'primary' ? 'Primary' : 'Secondary'} source; reliability: ${end.source.reliability})`}</span>}
                {end.withdrawn && <Notice tone="warning" title="This record has been withdrawn." />}
                {end.deletedAt !== undefined && <Notice tone="warning" title={`This record was permanently deleted on ${formatDate(end.deletedAt)}.`} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A Research_Item's page (R3.5, R15.3, R16.4, R17.7, R17.11, R23.9, R39.15, R41.9). */
export function ItemDetails({ data }: { readonly data: ItemPageData }) {
  const { item } = data;
  const session = useSession();
  const onChanged = data.onChanged ?? (() => undefined);
  const sectionNumber = (id: string) => {
    const index = item.sections?.findIndex((section) => section.id === id) ?? -1;
    return index < 0 ? undefined : index + 1;
  };
  const reviewTargets = [{ value: item.id, label: 'The whole record' }, ...(item.sections ?? []).map((section, index) => ({ value: section.id, label: `Entry Section ${index + 1}` }))];
  const companions = new Set(COMPANION_FIELDS[item.kind] ?? []);
  const fields = KIND_FIELDS[item.kind].filter((spec) => !HIDDEN_FIELDS.has(spec.name) && !companions.has(spec.name) && item[spec.name] !== undefined && item[spec.name] !== null);
  return (
    <article className="rf-stack">
      <header>
        <p className="rf-meta">{`${ITEM_KIND_NAMES[item.kind]} ${item.identifier}`}</p>
        <h1>{item.title}</h1>
        {item.access.level === 'restricted' && <p><RestrictedMark /></p>}
        {item.pendingReview && <p><PendingReview /></p>}
        <p>{'Project: '}<strong>{item.project.name}</strong></p>
        <DisclosureStatus disclosure={item.disclosure} />
        {item.disclosure.line !== undefined && <p className="rf-disclosure-line">{item.disclosure.line}</p>}
        <div className="rf-actions">
          <Link className="rf-button" to={`/items/${item.id}/edit`}>Edit</Link>
          <Link className="rf-button" to={`/items/${item.id}/history`}>History</Link>
          {item.withdrawal === null && <Link className="rf-button" to={`/items/${item.id}/withdraw`}>Withdraw</Link>}
          {session.can('item.delete') && <Link className="rf-button rf-button--danger" to={`/items/${item.id}/delete`}>Delete permanently</Link>}
        </div>
      </header>
      <AccessSummary item={item} members={data.members} onChanged={onChanged} />
      {item.withdrawal !== null && (
        <Notice tone="warning" title={`Withdrawn on ${formatDate(item.withdrawal.at)}`}>
          <p>{'By '}<PersonLink person={item.withdrawal.by} />{item.withdrawal.reason === null ? '' : `: ${item.withdrawal.reason}`}</p>
        </Notice>
      )}
      <section className="rf-section" aria-label="Owner and Credit">
        <dl>
          <Entry label="Owner">
            <PersonLink person={item.owner} />
            {item.owner.specialties.length > 0 && <span className="rf-meta">{` (${item.owner.specialties.map((specialty) => specialty.name).join(', ')})`}</span>}
          </Entry>
          <Entry label="Credit">
            <ul className="rf-list">{item.credit.map((entry, index) => <li key={index}>{creditLabel(entry)}</li>)}</ul>
          </Entry>
        </dl>
      </section>
      <Companions data={data} />
      {fields.length > 0 && (
        <section className="rf-section" aria-label="Fields">
          <dl>{fields.map((spec) => <Entry key={spec.name} label={spec.label}><FieldValue spec={spec} value={item[spec.name]} data={data} /></Entry>)}</dl>
        </section>
      )}
      {item.sections !== undefined && (
        <section className="rf-section" aria-label="Entry Sections">
          <h2>Entry Sections</h2>
          {item.sections.map((section, index) => (
            <section key={section.id} id={`section-${section.id}`} aria-label={`Entry Section ${index + 1}`}>
              {section.pendingReview === true && <p><PendingReview /></p>}
              <RichTextView value={section.content} />
              <DisclosureStatus disclosure={section.disclosure} />
            </section>
          ))}
        </section>
      )}
      <section className="rf-section" aria-label="Log Summary">
        <h2>Log Summary</h2>
        {item.logSummary !== undefined && item.logSummary.text.trim() !== ''
          ? <><p className="rf-meta">{'By '}<PersonLink person={item.owner} /></p><RichTextView value={item.logSummary} /></>
          : <p className="rf-meta">No Log Summary is recorded.</p>}
      </section>
      <LinkList title="Cross-links" entries={data.links} empty="No Cross-links from this record." />
      <LinkList title="Backlinks" entries={data.backlinks} empty="No Backlinks to this record." />
      <section className="rf-section" aria-label="Review requests">
        <h2>Review requests</h2>
        <ReviewList reviews={item.reviews} sectionNumber={sectionNumber} onChanged={onChanged} />
        {session.can('review.request') && <ReviewRequestForm targets={reviewTargets} options={reviewOptions(session, data.members)} onRequested={onChanged} />}
      </section>
      <section className="rf-section" aria-label="Thread">
        <h2>Thread{item.access.level === 'restricted' && <>{' '}<RestrictedMark /></>}</h2>
        <Thread rootId={item.id} entries={data.thread} mentions={mentionOptions(data.members, session.me.specialtyOptions)} canReply={session.can('reply.post')}
          onChanged={onChanged} groupNote={item.groupNote} />
      </section>
      <section className="rf-section" aria-label="Submit from here">
        <h2>Submit a new record in this Project</h2>
        <ul className="rf-actions rf-list">
          {ITEM_KINDS.map((kind) => <li key={kind}><Link to={`/items/new/${kind}?unit=${item.id}`}>{ITEM_KIND_NAMES[kind]}</Link></li>)}
        </ul>
      </section>
    </article>
  );
}

/** Every page of a link listing, which has no upper bound (R15.3). */
function useAllLinks(query: string): { entries: LinkEntry[] | undefined; error: unknown } {
  const client = useApi();
  const [state, setState] = useState<{ query: string; entries: LinkEntry[] | undefined; error: unknown }>({ query, entries: undefined, error: undefined });
  useEffect(() => {
    let current = true;
    const load = async () => {
      const entries: LinkEntry[] = [];
      let after: string | null = null;
      do {
        const page: { entries: LinkEntry[]; next: string | null } = await client.get(`/links?${query}${after === null ? '' : `&after=${after}`}`);
        entries.push(...page.entries);
        after = page.next;
      } while (after !== null);
      return entries;
    };
    load().then(
      (entries) => { if (current) setState({ query, entries, error: undefined }); },
      (error: unknown) => { if (current) setState({ query, entries: undefined, error }); },
    );
    return () => { current = false; };
  }, [client, query]);
  return state.query === query ? state : { entries: undefined, error: undefined };
}

export function ItemPage({ id }: { readonly id: string }) {
  const item = useLoad<{ item: ItemView }>(`/items/${id}`);
  const valueSets = useLoad<{ valueSets: ValueSets }>('/value-sets');
  const parties = useLoad<{ parties: PartyRecord[] }>('/parties');
  const members = useLoad<{ members: MemberRow[] }>('/members');
  const thread = useLoad<{ replies: ThreadEntryView[] }>(`/items/${id}/thread`);
  const links = useAllLinks(`origin=${id}`);
  const backlinks = useAllLinks(`target=${id}`);
  const deletion = deletionOf(item.error);
  if (deletion !== undefined) return <DeletedItem deletion={deletion} />;
  if (!item.data || !valueSets.data || !parties.data || !members.data || !thread.data || !links.entries || !backlinks.entries) {
    return <LoadState error={item.error ?? valueSets.error ?? parties.error ?? members.error ?? thread.error ?? links.error ?? backlinks.error} />;
  }
  return (
    <ItemDetails data={{
      item: item.data.item, valueSets: valueSets.data.valueSets, parties: parties.data.parties, members: members.data.members,
      links: links.entries, backlinks: backlinks.entries, thread: thread.data.replies, onChanged: () => { item.reload(); thread.reload(); },
    }} />
  );
}
