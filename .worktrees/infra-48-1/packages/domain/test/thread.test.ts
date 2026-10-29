import { describe, expect, it } from 'vitest';
import { buildThread } from '../src/thread';
import type { ThreadNode, ThreadReply } from '../src/thread';

const reply = (id: string, parentId: string, minute: number, isGroupNote = false) => ({ id, parentId, postedAt: `2026-10-27T18:0${minute}:00.000Z`, isGroupNote });
const shape = (nodes: readonly ThreadNode<ThreadReply>[]): unknown[] => nodes.map((node) => (node.children.length === 0 ? node.reply.id : [node.reply.id, shape(node.children)]));

describe('buildThread', () => {
  it('nests Replies under their Parents with the Group_Note first and siblings oldest first', () => {
    const replies = [reply('D', 'B', 1), reply('B', 'ITEM', 2), reply('A', 'ITEM', 1), reply('G', 'ITEM', 9, true), reply('C', 'B', 1), reply('E', 'D', 3)];
    expect(shape(buildThread(replies))).toEqual(['G', 'A', ['B', ['C', ['D', ['E']]]]]);
  });

  it('puts Replies whose Parent is not in the list, or is the Reply itself, at the top', () => {
    expect(shape(buildThread([reply('B', 'GONE', 1), reply('A', 'A', 2)]))).toEqual(['B', 'A']);
    expect(buildThread([])).toEqual([]);
  });

  it('keeps the caller’s objects', () => {
    const entry = { ...reply('A', 'ITEM', 1), text: 'synthetic' };
    expect(buildThread([entry])[0]!.reply).toBe(entry);
  });
});
