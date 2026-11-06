import type { Context } from 'hono';
import { z } from 'zod';
import {
  AI_FALLBACK_MODEL,
  AI_MODEL,
  cutToInputLimit,
  DRAFT_MAX_TOKENS,
  isAllowedModel,
  isDisclosureField,
  isEmptyInput,
  neuronsFromTokens,
  reservationNeurons,
  systemPrompt,
  worstCaseDraftNeurons,
} from '@researchforce/domain/ai';
import type { DraftField } from '@researchforce/domain/ai';
import { shapeDisclosureDraft, shapeSummaryDraft } from '@researchforce/domain/ai-output';
import { SETTINGS } from '@researchforce/domain/settings';
import { isBlank } from '@researchforce/domain/text';
import { isULID } from '@researchforce/domain/types';
import type { ULID } from '@researchforce/domain/types';
import type { ApiEnv } from '../api/app';
import { ApiError } from '../api/errors';
import { parse } from '../api/input';
import { authorize } from '../auth/authorize';
import type { PermissionCheck } from '../auth/authorize';
import { loadItem } from '../records/items';
import type { LoadedItem } from '../records/items';
import { visibleTo } from '../records/submissions';
import { assembleDraftInput } from './input';
import type { AttachmentMeta, EditorText } from './input';

/**
 * The AI_Draft API (task 42.1, design "AI drafting", R44, R28.14, R28.15). `GET /ai/status` says whether
 * drafting is available right now; `POST /ai/drafts` produces one AI_Draft. The handler checks the
 * AI_Drafting_Setting, the Permission for the requested field, and Can_Read of the Research_Item; assembles the
 * input in Workspace display order (never file contents) preferring the editor's unsaved text; cuts it to the
 * AI_Input_Limit; reserves the worst-case Neurons in `Budget` and refuses when none remain; calls an
 * allow-listed Cloudflare-hosted model through the `AI` binding with a fixed system prompt, a 30-second
 * deadline, and no AI Gateway/logging/caching/batch; settles the reservation with the reported usage; and
 * stores and logs NEITHER the prompt NOR the draft. Public_Traffic, imports, and restores never reach it: the
 * route is mounted only on the authenticated Workspace API, and those entrypoints do not mount it (R44.13).
 */

/** The 30-second deadline every model call runs under (R44.12, design "Timing and errors"). */
export const AI_DEADLINE_MS = 30_000;

/** The fixed "no AI_Draft was produced" notice for an error, empty output, or timeout (R44.12). */
export const NO_DRAFT = Object.freeze({ draft: null as string | null, reason: 'no_draft' as const });
/** The fixed "there is no text to draft from" notice for empty or whitespace-only input (R44.18). */
export const EMPTY_INPUT = Object.freeze({ draft: null as string | null, reason: 'empty_input' as const });
/** The fixed "AI drafting resumes at 00:00 UTC" notice when no Neuron headroom remains (R44.10, R44.17). */
export const NEURONS_EXHAUSTED = Object.freeze({ error: 'unavailable' as const, reason: 'resumes_at_utc_midnight' as const, message: 'AI drafting resumes at 00:00 UTC.' });
/** The fixed "AI drafting is turned off" notice while the AI_Drafting_Setting is Off (R44.11, R44.17). */
export const DRAFTING_OFF = Object.freeze({ error: 'unavailable' as const, reason: 'turned_off' as const, message: 'AI drafting is turned off.' });

/** The named Budget Durable Object instance (one per installation, design "Budget"). */
function budget(c: Context<ApiEnv>) {
  return c.env.BUDGET.getByName('budget');
}

/** The current AI_Drafting_Setting (On/Off) and AI_Input_Limit, from the settings table or their defaults. */
async function aiSettings(c: Context<ApiEnv>): Promise<{ readonly on: boolean; readonly inputLimit: number }> {
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    "SELECT key, value FROM settings WHERE key IN ('aiDrafting', 'aiInputLimit')").all<{ key: string; value: string }>());
  const saved = new Map(rows.results.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  return {
    on: (saved.get('aiDrafting') as boolean | undefined) ?? SETTINGS.aiDrafting.default,
    inputLimit: (saved.get('aiInputLimit') as number | undefined) ?? SETTINGS.aiInputLimit.default,
  };
}

