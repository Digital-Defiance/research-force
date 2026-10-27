import type { DisclosureUnitType, Level, PublicPresentation } from '@researchforce/domain/types';

/** One Disclosure_Unit with its Parent chain. Projects have no parent, root, or project. */
export interface DNode {
  readonly key: string;
  readonly type: DisclosureUnitType;
  readonly own: Level;
  readonly unclassified: boolean;
  /** Research_Items only. */
  readonly presentation?: PublicPresentation;
  readonly parent?: DNode;
  /** The Root_Item; derived from the Parent chain when absent. */
  readonly root?: DNode;
  /** Required on Research_Items; other units take their Root_Item's Project. */
  readonly project?: DNode;
}

/** Called with a unit's level once every ancestor is Public; it can only lower that level. */
export type LevelAdjustment = (node: DNode, level: Level) => Level;

const RANK: Readonly<Record<Level, number>> = { private: 0, withheld: 1, public: 2 };
export function lessPublic(a: Level, b: Level): Level { return RANK[a] <= RANK[b] ? a : b; }
export function morePublicThan(a: Level, b: Level): boolean { return RANK[a] > RANK[b]; }

function parentChain(node: DNode): DNode[] {
  const chain: DNode[] = [];
  const seen = new Set<DNode>([node]);
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (seen.has(parent)) throw new RangeError(`Disclosure unit ${node.key} has a cyclic Parent chain.`);
    if (parent.type === 'project') throw new RangeError(`Disclosure unit ${node.key} names a Project as its Parent.`);
    seen.add(parent);
    chain.push(parent);
  }
  return chain;
}

export function rootOf(node: DNode): DNode | undefined {
  if (node.type === 'project') return undefined;
  return node.root ?? parentChain(node).at(-1) ?? node;
}

/** The Parent chain up to the Root_Item, followed by the Root_Item's Project. */
export function ancestors(node: DNode): DNode[] {
  if (node.type === 'project') return [];
  const chain = parentChain(node);
  const project = rootOf(node)!.project ?? node.project;
  if (!project || project.type !== 'project') throw new RangeError(`Disclosure unit ${node.key} has no Project.`);
  chain.push(project);
  return chain;
}

function compute(node: DNode, adjust: LevelAdjustment | undefined, memo: Map<DNode, Level>): Level {
  const known = memo.get(node);
  if (known !== undefined) return known;
  let level: Level;
  if (node.type === 'project') {
    level = adjust ? lessPublic(adjust(node, node.own), node.own) : node.own;
  } else {
    const own: Level = node.unclassified ? 'private' : node.own; // R26.5
    const needsFull = node.type === 'entry_section' || node.type === 'reply' || node.type === 'dissent_note';
    if (ancestors(node).some((ancestor) => compute(ancestor, adjust, memo) !== 'public')) level = 'private';
    else if (needsFull && rootOf(node)!.presentation !== 'full_content') level = 'private';
    else level = adjust && own !== 'private' ? lessPublic(adjust(node, own), own) : own;
  }
  memo.set(node, level);
  return level;
}

/** Effective_Disclosure (R23.1, R23.3, R24.5, R26.5). Pass one memo across calls to share work over a tree. */
export function effective(node: DNode, adjust?: LevelAdjustment, memo: Map<DNode, Level> = new Map()): Level {
  return compute(node, adjust, memo);
}
