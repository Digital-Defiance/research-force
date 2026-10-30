import { describe, expect, it } from 'vitest';
import { comparableDerivations, parseDerivationExport } from '@researchforce/domain/derivation-export';
import type { DerivationExport } from '@researchforce/domain/derivation-export';
import { itemWorld } from './items';
import type { ItemView, Who } from './items';
import { addElement, addSubmissionRow } from './units';

const world = itemWorld();
const place = async () => ({ projectId: world.projectId, ownerId: world.ids.author, submissionId: await addSubmissionRow(world.core(), world.ids.author, world.at), now: world.at });
const file = async (root: ItemView, sha: string) => {
  const unit = await addElement(world.core(), await place(), 'attachment', root.id as never);
  await world.core().prepare('UPDATE attachments SET sha256 = ?2 WHERE unit_id = ?1').bind(unit.id, sha).run();
  return unit;
};
const ok = async (response: Response) => {
  if (response.status !== 201 && response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return response;
};
const record = async (who: Who, body: Record<string, unknown>) => (await (await ok(await world.request(who, 'POST', '/derivations', body))).json<{ derivation: { id: string } }>()).derivation;
const attachment = (unitId: string) => ({ type: 'attachment', unitId });
const exported = async (who: Who, rootId: string): Promise<DerivationExport> => parseDerivationExport(await (await ok(await world.request(who, 'GET', `/derivations/export?rootId=${rootId}`))).json());
const hash = (digit: string) => digit.repeat(64);

describe('manuscript walkthrough and interchange (R55.3 to R55.5)', () => {
  it('follows a scan to its transcription, translation and corrected transcription, and round-trips the graph, text and reviews exactly', async () => {
    const letter = await world.created('author', 'finding', { title: 'A letter' });
    const scan = await file(letter, hash('a'));
    const transcript = await file(letter, hash('b'));
    const translation = await file(letter, hash('c'));
    const corrected = await file(letter, hash('d'));
    const first = await record('author', { kind: 'transcription', method: 'Hand transcription', output: attachment(transcript.id), inputs: [attachment(scan.id)], language: 'de', text: 'Lieber Karl, ich sende dir 😀 den Brief', uncertainty: 'The name is faded.' });
    await record('author', { kind: 'translation', method: 'Hand translation', output: attachment(translation.id), inputs: [attachment(transcript.id)], language: 'en', text: 'Dear Karl, I am sending you the letter' });
    await world.request('colleague', 'POST', `/derivations/${first.id}/review`, { state: 'disputed', note: 'Name misread', passages: [{ start: 7, end: 11, note: 'Karl or Carl' }] });
    const fixed = await record('author', { kind: 'transcription', method: 'Hand transcription, second pass', output: attachment(corrected.id), inputs: [attachment(scan.id)], correctionOf: first.id, language: 'de', text: 'Lieber Carl, ich sende dir 😀 den Brief' });

    const walk = await (await ok(await world.request('colleague', 'GET', `/derivations/provenance/${translation.id}?direction=sources`))).json<{ nodes: { unitId: string }[] }>();
    expect(walk.nodes.map((node) => node.unitId).sort()).toEqual([scan.id, transcript.id, translation.id].sort());
    const used = await (await ok(await world.request('colleague', 'GET', `/derivations?inputRootId=${letter.id as string}`))).json<{ derivations: { id: string }[] }>();
    expect(used.derivations.map((entry) => entry.id)).not.toContain(first.id);

    const document = await exported('colleague', letter.id as string);
    expect(document.derivations.map((entry) => entry.id).sort()).toContain(fixed.id);
    const original = document.derivations.find((entry) => entry.id === first.id)!;
    expect(original).toMatchObject({ method: 'Hand transcription', correctedBy: fixed.id, uncertainty: 'The name is faded.', text: 'Lieber Karl, ich sende dir 😀 den Brief', reviewState: 'disputed' });
    expect(original.output.sha256).toBe(hash('b'));
    expect(original.inputs.map((input) => input.sha256)).toEqual([hash('a')]);
    expect(original.reviews[0]).toMatchObject({ state: 'disputed', passages: [{ start: 7, end: 11, note: 'Karl or Carl' }] });
    // The flagged range still selects the same words after the export is read back.
    const reread = parseDerivationExport(JSON.parse(JSON.stringify(document)));
    expect(comparableDerivations(reread)).toEqual(comparableDerivations(document));
    const flagged = reread.derivations.find((entry) => entry.id === first.id)!;
    expect(flagged.text!.slice(flagged.reviews[0]!.passages[0]!.start, flagged.reviews[0]!.passages[0]!.end)).toBe('Karl');
  });

  it('leaves a derivation out of an export when an end is unreadable, and refuses a stray field', async () => {
    const open = await world.created('author', 'finding');
    const hidden = await world.created('colleague', 'finding', { access: { level: 'restricted', members: [] } });
    const from = await file(open, hash('e'));
    const secret = await file(hidden, hash('f'));
    const out = await file(open, hash('1'));
    await record('author', { kind: 'extraction', method: 'By hand', output: attachment(out.id), inputs: [attachment(from.id)] });
    const bad = await file(open, hash('2'));
    const document = await exported('author', open.id as string);
    expect(document.derivations).toHaveLength(1);
    expect(secret.id).not.toBe(bad.id);
    expect(JSON.stringify(document)).not.toContain(secret.id);
    expect(() => parseDerivationExport({ ...document, extra: true })).toThrow();
    expect(() => parseDerivationExport({ ...document, version: 2 })).toThrow();
    expect((await world.request('author', 'GET', '/derivations/export')).status).toBe(422);
  });
});