/**
 * `GET /ai/status`: whether drafting is available now. It is available only while the AI_Drafting_Setting is On
 * AND the Budget's remaining Neurons cover one worst-case draft at the current AI_Input_Limit (R44.10, R44.11).
 * It reserves NOTHING — the headroom read is a read-only check (design "Neuron budget"). The reason names the
 * cause when unavailable: the setting is off, or drafting resumes at 00:00 UTC.
 */
export async function aiStatus(c: Context<ApiEnv>): Promise<{ readonly available: boolean; readonly reason?: 'turned_off' | 'resumes_at_utc_midnight' }> {
  const { on, inputLimit } = await aiSettings(c);
  if (!on) return { available: false, reason: 'turned_off' };
  const remaining = await budget(c).neuronsRemaining();
  const worstCase = worstCaseDraftNeurons(inputLimit);
  if (remaining < worstCase) return { available: false, reason: 'resumes_at_utc_midnight' };
  return { available: true };
}

/**
 * The request body: the field to draft, the Research_Item (or in-progress context) it concerns, and the
 * editor's unsaved text per field. `itemId` is the saved Research_Item; `editor` carries the text open in the
 * editor, which is preferred over the saved text where present (R44.1, R44.2).
 */
const draftBody = z.strictObject({
  field: z.enum(['logSummary', 'publicSummary', 'disclosureKind', 'disclosureNote']),
  itemId: z.string(),
  /** Per-field unsaved editor text keyed by a field name; each value is the open text or its RichText form. */
  editor: z.record(z.string(), z.union([z.string(), z.object({ text: z.string() }).loose()])).optional(),
});

/** The Permission a field's draft requires, over the target the loaded item provides (R44.13). */
function permissionFor(field: DraftField, item: LoadedItem): PermissionCheck {
  const { base } = item;
  if (field === 'logSummary') {
    return { permission: 'ai.draft.logSummary', target: { type: 'research_item', ownerId: base.ownerId, itemKind: base.kind } };
  }
  if (field === 'publicSummary') {
    return { permission: 'ai.draft.publicSummary', target: { type: 'research_item', ownerId: base.ownerId, itemKind: base.kind } };
  }
  return { permission: 'ai.draft.disclosureLine', target: { type: 'research_item', ownerId: base.ownerId, itemKind: base.kind } };
}

/** The editor's unsaved text for a field, as plain text; absent when the field is not open in the editor. */
function editorText(editor: z.infer<typeof draftBody>['editor']): EditorText {
  const text: Record<string, string> = {};
  for (const [key, value] of Object.entries(editor ?? {})) {
    text[key] = typeof value === 'string' ? value : (value as { text: string }).text;
  }
  return text;
}

/**
 * `POST /ai/drafts`: produce one AI_Draft. Checks the AI_Drafting_Setting, the field Permission, and Can_Read
 * (loadItem answers not_found when the Member cannot read, R47.4); assembles the input in Workspace display
 * order preferring the editor's unsaved text; cuts to the AI_Input_Limit and flags left-out text; sends nothing
 * for empty input; reserves the worst-case Neurons and refuses when none remain; calls an allow-listed model
 * with a fixed prompt, the field's max_tokens, and a 30-second deadline; settles with the reported usage; and
 * stores/logs neither the prompt nor the draft (R44.1–R44.3, R44.9–R44.13, R44.17, R44.18, R28.14).
 */
