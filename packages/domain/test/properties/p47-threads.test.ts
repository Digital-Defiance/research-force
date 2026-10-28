// Feature: research-collab-cms, Property 47: Threads are trees in posting order
import { expect, it } from 'vitest';
import { fc } from '@researchforce/testing/fc';
import { buildThread } from '../../src/thread';
import type { ThreadNode, ThreadReply } from '../../src/thread';

const ROOT = 'ROOT';
/** Replies posted in order: each answers the Item, a Reply posted before it, or a Reply no longer in the list; at most one Group_Note, on the Item. */
const threadArb = fc.array(fc.record({
  parent: fc.oneof(fc.constant(-1), fc.constant(-2), fc.nat()),
  minute: fc.integer({ min: 0, max: 5 }),
}), { maxLength: 30 }).chain((specs) => fc.record({
  ids: fc.uniqueArray(fc.stringMatching(/^[0-9A-Z]{4}$/), { minLength: specs.length, maxLength: specs.length }),
  groupNote: fc.option(fc.nat({ max: Math.max(specs.length - 1, 0) }), { nil: undefined }),
  order: fc.shuffledSubarray(specs.map((_, index) => index), { minLength: specs.length, maxLength: specs.length }),
}).map(({ ids, groupNote, order }) => {
  const replies: ThreadReply[] = specs.map((spec, index) => {
    const isGroupNote = index === groupNote;
    const parentId = isGroupNote || spec.parent === -1 || index === 0 ? ROOT : spec.parent === -2 ? `GONE${index}` : ids[spec.parent % index]!;
    return { id: ids[index]!, parentId, postedAt: `2026-10-27T18:0${spec.minute}:00.000Z`, isGroupNote };
  });
  return { replies, shuffled: order.map((index) => replies[index]!) };
}));

function flatten(nodes: readonly ThreadNode<ThreadReply>[]): ThreadReply[] {
  return nodes.flatMap((node) => [node.reply, ...flatten(node.children)]);
}
function inOrder(siblings: readonly ThreadNode<ThreadReply>[]): boolean {
  return siblings.every((node, index) => {
    if (index === 0) return true;
    const [a, b] = [siblings[index - 1]!.reply, node.reply];
    if (b.isGroupNote) return false;
    if (a.isGroupNote) return true;
    return a.postedAt < b.postedAt || (a.postedAt === b.postedAt && a.id < b.id);
  });
}
function check(nodes: readonly ThreadNode<ThreadReply>[], parentId: string | null, ids: ReadonlySet<string>): void {
  expect(inOrder(nodes)).toBe(true);
  for (const node of nodes) {
    if (parentId === null) expect(ids.has(node.reply.parentId)).toBe(false);
    else expect(node.reply.parentId).toBe(parentId);
    check(node.children, node.reply.id, ids);
  }
}

it('shows each Reply once under its Parent, siblings oldest first, and the Group_Note first, whatever order they arrive in', () => {
  fc.assert(fc.property(threadArb, ({ replies, shuffled }) => {
    const tree = buildThread(shuffled);
    const ids = new Set(replies.map((reply) => reply.id));
    expect(flatten(tree).map((reply) => reply.id).sort()).toEqual([...ids].sort());
    check(tree, null, ids);
    const groupNote = replies.find((reply) => reply.isGroupNote);
    if (groupNote) expect(tree[0]!.reply).toBe(groupNote);
    expect(buildThread(replies)).toEqual(tree);
  }));
});
