import { AttachmentList } from '../files/attachment-page';
import { UploadFields, useUploads } from '../files/upload';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { buildThread } from '@researchforce/domain/thread';
import type { ThreadNode } from '@researchforce/domain/thread';
import type { RichText } from '@researchforce/domain/richtext';
import { FlagMark } from '../activity/activity';
import { ApiFailure, useApi } from '../api';
import { RichTextEditor } from '../editor/RichTextEditor';
import type { MentionOptions } from '../editor/RichTextEditor';
import { RichTextView } from '../editor/RichTextView';
import { usePersistentForm } from '../persist';
import type { DisclosureView, FlagKind, MemberRow, SpecialtyRef, ThreadEntryView } from '../types';
import { Button, DisclosureStatus, formatDate, Notice, PersonLink, RestoredNotice, SaveFailure } from '../ui';

/** A Mention can name an active Member with a display name or a Specialty that is not retired (R16.8). */
export function mentionOptions(members: readonly MemberRow[], specialties: readonly SpecialtyRef[]): MentionOptions {
  return {
    members: members.flatMap((member) => (member.status === 'active' && member.displayName !== null ? [{ id: member.id, displayName: member.displayName }] : [])),
    specialties: specialties.filter((specialty) => specialty.retired !== true),
  };
}

const EMPTY: RichText = { text: '', spans: [] };

/** Post a Reply to an Item or a Reply; the text, with any Mentions, stays in this tab until it is posted (R16.2, R16.3, R16.8). */
export function ReplyComposer({ parentId, label, mentions, onPosted, onCancel }: {
  readonly parentId: string; readonly label: string; readonly mentions: MentionOptions; readonly onPosted: () => void; readonly onCancel?: () => void;
}) {
  const uploads = useUploads(`reply:${parentId}`);
  const client = useApi();
  const form = usePersistentForm<{ text: RichText }>(`reply:${parentId}`, { text: EMPTY });
  const [failure, setFailure] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (uploads.guard()) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await client.post('/replies', { parentId, text: form.values.text, ...(uploads.files.length ? { files: uploads.selected() } : {}) });
      form.discard();
      uploads.sent();
      onPosted();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  const textErrors = failure instanceof ApiFailure ? failure.issuesFor('text') : [];
  const parentErrors = failure instanceof ApiFailure ? failure.issuesFor('parentId') : [];
  return (
    <form className="rf-stack" aria-label={label} onSubmit={(event) => void submit(event)} noValidate>
      {form.restored && <RestoredNotice onDiscard={form.discard} />}
      <SaveFailure error={failure} />
      {parentErrors.map((issue) => <Notice key={issue.rule} tone="danger" title={issue.rule} />)}
      <RichTextEditor label={label} value={form.values.text} onChange={(text) => form.set('text', text)} mentions={mentions} errors={textErrors} required hint="1 to 50,000 characters." />
      <UploadFields uploads={uploads} />
      <div className="rf-actions">
        <Button type="submit" variant="primary" disabled={busy || uploads.reasons.length > 0}>Post reply</Button>
        {onCancel !== undefined && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

interface ThreadProps {
  readonly rootId: string;
  readonly entries: readonly ThreadEntryView[];
  readonly mentions: MentionOptions;
  readonly canReply: boolean;
  readonly onChanged: () => void;
  /** The Group_Note's disclosure, which the item response carries. */
  readonly groupNote?: { readonly id: string; readonly disclosure: DisclosureView } | null;
  /** The flag each Reply had when the page opened (R18.10). */
  readonly flagOf?: (id: string) => FlagKind | null;
}

function ReplyView({ node, props, replyingTo, setReplyingTo }: {
  readonly node: ThreadNode<ThreadEntryView>; readonly props: ThreadProps; readonly replyingTo: string | null; readonly setReplyingTo: (id: string | null) => void;
}) {
  const { reply } = node;
  const noun = reply.isGroupNote ? 'Group Note' : 'Reply';
  const name = reply.owner?.displayName ?? 'a Member';
  return (
    <li>
      {reply.owner === undefined || reply.text === undefined ? (
        <article className="rf-companion" id={`reply-${reply.id}`} aria-label={`Deleted ${noun}`}>
          <p className="rf-meta">{`This ${noun} was permanently deleted on ${formatDate(reply.deletedAt ?? reply.postedAt)}.`}</p>
        </article>
      ) : (
        <article className="rf-companion" id={`reply-${reply.id}`} aria-label={`${noun} by ${name}`}>
          <p>
            {reply.isGroupNote && <><span className="rf-status">Group Note</span>{' '}</>}
            <FlagMark flag={props.flagOf?.(reply.id)} />{props.flagOf?.(reply.id) ? ' ' : ''}
            {'By '}<PersonLink person={reply.owner} /><span className="rf-meta">{` on ${formatDate(reply.postedAt)}`}</span>
          </p>
          {reply.withdrawal && (
            <Notice tone="warning" title={`This ${noun} was withdrawn on ${formatDate(reply.withdrawal.at)}.`}>
              {reply.withdrawal.reason === null ? undefined : <p>{reply.withdrawal.reason}</p>}
            </Notice>
          )}
          <RichTextView value={reply.text} />
          <AttachmentList parentId={reply.id} />
          {reply.isGroupNote && props.groupNote?.id === reply.id && <DisclosureStatus disclosure={props.groupNote.disclosure} />}
          {props.canReply && replyingTo !== reply.id && <div className="rf-actions"><Button variant="quiet" onClick={() => setReplyingTo(reply.id)}>Reply</Button></div>}
        </article>
      )}
      {replyingTo === reply.id && (
        <ReplyComposer parentId={reply.id} label={`Reply to ${name}`} mentions={props.mentions} onCancel={() => setReplyingTo(null)}
          onPosted={() => { setReplyingTo(null); props.onChanged(); }} />
      )}
      {node.children.length > 0 && <ThreadList nodes={node.children} props={props} replyingTo={replyingTo} setReplyingTo={setReplyingTo} />}
    </li>
  );
}

function ThreadList({ nodes, props, replyingTo, setReplyingTo }: {
  readonly nodes: readonly ThreadNode<ThreadEntryView>[]; readonly props: ThreadProps; readonly replyingTo: string | null; readonly setReplyingTo: (id: string | null) => void;
}) {
  return <ol className="rf-thread">{nodes.map((node) => <ReplyView key={node.reply.id} node={node} props={props} replyingTo={replyingTo} setReplyingTo={setReplyingTo} />)}</ol>;
}

/**
 * The Thread rooted at an Item as a tree: each Reply under its Parent, siblings oldest first, the Group_Note first, and
 * placeholders of deleted Replies in their place (R16.4, R16.10, R41.7).
 */
export function Thread(props: ThreadProps) {
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const tree = buildThread(props.entries);
  return (
    <>
      {tree.length === 0 ? <p className="rf-meta">No Replies yet.</p> : <ThreadList nodes={tree} props={props} replyingTo={replyingTo} setReplyingTo={setReplyingTo} />}
      {props.canReply && <ReplyComposer parentId={props.rootId} label="Your reply" mentions={props.mentions} onPosted={props.onChanged} />}
    </>
  );
}