export async function requestDraft(c: Context<ApiEnv>, body: unknown): Promise<DraftResult> {
  const input = parse(draftBody, body);
  const field = input.field as DraftField;

  // While the AI_Drafting_Setting is Off, no text is sent and the request is refused (R44.11, R44.17).
  const { on, inputLimit } = await aiSettings(c);
  if (!on) throw new ApiError('unavailable', { details: DRAFTING_OFF });

  if (!isULID(input.itemId)) throw new ApiError('not_found');
  // loadItem enforces Can_Read: a Member who cannot read the Research_Item gets the shared not_found (R47.4).
  const item = await loadItem(c, input.itemId);
  await authorize(c, [permissionFor(field, item)]);

  // Assemble the input in Workspace display order, preferring the editor's unsaved text; never file contents.
  const attachments = await readAttachmentMeta(c, input.itemId);
  const assembled = assembleDraftInput(field, item, editorText(input.editor), attachments);
  if (isEmptyInput(assembled)) return EMPTY_INPUT;
  const cut = cutToInputLimit(assembled, inputLimit);
  if (isEmptyInput(cut.text)) return EMPTY_INPUT;

  // Reserve the worst-case Neurons before the call; refuse with the fixed notice when none remain (R44.10, R28.14).
  const reservationId = await budget(c).reserveNeurons(reservationNeurons(cut.text, field));
  if (reservationId === null) throw new ApiError('unavailable', { details: NEURONS_EXHAUSTED });

  try {
    const { text, neurons } = await callModel(c, field, cut.text);
    await budget(c).settleNeurons(reservationId, neurons);
    // Empty model output is "no AI_Draft was produced" (R44.12).
    if (isBlank(text)) return NO_DRAFT;
    // Shape the raw model output for the field before it reaches the editor (task 42.2, R44.7, R44.8, R44.14):
    // cut to the field's limit at a sentence/word boundary, remove Markdown headings, add no label, reduce a
    // Disclosure_Line to its kind and note, and flag whether the quotation-mark notice must be shown.
    return shapeForField(field, text, cut.truncated);
  } catch (error) {
    // Error, timeout, or any failure: release the reservation and show "no AI_Draft was produced" (R44.12).
    await budget(c).settleNeurons(reservationId, 0);
    // The prompt and the draft are never logged; only that a draft was not produced, with no content (R44.4).
    c.get('log')('info', 'ai_draft_failed', { field });
    void error;
    return NO_DRAFT;
  }
}

/** A shaped summary draft returned to the editor: the text, whether input was cut, the model, and the notice. */
export interface SummaryDraftResult {
  readonly draft: string;
  readonly truncatedInput: boolean;
  readonly model: string;
  readonly quotationNotice: boolean;
}

/** A shaped Disclosure_Line draft returned to the editor: only the kind and note, plus metadata (R44.2). */
export interface DisclosureDraftResult {
  readonly kind: string;
  readonly note: string;
  readonly truncatedInput: boolean;
  readonly model: string;
  readonly quotationNotice: boolean;
}

export type DraftResult =
  | typeof EMPTY_INPUT
  | typeof NO_DRAFT
  | SummaryDraftResult
  | DisclosureDraftResult;

/**
 * Shape the raw model output for the field (task 42.2). A Log_Summary or Public_Summary becomes a single draft
 * string; a Disclosure_Line field (kind or note) becomes { kind, note } with no other content (R44.2). Each
 * carries whether the INPUT was cut (R44.3) and the quotation-mark notice from the shaped text (R44.8).
 */
function shapeForField(field: DraftField, raw: string, truncatedInput: boolean): SummaryDraftResult | DisclosureDraftResult {
  if (isDisclosureField(field)) {
    const { kind, note, quotationNotice } = shapeDisclosureDraft(raw);
    return { kind, note, truncatedInput, model: AI_MODEL, quotationNotice };
  }
  // `field` is a summary field here (not a Disclosure_Line field); narrow for the summary-only shaper.
  const { draft, quotationNotice } = shapeSummaryDraft(field as Exclude<DraftField, 'disclosureKind' | 'disclosureNote'>, raw);
  return { draft, truncatedInput, model: AI_MODEL, quotationNotice };
}

/** The model's raw output and the Neurons it reported, from one call under the 30-second deadline. */
interface ModelOutput { readonly text: string; readonly neurons: number }

