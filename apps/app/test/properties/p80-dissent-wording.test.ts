// Feature: research-collab-cms, Property 80: Dissent_Notes stay attached to the wording they concern
import { describe, expect, it } from 'vitest';
import type { RichText, Span } from '@researchforce/domain/richtext';
import type { ULID } from '@researchforce/domain/types';
import { fc, FC_RUNS } from '@researchforce/testing/fc';
import { buildDissentDisplay, nonWithdrawnNotes } from '../../src/dissent/display';
import type { DissentRow } from '../../src/dissent/display';
import { itemWorld, rich } from '../items';
import type { ItemView } from '../items';
import { addProject, resetRecords } from '../units';

/**
 * Property 80: Dissent_Notes stay attached to the wording they concern.
 *
 * **Validates: Requirements 42.1, 42.2, 42.3, 42.8, 42.9, 42.14**
 *
 * A Dissent_Note records, at attach time and on every later save of its text, a SNAPSHOT of the Log_Summary it concerns
 * — the Log_Summary's text AND its labels as they stood then — and it stays attached to that wording even after the
 * Owner reworks the Log_Summary. While the current Log_Summary differs from the note's snapshot (in text OR in labels),
 * every surface that shows the note marks it as written about an earlier wording, with a word comparison; when the
 * current Log_Summary still equals the snapshot, no such mark is shown. The six criteria this property proves, read
 * character-for-character against requirements.md:
 *
 *  - R42.1 — WHEN an active Member OTHER THAN a Research_Item's Owner attaches a Dissent_Note to the Research_Item's
 *            Log_Summary, including the Log_Summary of a withdrawn Research_Item, the Records_Service records the note's
 *            text, the Member as its author, the time of attachment, and the Log_Summary's text and labels AS THEY
 *            STAND at that time, with the Research_Item as the note's Parent and the Disclosure_Level Not_Published.
 *  - R42.2 — IF a Member attempts to attach a note to the Log_Summary of a Research_Item THE MEMBER OWNS, to an Item
 *            with no Log_Summary, to a Log_Summary on which the Member ALREADY HAS a non-withdrawn note, or with empty/
 *            whitespace/over-2,000-character text, the Records_Service rejects the attempt and stores nothing. (This
 *            property drives the own-Item refusal and the already-has-a-note refusal; the no-Log_Summary and length
 *            refusals are the dissent example suite's.)
 *  - R42.3 — the Research_CMS shows each non-withdrawn note wherever it shows the current Log_Summary, with its text,
 *            the author's display name, and the last-saved time — asserted here through the item page's `dissent`
 *            display and the shared `nonWithdrawnNotes` builder the Project_Log and previews reuse.
 *  - R42.8 — WHEN the author withdraws a note, the Research_CMS KEEPS the note and its Revisions (its text and snapshot
 *            stay) and frees the one-note slot, so the same Member may dissent the same Log_Summary again.
 *  - R42.9 — WHILE the text OR labels of the Log_Summary a note concerns differ from the text and labels recorded with
 *            the author's LAST SAVE of the note's text, the Research_CMS marks the note (wherever R42.3 shows it) as
 *            written about an earlier wording, with a link to a word comparison of the recorded and current wording.
 *  - R42.14 — WHERE a Public Research_Item is Full_Content, the Public_Site shows each non-withdrawn note after the
 *            Log_Summary with, while R42.9 applies, the earlier-wording mark (without the comparison). The earlier-
 *            wording decision is the same `differs(snapshot, current)` R42.9 drives, so this property proves the shared
 *            rule that both the Members' display (R42.9) and the Public_Site (R42.14) read.
 *
 * Also asserted: on `editDissent` saving new text the note takes a NEW snapshot of the then-current Log_Summary, so an
 * edit after the Owner reworked the summary re-attaches the note to the new wording and drops the earlier-wording mark
 * (R42.7, the save-time half of R42.1/R42.9).
 *
 * Chosen layers. Two, both in this file. (1) A D1-backed Workers-pool property drives the REAL attach/edit/withdraw
 * handlers against rf-core D1 and reads the note's stored snapshot columns and the item page's real `dissent` display,
 * so the snapshot, its stability under Owner edits, the one-note guard, the own-Item refusal, the withdrawal, and the
 * earlier-wording mark are all proved through the real handlers and the real display read. (2) A PURE sub-property over
 * `buildDissentDisplay` / `nonWithdrawnNotes` (the shared builder in `apps/app/src/dissent/display.ts`, where the
 * earlier-wording decision and comparison live) proves, across randomized snapshot/current pairs, that the mark is set
 * exactly when the snapshot differs from the current wording in text OR labels, and the comparison is present then and
 * only then. The pure half lives here because its helper is in the app's dissent module, not the domain package.
 *
 * p88 PATTERN: every D1 fast-check run FIRST resets the seeded records (the named D1 is shared across runs in the
 * Workers pool). p78 CAP: the D1 property runs { numRuns: Math.min(FC_RUNS, 40) }; the pure sub-property runs full FC_RUNS.
 */

