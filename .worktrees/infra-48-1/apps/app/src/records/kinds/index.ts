import type { ItemKind } from '@researchforce/domain/types';
import { archival } from './archival';
import { correspondence } from './correspondence';
import { finding } from './finding';
import { hypothesis } from './hypothesis';
import { journal } from './journal';
import type { KindAdapter } from './kind';
import { run } from './run';
import { source } from './source';
import { topic } from './topic';

export const KIND_ADAPTERS: Readonly<Record<ItemKind, KindAdapter>> = {
  journal_entry: journal, finding, source, run, hypothesis, correspondence, archival_request: archival, topic,
};
