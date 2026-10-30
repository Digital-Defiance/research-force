import { describe, expect, it } from 'vitest';
import { drainSearch } from '../src/search/indexer';
import { errorOf, itemWorld, rich } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

const world = itemWorld();
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const count = async (sql: string, ...values: unknown[]) => (await world.core().prepare(sql).bind(...values).first<number>('n'))!;
const hash = (digit: string) => digit.repeat(64);
/** A file on a record, with a content hash of its own so a derivation can tell it from the original. */
const file = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit;
};
interface Made { id: string; reviewState: string; correctedBy: string | null; correctsId: string | null; graphEpoch: number; reviews: { reviewerId: string; state: string; passages: { start: number; end: number }[] }[]; inputs: { unitId: string }[]; text: string | null }
const record = (who: Who, body: Record<string, unknown>) => world.request(who, 'POST', '/derivations', body);
const made = async (response: Response): Promise<Made> => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ derivation: Made }>()).derivation;
};
const attachment = (unitId: string) => ({ type: 'attachment', unitId });
const text = (unitId: string, field: string) => ({ type: 'text', unitId, field });
const base = { kind: 'transcription', method: 'Hand transcription' };

describe('artifact derivations (R55.1 to R55.4)', () => {
  it('records how an output was made from its inputs, with method, language and uncertainty, and keeps the originals', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('a'));
    const transcript = await file(finding, hash('b'));
    const derivation = await made(await record('author', { ...base, output: attachment(transcript.id), inputs: [attachment(scan.id)], methodVersion: '2', language: 'de-AT', uncertainty: 'The third line is faded.', text: 'Der Brief vom 3. Mai' }));
    expect(derivation).toMatchObject({ reviewState: 'unreviewed', correctedBy: null, text: 'Der Brief vom 3. Mai', method: 'Hand transcription', language: 'de-AT', uncertainty: 'The third line is faded.' });
    expect(derivation.inputs.map((input) => input.unitId)).toEqual([scan.id]);
    expect(await count("SELECT count(*) AS n FROM attachments WHERE unit_id = ?1 AND sha256 = ?2", scan.id, hash('a'))).toBe(1);
    const read = await made(await world.request('colleague', 'GET', `/derivations/${derivation.id}`));
    expect(read.id).toBe(derivation.id);
    const listed = await world.request('colleague', 'GET', `/derivations?outputUnitId=${transcript.id}`);
    expect((await listed.json<{ derivations: Made[] }>()).derivations.map((entry) => entry.id)).toEqual([derivation.id]);
    const fromInput = await world.request('colleague', 'GET', `/derivations?inputUnitId=${scan.id}`);
    expect((await fromInput.json<{ derivations: Made[] }>()).derivations.map((entry) => entry.id)).toEqual([derivation.id]);
    expect((await world.request('colleague', 'GET', '/derivations')).status).toBe(422);
  });

  it('derives a text field from a text field, and refuses text for a text output', async () => {
    const topic = await world.created('author', 'topic', { body: rich('Tiles repeat in rows.') });
    const finding = await world.created('author', 'finding', { claim: rich('Rows of tiles') });
    const body = { ...base, kind: 'extraction', output: text(finding.id as string, 'claim'), inputs: [text(topic.id as string, 'body')] };
    const error = await errorOf(await record('author', { ...body, text: 'x' }));
    expect(error.fields?.map((entry) => entry.field)).toContain('text');
    expect((await made(await record('author', body))).inputs).toHaveLength(1);
  });

  it('refuses an unchanged original, a self-derivation, a cycle and a changed endpoint', async () => {
    const finding = await world.created('author', 'finding');
    const one = await file(finding, hash('c'));
    const two = await file(finding, hash('d'));
    const same = await file(finding, hash('c'));
    expect((await errorOf(await record('author', { ...base, output: attachment(same.id), inputs: [attachment(one.id)] }))).fields?.[0]?.field).toBe('output');
    expect((await errorOf(await record('author', { ...base, output: attachment(one.id), inputs: [attachment(one.id)] }))).status).toBe(422);
    await made(await record('author', { ...base, output: attachment(two.id), inputs: [attachment(one.id)] }));
    const cycle = await errorOf(await record('author', { ...base, output: attachment(one.id), inputs: [attachment(two.id)] }));
    expect(cycle.status).toBe(422);
    expect(cycle.fields?.[0]?.field).toBe('inputs');
    const stale = await errorOf(await record('author', { ...base, output: attachment(await file(finding, hash('e')).then((unit) => unit.id)), inputs: [attachment(one.id)], expectedHashes: { inputs: [hash('f')] } }));
    expect(stale.fields?.[0]?.field).toBe('inputs.0');
  });

  it('bounds inputs at 100 and uncertainty at 2,000 characters', async () => {
    const finding = await world.created('author', 'finding');
    const output = await file(finding, hash('1'));
    const inputs = [];
    for (let index = 0; index < 100; index += 1) inputs.push(attachment((await file(finding, (index + 2).toString(16).padStart(64, '0'))).id));
    expect((await record('author', { ...base, output: attachment(output.id), inputs: [...inputs, attachment(output.id)] })).status).toBe(422);
    expect((await record('author', { ...base, output: attachment(output.id), inputs, uncertainty: 'x'.repeat(2001) })).status).toBe(422);
    const ok = await made(await record('author', { ...base, output: attachment(output.id), inputs, uncertainty: 'x'.repeat(2000) }));
    expect(ok.inputs).toHaveLength(100);
  });

  it('needs edit rights on the output and read rights on every input', async () => {
    const mine = await world.created('author', 'finding');
    const hidden = await world.created('colleague', 'finding', { access: { level: 'restricted', members: [] } });
    const open = await file(mine, hash('2'));
    const out = await file(mine, hash('3'));
    const secret = await file(hidden, hash('4'));
    expect((await record('colleague', { ...base, output: attachment(out.id), inputs: [attachment(open.id)] })).status).toBe(403);
    const refused = await errorOf(await record('author', { ...base, output: attachment(out.id), inputs: [attachment(secret.id)] }));
    expect(refused.fields?.[0]?.field).toBe('inputs.0.unitId');
    expect(await count('SELECT count(*) AS n FROM artifact_derivations WHERE output_unit_id = ?1', out.id)).toBe(0);
  });

  it('corrects with a new output and keeps the earlier derivation and its method', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('6'));
    const first = await file(finding, hash('7'));
    const second = await file(finding, hash('8'));
    const earlier = await made(await record('author', { ...base, output: attachment(first.id), inputs: [attachment(scan.id)], method: 'OCR run A', kind: 'ocr' }));
    const sameOutput = await errorOf(await record('author', { ...base, kind: 'ocr', output: attachment(first.id), inputs: [attachment(scan.id)], correctionOf: earlier.id }));
    expect(sameOutput.status).toBe(422);
    const later = await made(await record('author', { ...base, kind: 'ocr', method: 'OCR run B', output: attachment(second.id), inputs: [attachment(scan.id)], correctionOf: earlier.id }));
    expect(later.correctsId).toBe(earlier.id);
    const history = await world.request('author', 'GET', `/derivations?outputUnitId=${first.id}`);
    expect((await history.json<{ derivations: Made[] }>()).derivations[0]).toMatchObject({ id: earlier.id, correctedBy: later.id, method: 'OCR run A' });
    const again = await errorOf(await record('author', { ...base, kind: 'ocr', output: attachment(await file(finding, hash('9')).then((unit) => unit.id)), inputs: [attachment(scan.id)], correctionOf: earlier.id }));
    expect(again.status).toBe(409);
    expect(later.graphEpoch).toBeGreaterThan(earlier.graphEpoch);
  });

  it('lets a Member other than the creator review, with passages inside the text, and the creator not', async () => {
    const finding = await world.created('author', 'finding');
    const scan = await file(finding, hash('a'));
    const out = await file(finding, hash('b'));
    const derivation = await made(await record('author', { ...base, output: attachment(out.id), inputs: [attachment(scan.id)], text: 'a😀b is read' }));
    expect((await world.request('author', 'POST', `/derivations/${derivation.id}/review`, { state: 'reviewed' })).status).not.toBe(200);
    expect((await made(await world.request('author', 'GET', `/derivations/${derivation.id}`))).reviewState).toBe('unreviewed');
    const split = await errorOf(await world.request('colleague', 'POST', `/derivations/${derivation.id}/review`, { state: 'disputed', passages: [{ start: 2, end: 3 }] }));
    expect(split.status).toBe(422);
    const outside = await errorOf(await world.request('colleague', 'POST', `/derivations/${derivation.id}/review`, { state: 'disputed', passages: [{ start: 0, end: 500 }] }));
    expect(outside.status).toBe(422);
    const disputed = await made(await world.request('colleague', 'POST', `/derivations/${derivation.id}/review`, { state: 'disputed', note: 'Misread', passages: [{ start: 1, end: 3, note: 'emoji' }] }));
    expect(disputed.reviewState).toBe('disputed');
    expect(disputed.reviews[0]!.passages).toMatchObject([{ start: 1, end: 3 }]);
    const reviewed = await made(await world.request('colleague', 'POST', `/derivations/${derivation.id}/review`, { state: 'reviewed' }));
    expect(reviewed.reviewState).toBe('reviewed');
    expect(reviewed.reviews[0]!.passages).toEqual([]);
  });

  it('never follows a provenance edge through a record the Member cannot read', async () => {
    const open = await world.created('author', 'finding');
    const hidden = await world.created('author', 'finding', { access: { level: 'restricted', members: [] } });
    const a = await file(open, hash('c'));
    const b = await file(hidden, hash('d'));
    const c = await file(open, hash('e'));
    await made(await record('author', { ...base, output: attachment(b.id), inputs: [attachment(a.id)] }));
    await made(await record('author', { ...base, output: attachment(c.id), inputs: [attachment(b.id)] }));
    const walk = async (who: Who, direction: string) => (await (await world.request(who, 'GET', `/derivations/provenance/${c.id}?direction=${direction}`)).json<{ nodes: { unitId: string }[]; edges: unknown[] }>());
    expect((await walk('author', 'sources')).nodes.map((node) => node.unitId).sort()).toEqual([a.id, b.id, c.id].sort());
    const seen = await walk('colleague', 'sources');
    expect(seen.nodes.map((node) => node.unitId)).not.toContain(b.id);
    expect(seen.edges).toEqual([]);
    expect((await world.request('author', 'GET', `/derivations/provenance/${a.id}?direction=derivatives`)).status).toBe(200);
  });

  it('makes derived text searchable only to those who can read the record', async () => {
    const finding = await world.created('author', 'finding', { title: 'Letter file' });
    const scan = await file(finding, hash('1'));
    const out = await file(finding, hash('2'));
    await made(await record('author', { ...base, output: attachment(out.id), inputs: [attachment(scan.id)], text: 'zebrafinch ledger' }));
    await drainSearch({ core: world.core(), search: world.bindings.RF_SEARCH }, world.at);
    const hits = async (who: Who) => (await (await world.request(who, 'GET', '/search?q=zebrafinch')).json<{ results?: unknown[]; hits?: unknown[] }>());
    const found = await hits('author');
    expect((found.results ?? found.hits ?? []).length).toBeGreaterThan(0);
  });

  it('keeps an input edge, marked gone, once its input is gone', async () => {
    const finding = await world.created('author', 'finding');
    const gone = await file(finding, hash('3'));
    const out = await file(finding, hash('4'));
    const derivation = await made(await record('author', { ...base, output: attachment(out.id), inputs: [attachment(gone.id)] }));
    await world.core().prepare('UPDATE artifact_derivation_inputs SET gone_at = ?2 WHERE input_unit_id = ?1').bind(gone.id, world.at).run();
    expect(await count('SELECT count(*) AS n FROM artifact_derivation_inputs WHERE derivation_id = ?1 AND input_unit_id = ?2', derivation.id, gone.id)).toBe(1);
  });
});