const world = itemWorld();

/** A short synthetic Quote/Paraphrase/language label over the first word of a text, for a labelled Log_Summary. */
function labelArb(textLen: number): fc.Arbitrary<Span> {
  const end = Math.min(Math.max(1, Math.floor(textLen / 2)), textLen);
  return fc.oneof(
    fc.constant<Span>({ k: 'quote', s: 0, e: end, source: 'A synthetic source' }),
    fc.constant<Span>({ k: 'paraphrase', s: 0, e: end, source: 'A synthetic source' }),
    fc.constant<Span>({ k: 'lang', s: 0, e: end, lang: 'de' }),
  );
}

/** A Log_Summary wording: a non-blank text of plain ASCII words and an optional label over its first half. */
const summaryArb: fc.Arbitrary<RichText> = fc
  .tuple(
    fc.array(fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'result', 'tiles', 'signal', 'caveat'), { minLength: 2, maxLength: 6 }),
    fc.boolean(),
  )
  .chain(([words, labelled]) => {
    const text = words.join(' ');
    return labelled ? labelArb(text.length).map((span) => ({ text, spans: [span] })) : fc.constant<RichText>({ text, spans: [] });
  });

/** How the Owner reworks the Log_Summary after the note is attached: not at all, a text rewrite, or a label-only change. */
type Rework = { readonly kind: 'none' } | { readonly kind: 'text' } | { readonly kind: 'label' };
const reworkArb: fc.Arbitrary<Rework> = fc.oneof(
  fc.constant<Rework>({ kind: 'none' }),
  fc.constant<Rework>({ kind: 'text' }),
  fc.constant<Rework>({ kind: 'label' }),
);

/** The note's stored row, with its unit's disclosure, parent, author, snapshot, and withdrawal. */
const storedNote = (id: string) => world.core().prepare(`SELECT dn.text, dn.text_spans AS textSpans, dn.author_id AS authorId, dn.attached_at AS attachedAt,
  dn.last_saved_at AS lastSavedAt, dn.concerned_summary AS concernedSummary, dn.concerned_summary_spans AS concernedSummarySpans,
  u.disclosure_level AS level, u.unit_type AS type, u.root_id AS rootId, u.parent_id AS parentId, u.withdrawn_at AS withdrawnAt
  FROM units u JOIN dissent_notes dn ON dn.unit_id = u.id WHERE u.id = ?1`).bind(id)
  .first<{ text: string; textSpans: string; authorId: ULID; attachedAt: string; lastSavedAt: string; concernedSummary: string; concernedSummarySpans: string; level: string; type: string; rootId: string; parentId: string; withdrawnAt: string | null }>();

const itemRev = (id: string) => world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<number>('rev');

/** The item page's `dissent` display, the real read every Member surface uses (R42.3). */
async function itemDissent(who: 'author' | 'colleague' | 'admin', id: string): Promise<{ notes: { id: string; author: { id: string; displayName: string | null }; text: RichText; aboutEarlierWording: boolean; comparison?: { concernedSummary: RichText; currentSummary: RichText | null; words: unknown[] } }[]; withdrawn: { id: string; withdrawalReason: string | null }[] }> {
  const response = await world.request(who, 'GET', `/items/${id}`);
  if (response.status !== 200) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json<{ item: { dissent: { notes: never[]; withdrawn: never[] } } }>()).item.dissent;
}

