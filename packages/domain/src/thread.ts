/** What placing a Reply in its Thread needs; a permanently deleted Reply stays in the list as its placeholder (R16.10). */
export interface ThreadReply {
  readonly id: string;
  /** The Research_Item, Attachment, or Reply it answers. */
  readonly parentId: string;
  readonly postedAt: string;
  readonly isGroupNote: boolean;
}
export interface ThreadNode<T extends ThreadReply> {
  readonly reply: T;
  readonly children: readonly ThreadNode<T>[];
}

/** The Group_Note first, then oldest first by posting time, with the id breaking ties (R16.4, R41.7). */
function siblingOrder(a: ThreadReply, b: ThreadReply): number {
  if (a.isGroupNote !== b.isGroupNote) return a.isGroupNote ? -1 : 1;
  if (a.postedAt !== b.postedAt) return a.postedAt < b.postedAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The Thread as a tree: each Reply under its Parent, and Replies whose Parent is not a Reply of the list (the
 * Thread's Item) at the top (R16.3, R16.4). Placeholders of deleted Replies keep their place and their children.
 */
export function buildThread<T extends ThreadReply>(replies: readonly T[]): ThreadNode<T>[] {
  const ids = new Set(replies.map((reply) => reply.id));
  const children = new Map<string | null, T[]>();
  for (const reply of replies) {
    const parent = ids.has(reply.parentId) && reply.parentId !== reply.id ? reply.parentId : null;
    const list = children.get(parent);
    if (list) list.push(reply);
    else children.set(parent, [reply]);
  }
  const grow = (parent: string | null): ThreadNode<T>[] => (children.get(parent) ?? []).sort(siblingOrder).map((reply) => ({ reply, children: grow(reply.id) }));
  return grow(null);
}
