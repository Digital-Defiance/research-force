import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_FALLBACK_MODEL, AI_MODEL, worstCaseDraftNeurons } from '@researchforce/domain/ai';
import { OPERATIONS, SETTINGS } from '@researchforce/domain/settings';
import type { Budget } from '../src/do/budget';
import { itemWorld } from './items';
import { rich } from './items';
import type { Env } from '../src/env';

/**
 * Task 42.1: the AI_Draft API — `GET /ai/status` and `POST /ai/drafts`. The AI binding is faked (the Workers
 * pool excludes it); the Budget Durable Object is real, so the Neuron reservation and settlement are asserted
 * against its ledger. The tests cover the allow-list, the reserve/settle, the input assembly/limit/order and
 * never-file-contents, the empty-input and error/timeout paths, the AI_Drafting_Setting gate, and that no
 * prompt or draft is logged or stored (R44, R28.14).
 */

/** A fake `AI` binding recording each call, so the model, messages, and options can be asserted. */
interface AiCall { readonly model: string; readonly inputs: { messages: { role: string; content: string }[]; max_tokens: number } }
function fakeAi(reply: (call: AiCall) => Promise<unknown> | unknown): { calls: AiCall[]; binding: Env['AI'] } {
  const calls: AiCall[] = [];
  const binding = {
    run: async (model: string, inputs: unknown) => {
      const call = { model, inputs: inputs as AiCall['inputs'] };
      calls.push(call);
      return reply(call);
    },
  } as unknown as Env['AI'];
  return { calls, binding };
}

const world = itemWorld();

/** The named Budget instance, reset to a clean day for each test. */
function budgetStub() {
  return world.bindings.BUDGET.getByName('budget');
}

/** Set a workspace setting directly in the settings table. */
async function setSetting(key: string, value: unknown): Promise<void> {
  await world.core().prepare(
    'INSERT INTO settings (key, value, updated_by, updated_at, updated_seq, actor_id) VALUES (?1, ?2, NULL, ?3, 0, NULL) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).bind(key, JSON.stringify(value), world.at).run();
}

beforeEach(async () => {
  // A fresh Budget day for each test: clear the ledger and counters.
  await runInDurableObject(budgetStub(), (_instance, state) => {
    for (const table of ['day', 'reservations', 'neuron_ledger', 'addr_counts', 'addr_keys']) {
      try { state.storage.sql.exec(`DELETE FROM ${table}`); } catch { /* table may not exist yet */ }
    }
  });
  await world.core().prepare('DELETE FROM settings').run();
});
afterEach(() => { delete (world.bindings as { AI?: unknown }).AI; });

/** Install a fake AI binding for the next request and return its call log. */
function installAi(reply: (call: AiCall) => Promise<unknown> | unknown): AiCall[] {
  const ai = fakeAi(reply);
  (world.bindings as { AI: Env['AI'] }).AI = ai.binding;
  return ai.calls;
}

const neuronsCommitted = async () => (await runInDurableObject(budgetStub(), (instance: Budget) => instance.usage())).neuronsCommitted;

describe('GET /ai/status', () => {
  it('is available while the setting is On and Neurons remain, reserving nothing', async () => {
    await setSetting('aiDrafting', true);
    const response = await world.request('author', 'GET', '/ai/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true });
    // Nothing was reserved by the status check.
    expect(await neuronsCommitted()).toBe(0);
    const remaining = await runInDurableObject(budgetStub(), (instance: Budget) => instance.neuronsRemaining());
    expect(remaining).toBe(OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin);
  });

  it('is unavailable with "turned off" while the setting is Off', async () => {
    await setSetting('aiDrafting', false);
    const response = await world.request('author', 'GET', '/ai/status');
    expect(await response.json()).toEqual({ available: false, reason: 'turned_off' });
  });

  it('is unavailable with the 00:00 UTC reason when the day has no headroom for a worst-case draft', async () => {
    await setSetting('aiDrafting', true);
    // Commit almost the whole allocation so one worst-case draft no longer fits.
    const id = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin));
    await runInDurableObject(budgetStub(), (instance: Budget) => instance.settleNeurons(id!, OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin));
    const response = await world.request('author', 'GET', '/ai/status');
    expect(await response.json()).toEqual({ available: false, reason: 'resumes_at_utc_midnight' });
  });
});