describe('Property 80 (R42.1, R42.2, R42.3, R42.8, R42.9): attach snapshots the Log_Summary, holds it under Owner edits, and marks an earlier wording', () => {
  it('records a byte-equal Not_Published snapshot under the author, keeps it stable when the Owner reworks the summary, marks the earlier wording iff it differs, re-snapshots on edit, and frees the slot on withdrawal', async () => {
    await fc.assert(
      fc.asyncProperty(summaryArb, summaryArb, reworkArb, async (summary, noteText, rework) => {
        // p88: reset the shared records at the START so no prior run's units leak in, then make a fresh Project (the
        // reset drops the one `beforeEach` created, and the named D1 is shared across runs in the Workers pool).
        await resetRecords(world.core());
        const projectId = await addProject(world.core(), world.ids.admin, world.at);

        // A Research_Item owned by `author`, carrying the randomized Log_Summary (text + labels).
        const item: ItemView = await world.created('author', 'finding', { projectId, logSummary: summary });

        // R42.2: the Owner cannot dissent their own Research_Item's Log_Summary.
        const ownAttempt = await world.request('author', 'POST', '/dissent', { itemId: item.id, text: noteText });
        expect(ownAttempt.status, 'Owner cannot dissent their own Log_Summary (R42.2)').toBe(403);

        // R42.1: a DIFFERENT active Member attaches the note.
        const attach = await world.request('colleague', 'POST', '/dissent', { itemId: item.id, text: noteText });
        expect(attach.status, await attach.clone().text()).toBe(201);
        const id = (await attach.json<{ dissent: { id: ULID } }>()).dissent.id;

        // R42.1: the stored note records its text, the Member as author, the attach time, a snapshot of the
        // Log_Summary's text AND labels byte-for-byte as they stood, the Research_Item as Parent/Root, Not_Published.
        const atAttach = (await storedNote(id))!;
        expect(atAttach).toMatchObject({ type: 'dissent_note', level: 'not_published', rootId: item.id, parentId: item.id, authorId: world.ids.colleague, withdrawnAt: null });
        expect(atAttach.text, 'note stores its text').toBe(noteText.text);
        expect(atAttach.attachedAt, 'note records the attach time').toBe(world.at);
        expect(atAttach.lastSavedAt, 'last-saved starts at the attach time').toBe(world.at);
        expect(atAttach.concernedSummary, 'snapshot records the Log_Summary text (R42.1/R42.9)').toBe(summary.text);
        expect(JSON.parse(atAttach.concernedSummarySpans ?? '[]'), 'snapshot records the Log_Summary labels (R42.1/R42.9)').toEqual(summary.spans);

        // R42.2: the same Member cannot attach a second current note to the same Log_Summary.
        const second = await world.request('colleague', 'POST', '/dissent', { itemId: item.id, text: rich('A second dissent on the same summary.') });
        expect(second.status, 'a second current note by the same Member is refused (R42.2)').toBe(422);

        // At attach the current Log_Summary equals the snapshot, so NO earlier-wording mark (R42.9/R42.14).
        const fresh = await itemDissent('colleague', item.id as string);
        expect(fresh.notes, 'the item page shows the non-withdrawn note (R42.3)').toHaveLength(1);
        expect(fresh.notes[0], 'note shows text, author, and no earlier-wording mark at attach').toMatchObject({
          id, author: { id: world.ids.colleague }, text: noteText, aboutEarlierWording: false,
        });
        expect(fresh.notes[0]!.comparison, 'no comparison while the wording matches').toBeUndefined();

        // The Owner reworks the Log_Summary AFTER the note is attached (R42.1 "as they stand" is at attach time).
        let differs = false;
        if (rework.kind !== 'none') {
          const reworked: RichText = rework.kind === 'text'
            ? rich(`${summary.text} and more`, summary.spans.length ? [{ k: 'quote', s: 0, e: 5, source: 'A synthetic source' }] : [])
            // A label-only change: same text, a quote label over the whole text (absent from the original snapshot).
            : rich(summary.text, [{ k: 'quote', s: 0, e: summary.text.length, source: 'A reworded source' }]);
          differs = JSON.stringify({ text: reworked.text, spans: reworked.spans }) !== JSON.stringify({ text: summary.text, spans: summary.spans });
          const edited = await world.edit('author', item.id, { rev: await itemRev(item.id), logSummary: reworked, mark: { mark: 'minor_edit' } });
          expect(edited.status, await edited.clone().text()).toBe(200);
        }

        // R42.1/R42.9 stability: the note's stored snapshot is UNCHANGED by the Owner's rework — it still holds the
        // wording at attach time, not the current wording. The note stays attached to the wording it concerned.
        const afterRework = (await storedNote(id))!;
        expect(afterRework.concernedSummary, 'snapshot text unchanged by the Owner rework').toBe(summary.text);
        expect(JSON.parse(afterRework.concernedSummarySpans ?? '[]'), 'snapshot labels unchanged by the Owner rework').toEqual(summary.spans);
        expect(afterRework.lastSavedAt, 'the note last-saved time is untouched by the Owner rework').toBe(world.at);

        // R42.9/R42.14: the earlier-wording mark is shown exactly when the current Log_Summary differs from the snapshot.
        const afterView = await itemDissent('colleague', item.id as string);
        expect(afterView.notes[0]!.aboutEarlierWording, 'earlier-wording mark iff the current summary differs from the snapshot (R42.9)').toBe(differs);
        if (differs) {
          const comparison = afterView.notes[0]!.comparison!;
          expect(comparison, 'the mark links to a comparison of recorded and current wording (R42.9)').toBeDefined();
          expect(comparison.concernedSummary, 'the comparison recorded side is the snapshot').toEqual(summary);
          expect(comparison.words.length, 'the comparison carries the word diff').toBeGreaterThanOrEqual(1);
        } else {
          expect(afterView.notes[0]!.comparison, 'no comparison while the wording matches').toBeUndefined();
        }

        // The Project_Log / preview builder (nonWithdrawnNotes) applies the same rule to the same stored rows.
        const rowFor = (note: typeof afterRework): DissentRow => ({
          id: id as ULID, rev: 1, itemId: item.id as ULID, authorId: note.authorId, authorName: null,
          text: note.text, spans: note.textSpans, lastSavedAt: world.at as never,
          concernedSummary: note.concernedSummary, concernedSpans: note.concernedSummarySpans,
          logSummary: differs ? `${afterRework.concernedSummary} CHANGED` : note.concernedSummary,
          logSummarySpans: note.concernedSummarySpans, withdrawnAt: null, withdrawnBy: null, withdrawalReason: null,
        });
        // When built with current == snapshot, no mark; this mirrors the item view's decision for the matching case.
        const matching = nonWithdrawnNotes([{ ...rowFor(afterRework), logSummary: afterRework.concernedSummary }]);
        expect(matching[0]!.aboutEarlierWording, 'shared builder: matching wording has no mark').toBe(false);

        // R42.7: editing the note's text takes a NEW snapshot of the THEN-current Log_Summary, so an edit after the
        // Owner reworked the summary re-attaches the note to the new wording and clears the earlier-wording mark.
        const summaryRev = await itemRev(item.id);
        const edit = await world.request('colleague', 'PATCH', `/dissent/${id}`, { rev: 1, summaryRev, text: rich('My revised dissent.'), mark: { mark: 'minor_edit' } });
        expect(edit.status, await edit.clone().text()).toBe(200);
        const current = (await world.core().prepare('SELECT ri.log_summary AS t, ri.log_summary_spans AS s FROM research_items ri WHERE ri.unit_id = ?1').bind(item.id).first<{ t: string; s: string }>())!;
        const afterEdit = (await storedNote(id))!;
        expect(afterEdit.text, 'the edit saved the new note text').toBe('My revised dissent.');
        expect(afterEdit.concernedSummary, 'the edit re-snapshots the then-current Log_Summary text (R42.7)').toBe(current.t);
        expect(JSON.parse(afterEdit.concernedSummarySpans ?? '[]'), 'the edit re-snapshots the then-current Log_Summary labels (R42.7)').toEqual(JSON.parse(current.s ?? '[]'));
        const afterEditView = await itemDissent('colleague', item.id as string);
        expect(afterEditView.notes[0]!.aboutEarlierWording, 're-snapshot on edit clears the earlier-wording mark (R42.7/R42.9)').toBe(false);

        // R42.8: the author withdraws; the note's text and snapshot STAY, and the one-note slot frees so the author may
        // dissent the same Log_Summary again. A withdrawn note leaves the non-withdrawn display (R42.3/R42.8). The edit
        // above bumped the note to rev 2, so the withdraw form sends that current rev (R42.16).
        const noteRev = (await world.core().prepare('SELECT rev FROM units WHERE id = ?1').bind(id).first<number>('rev'))!;
        const withdraw = await world.request('colleague', 'POST', `/dissent/${id}/withdraw`, { rev: noteRev, summaryRev: await itemRev(item.id), reason: 'Resolved in discussion.' });
        expect(withdraw.status, await withdraw.clone().text()).toBe(200);
        const withdrawn = (await storedNote(id))!;
        expect(withdrawn, 'withdrawal keeps the note text and snapshot (R42.8)').toMatchObject({ text: 'My revised dissent.', concernedSummary: current.t, withdrawnAt: world.at });
        const afterWithdraw = await itemDissent('colleague', item.id as string);
        expect(afterWithdraw.notes, 'a withdrawn note leaves the non-withdrawn display (R42.3/R42.8)').toHaveLength(0);
        expect(afterWithdraw.withdrawn.map((note) => note.id), 'the withdrawn note stays on the item page (R42.8)').toContain(id);

        // The freed slot: the same Member attaches a fresh note on the same Log_Summary (R42.8).
        const again = await world.request('colleague', 'POST', '/dissent', { itemId: item.id, text: rich('A fresh dissent after withdrawal.') });
        expect(again.status, 'the author may dissent again once the earlier note is withdrawn (R42.8)').toBe(201);
      }),
      { numRuns: Math.min(FC_RUNS, 40) },
    );
  }, 600_000);
});