/**
 * Call an allow-listed Cloudflare-hosted model through the `AI` binding with the fixed system prompt, the cut
 * input, the field's max_tokens, and NO AI Gateway, logging, caching, or batch API (R44.9). A 30-second
 * deadline bounds the call; the primary model is tried first, then the configured fallback, both allow-listed
 * (design "Model"). Neither the prompt nor the output is stored or logged.
 */
async function callModel(c: Context<ApiEnv>, field: DraftField, promptInput: string): Promise<ModelOutput> {
  const messages = [
    { role: 'system' as const, content: systemPrompt(field) },
    { role: 'user' as const, content: promptInput },
  ];
  const options = { max_tokens: DRAFT_MAX_TOKENS[field] };
  // Defence in depth: never call a model that is not on the Cloudflare-hosted allow-list (R44.9).
  for (const model of [AI_MODEL, AI_FALLBACK_MODEL]) {
    if (!isAllowedModel(model)) continue;
    try {
      return await runWithDeadline(c, model, messages, options);
    } catch (error) {
      if (model === AI_FALLBACK_MODEL) throw error;
    }
  }
  throw new Error('No allow-listed model is configured.');
}

/**
 * One `AI.run` call raced against the 30-second deadline; a late answer loses the race and is discarded
 * (R44.12). The third `AiOptions` argument is omitted entirely, so NO AI Gateway is used and nothing is logged,
 * cached, or routed through another service (R44.9).
 */
async function runWithDeadline(
  c: Context<ApiEnv>, model: string, messages: readonly { role: string; content: string }[], options: { readonly max_tokens: number },
): Promise<ModelOutput> {
  // The model is an allow-listed string, chosen from a non-catalog union; call through a minimal typed surface
  // so the inputs are the chat shape and the output is a raw record (the generic `@cf/` run overload).
  const ai = c.env.AI as unknown as RunAi;
  const run = ai.run(model, { messages, max_tokens: options.max_tokens });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('AI draft timed out.')), AI_DEADLINE_MS);
  });
  try {
    const result = await Promise.race([run, deadline]);
    return readOutput(result);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The minimal `AI.run` surface this handler uses: one model string, chat inputs, and a raw record result. */
interface RunAi {
  run(model: string, inputs: { readonly messages: readonly { role: string; content: string }[]; readonly max_tokens: number }): Promise<unknown>;
}

/** The response text and the reported Neuron usage from a Workers AI chat result; absent usage settles as the hold. */
function readOutput(result: unknown): ModelOutput {
  const value = result as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
  const text = typeof value?.response === 'string' ? value.response : '';
  const usage = value?.usage;
  // Cloudflare reports token counts; convert to Neurons with the model's rates. Absent usage leaves the hold to
  // settle in full (settleNeurons clamps the actual to the reservation).
  const neurons = usage === undefined ? Number.POSITIVE_INFINITY : neuronsFromTokens(usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0);
  return { text, neurons };
}

/**
 * The metadata of every Attachment under the Research_Item the Member can read — title, caption, Origin — for
 * the draft input, NEVER file contents (R44.1). `visibleTo` enforces Can_Read on each Attachment's unit, so an
 * Attachment the Member cannot read contributes nothing (R47.4). Deleted Attachments are excluded.
 */
async function readAttachmentMeta(c: Context<ApiEnv>, itemId: ULID): Promise<AttachmentMeta[]> {
  const viewer = c.get('session').member.id;
  const rows = await c.get('accountant').track(c.env.RF_CORE.prepare(
    `SELECT a.title, a.caption, a.origin
      FROM units u JOIN attachments a ON a.unit_id = u.id
      WHERE u.parent_id = ?1 AND u.unit_type = 'attachment' AND ${visibleTo('u', '?2')}
        AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.unit_id = u.id)
      ORDER BY u.id`,
  ).bind(itemId, viewer).all<AttachmentMeta>());
  return rows.results;
}