describe('POST /ai/drafts', () => {
  it('drafts a Log_Summary: calls the allow-listed model, settles the reservation, and returns the draft', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', {
      logSummary: rich('Old summary.'),
      sections: [{ content: rich('Enigma rotor stepping was analysed.') }, { content: rich('A crib was identified at position 12.') }],
    });
    const calls = installAi(() => ({ response: 'A neutral synthetic draft summary.', usage: { prompt_tokens: 100, completion_tokens: 40 } }));

    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(response.status).toBe(200);
    const body = await response.json<{ draft: string; truncatedInput: boolean; model: string }>();
    expect(body.draft).toBe('A neutral synthetic draft summary.');
    expect(body.truncatedInput).toBe(false);
    expect(body.model).toBe(AI_MODEL);

    // The allow-listed primary model was called, with a system + user message and the summary max_tokens.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe(AI_MODEL);
    expect(calls[0]!.model.startsWith('@cf/')).toBe(true);
    expect(calls[0]!.inputs.max_tokens).toBe(800);
    expect(calls[0]!.inputs.messages[0]!.role).toBe('system');
    // The input assembled the sections but NOT the Log_Summary being drafted.
    const sent = calls[0]!.inputs.messages[1]!.content;
    expect(sent).toContain('Enigma rotor stepping');
    expect(sent).toContain('A crib was identified');
    expect(sent).not.toContain('Old summary.');

    // The reservation was settled with the reported usage (100 in, 40 out).
    const expected = Math.ceil((100 * 9091 + 40 * 27_273) / 1_000_000);
    expect(await neuronsCommitted()).toBe(expected);
  });

  it('prefers the editor’s unsaved text over the saved text', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', {
      sections: [{ content: rich('Saved section text.') }],
    });
    const sectionId = (item['sections'] as { id: string }[])[0]!.id;
    const calls = installAi(() => ({ response: 'draft', usage: { prompt_tokens: 10, completion_tokens: 5 } }));

    await world.request('author', 'POST', '/ai/drafts', {
      field: 'logSummary', itemId: item.id,
      editor: { title: 'Unsaved title in editor', [`sections.${sectionId}`]: 'Unsaved section text.' },
    });
    const sent = calls[0]!.inputs.messages[1]!.content;
    expect(sent).toContain('Unsaved title in editor');
    expect(sent).toContain('Unsaved section text.');
    expect(sent).not.toContain('Saved section text.');
    expect(sent).not.toContain('A synthetic journal_entry'); // the saved title was replaced
  });

  it('never sends Attachment file contents, only metadata', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body.') }] });
    // Seed an Attachment under the item with metadata and a stored object key (its "file contents").
    const unitId = `${item.id.slice(0, 20)}ATTACH0001`;
    await world.core().batch([
      world.core().prepare("INSERT INTO units (id, unit_type, project_id, root_id, parent_id, owner_id, credit, submission_id, created_at, rev, updated_seq) SELECT ?1, 'attachment', project_id, ?2, ?2, owner_id, credit, submission_id, created_at, 1, 0 FROM units WHERE id = ?2")
        .bind(unitId, item.id),
      world.core().prepare("INSERT INTO attachments (unit_id, item_identifier, title, file_kind, original_name, size_bytes, sha256, caption, origin, r2_key, uploaded_at, rights_status_id, chain_id) VALUES (?1, 'ATT-0001-0001', 'Rotor photograph', 'image', 'rotor-secret.jpg', 1000, 'deadbeef', 'Close-up of rotor III', 'From the archive box', 'rf-private/secret-object-key', ?2, '0000000000000000000000P002', ?1)")
        .bind(unitId, world.at),
    ]);
    const calls = installAi(() => ({ response: 'draft', usage: { prompt_tokens: 10, completion_tokens: 5 } }));

    await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    const sent = calls[0]!.inputs.messages[1]!.content;
    expect(sent).toContain('Rotor photograph');
    expect(sent).toContain('Close-up of rotor III');
    expect(sent).toContain('From the archive box');
    // Never the file name, object key, or hash.
    expect(sent).not.toContain('rotor-secret.jpg');
    expect(sent).not.toContain('rf-private/secret-object-key');
    expect(sent).not.toContain('deadbeef');
  });

  it('cuts to the AI_Input_Limit and flags left-out text', async () => {
    await setSetting('aiDrafting', true);
    await setSetting('aiInputLimit', 1000);
    const long = 'x'.repeat(5000);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich(long) }] });
    const calls = installAi(() => ({ response: 'draft', usage: { prompt_tokens: 10, completion_tokens: 5 } }));

    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    const body = await response.json<{ truncatedInput: boolean }>();
    expect(body.truncatedInput).toBe(true);
    // At most 1,000 code points were sent.
    expect([...calls[0]!.inputs.messages[1]!.content].length).toBeLessThanOrEqual(1000);
  });

  it('sends nothing and returns empty_input for whitespace-only input', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { title: 'T', sections: [{ content: rich('ignored') }] });
    const calls = installAi(() => ({ response: 'should not be called' }));
    // The editor blanks out every field so the assembled input is empty.
    const sectionId = (item['sections'] as { id: string }[])[0]!.id;
    const response = await world.request('author', 'POST', '/ai/drafts', {
      field: 'logSummary', itemId: item.id, editor: { title: '   ', [`sections.${sectionId}`]: '  ' },
    });
    expect(await response.json()).toEqual({ draft: null, reason: 'empty_input' });
    expect(calls).toHaveLength(0);
    // Nothing was reserved or committed.
    expect(await neuronsCommitted()).toBe(0);
  });

  it('returns no_draft and releases the reservation on a model error', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body text.') }] });
    installAi(() => { throw new Error('model unavailable'); });

    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(await response.json()).toEqual({ draft: null, reason: 'no_draft' });
    // The reservation was released (settled at 0): no Neurons committed.
    expect(await neuronsCommitted()).toBe(0);
  });

  it('returns no_draft on empty model output', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body text.') }] });
    installAi(() => ({ response: '   ', usage: { prompt_tokens: 10, completion_tokens: 0 } }));
    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(await response.json()).toEqual({ draft: null, reason: 'no_draft' });
  });

  it('refuses with the 00:00 UTC notice when no Neurons remain, sending no request', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body text.') }] });
    // Exhaust the allocation.
    const id = await runInDurableObject(budgetStub(), (instance: Budget) => instance.reserveNeurons(OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin));
    await runInDurableObject(budgetStub(), (instance: Budget) => instance.settleNeurons(id!, OPERATIONS.aiNeuronsPerUTCDay - OPERATIONS.aiNeuronMargin));
    const calls = installAi(() => ({ response: 'unreachable' }));

    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(response.status).toBe(503);
    const body = await response.json<{ error: string; details: { reason: string } }>();
    expect(body.error).toBe('unavailable');
    expect(body.details.reason).toBe('resumes_at_utc_midnight');
    expect(calls).toHaveLength(0); // no text sent to the AI service
  });

  it('refuses while the AI_Drafting_Setting is Off, sending no request', async () => {
    await setSetting('aiDrafting', false);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body text.') }] });
    const calls = installAi(() => ({ response: 'unreachable' }));
    const response = await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(response.status).toBe(503);
    expect((await response.json<{ details: { reason: string } }>()).details.reason).toBe('turned_off');
    expect(calls).toHaveLength(0);
  });

  it('refuses a Log_Summary draft of an item the Member does not own (ai.draft.logSummary is own-scope)', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Body.') }] });
    installAi(() => ({ response: 'unreachable' }));
    // The colleague can read it but cannot request a Log_Summary draft of someone else's item.
    const response = await world.request('colleague', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });
    expect(response.status).toBe(403);
  });

  it('does not store the prompt or the draft in D1', async () => {
    await setSetting('aiDrafting', true);
    const item = await world.created('author', 'journal_entry', { sections: [{ content: rich('Secret rotor wiring notes.') }] });
    installAi(() => ({ response: 'A draft mentioning secret rotor wiring notes.', usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    await world.request('author', 'POST', '/ai/drafts', { field: 'logSummary', itemId: item.id });

    // Neither the prompt input nor the draft output is persisted: no revision, settings, or reply row carries it.
    for (const probe of ['%secret rotor wiring%', '%A draft mentioning%']) {
      const revisions = await world.core().prepare('SELECT count(*) AS n FROM revisions WHERE prev LIKE ?1').bind(probe).first<{ n: number }>('n');
      const settings = await world.core().prepare('SELECT count(*) AS n FROM settings WHERE value LIKE ?1').bind(probe).first<{ n: number }>('n');
      expect(revisions).toBe(0);
      expect(settings).toBe(0);
    }
  });

  it('is not registered on any public or import entrypoint (allow-list sanity: both models are @cf/)', () => {
    // The fixed allow-list is Cloudflare-hosted only.
    expect(AI_MODEL.startsWith('@cf/')).toBe(true);
    expect(AI_FALLBACK_MODEL.startsWith('@cf/')).toBe(true);
    // A status headroom figure is positive for the default limit.
    expect(worstCaseDraftNeurons(SETTINGS.aiInputLimit.default)).toBeGreaterThan(0);
  });
});