/** A snapshot/current pair that is either equal or differs in text, in labels, or in both. */
interface Pair { readonly snapshot: RichText; readonly current: RichText | null; readonly differs: boolean }
const pairArb: fc.Arbitrary<Pair> = summaryArb.chain((snapshot) =>
  fc.oneof(
    // Equal: the current wording is a byte copy of the snapshot (no mark).
    fc.constant<Pair>({ snapshot, current: { text: snapshot.text, spans: [...snapshot.spans] }, differs: false }),
    // Text differs.
    fc.constant<Pair>({ snapshot, current: { text: `${snapshot.text} reworded`, spans: [...snapshot.spans] }, differs: true }),
    // Labels differ (same text, a label the snapshot lacks or drops).
    fc.constant<Pair>({
      snapshot,
      current: { text: snapshot.text, spans: snapshot.spans.length ? [] : [{ k: 'quote', s: 0, e: snapshot.text.length, source: 'A synthetic source' }] },
      differs: true,
    }),
    // The current Log_Summary is gone (null): still a difference from a recorded snapshot.
    fc.constant<Pair>({ snapshot, current: null, differs: true }),
  ),
);

describe('Property 80 (R42.9, R42.14): the shared display builder marks an earlier wording exactly when the snapshot differs from the current Log_Summary', () => {
  it('sets aboutEarlierWording and the comparison iff the note snapshot differs from the current wording, in text or in labels', () => {
    fc.assert(
      fc.property(pairArb, (pair) => {
        const row: DissentRow = {
          id: '0'.repeat(26) as ULID, rev: 1, itemId: '1'.repeat(26) as ULID, authorId: '2'.repeat(26) as ULID, authorName: 'A Member',
          text: 'My dissent.', spans: '[]', lastSavedAt: '2026-10-27T18:00:00.000Z' as never,
          concernedSummary: pair.snapshot.text, concernedSpans: JSON.stringify(pair.snapshot.spans),
          logSummary: pair.current === null ? null : pair.current.text,
          logSummarySpans: pair.current === null ? null : JSON.stringify(pair.current.spans),
          withdrawnAt: null, withdrawnBy: null, withdrawalReason: null,
        };
        const display = buildDissentDisplay([row]);
        expect(display.notes).toHaveLength(1);
        const note = display.notes[0]!;
        // R42.9/R42.14: the earlier-wording mark is set exactly when the snapshot differs from the current wording.
        expect(note.aboutEarlierWording).toBe(pair.differs);
        // The comparison is present exactly while the mark is set, with the snapshot as the recorded side (R42.9).
        if (pair.differs) {
          expect(note.comparison, 'comparison present with the mark').toBeDefined();
          expect(note.comparison!.concernedSummary, 'the recorded side is the note snapshot').toEqual(pair.snapshot);
          expect(note.comparison!.currentSummary, 'the current side is the current wording').toEqual(pair.current);
        } else {
          expect(note.comparison, 'no comparison without the mark').toBeUndefined();
        }
        // `nonWithdrawnNotes` makes the same decision from the same row (the Project_Log / preview surface).
        expect(nonWithdrawnNotes([row])[0]!.aboutEarlierWording).toBe(pair.differs);
      }),
      { numRuns: FC_RUNS },
    );
  });
});
