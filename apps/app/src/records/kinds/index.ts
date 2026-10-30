import type { ItemKind } from '@researchforce/domain/types';
import { archival } from './archival';
import { decision } from './decision';
import { correspondence } from './correspondence';
import { finding } from './finding';
import { hypothesis } from './hypothesis';
import { journal } from './journal';
import { question } from './question';
import type { KindAdapter } from './kind';
import { run } from './run';
import { source } from './source';
import { topic } from './topic';
import { workItem } from './work';

export const KIND_ADAPTERS: Readonly<Record<ItemKind, KindAdapter>> = {
  journal_entry: journal, finding, source, run, hypothesis, correspondence, archival_request: archival, topic, research_question: question, decision_record: decision, work_item: workItem,
};
