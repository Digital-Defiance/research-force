import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AcceptanceBuilder, draftsToSelections, emptyDraft } from '../src/moderation/acceptance';
import { ChangedElements, EmailPreview } from '../src/moderation/decide';
import { ModerationQueueScreen } from '../src/moderation/queue';
import { OutsideSubmissionScreen } from '../src/moderation/submission';
import { ContactReviewForm, CorrectionForm, SubmissionHistoryView } from '../src/moderation/contact-review';
import type { QueueEntry, SubmissionHistory } from '../src/moderation/model';
import { fakeApi, json, renderScreen } from './helpers';
import { FORM_DATA, PROJECT, VALUE_SETS, MEMBERS, PARTY, HIDDEN_PARTY } from './fixtures';

const SUB_ID = '01J000000000000000000SUB01';
const FILE_ID = '01J00000000000000000FILE01';

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: SUB_ID, reference: 'OS-0001', type: 'material', state: 'queued', projectId: PROJECT.id, projectName: PROJECT.name,
    submitter: { name: 'Mara Submitter', email: 'mara@example.test', affiliation: 'A college' },
    text: 'Please consider this material.', pageRef: null, files: [],
    receiptTime: '2026-10-27 09:30 UTC', responseTarget: null,
    contactReview: null, history: { contactReviews: [], corrections: [] }, ...overrides,
  };
}

const QUEUE = (items: QueueEntry[], next: string | null = null) => ({ items, next, zone: 'UTC' });
const PROJECTS = { projects: [{ ...PROJECT, description: null, slug: 'p', slugFixed: true, featured: false, accent: null, position: 0, disclosureLevel: 'not_published', disclosureLine: null, createdBy: 'x', createdAt: '2026-01-01T00:00:00.000Z', rev: 1 }] };

/** The GETs the submission view needs: the queue, the projects, and the form data. */
function submissionApi(items: QueueEntry[]) {
  return fakeApi({
    'GET /moderation': QUEUE(items),
    'GET /projects': PROJECTS,
    'GET /value-sets': { valueSets: VALUE_SETS },
    'GET /parties': { parties: [PARTY, HIDDEN_PARTY] },
    'GET /members': { members: MEMBERS },
  });
}

describe('the moderation queue', () => {
  it('lists submissions with type, state, Project, and the General_Choice (R32.17)', async () => {
    const api = fakeApi({ 'GET /moderation': QUEUE([entry(), entry({ id: 'G', reference: 'OS-0002', type: 'comment', projectId: null, projectName: null })]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Moderation queue' });
    const rows = screen.getAllByRole('row').slice(1);
    expect(screen.getByRole('table', { name: 'Outside submissions' })).toBeTruthy();
    expect(rows[0]!.textContent).toContain('Material');
    expect(rows[0]!.textContent).toContain('Queued');
    expect(rows[0]!.textContent).toContain(`Project: ${PROJECT.name}`);
    expect(rows[1]!.textContent).toContain('For the General choice (no Project chosen)');
    expect(screen.getByRole('link', { name: 'OS-0001' }).getAttribute('href')).toBe(`/moderation/${SUB_ID}`);
  });

  it('marks an overdue Response_Target and shows its receipt and due dates (R46.24)', async () => {
    const overdue = entry({ type: 'correction', responseTarget: { receivedOn: '2026-10-01', dueOn: '2026-10-15', overdue: true } });
    const ontime = entry({ id: 'B', reference: 'OS-0003', type: 'removal_request', responseTarget: { receivedOn: '2026-10-25', dueOn: '2026-11-08', overdue: false } });
    const api = fakeApi({ 'GET /moderation': QUEUE([overdue, ontime]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Moderation queue' });
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first!).getByText('Overdue')).toBeTruthy();
    expect(first!.textContent).toContain('due 2026-10-15');
    expect(within(second!).queryByText('Overdue')).toBeNull();
    expect(second!.textContent).toContain('received 2026-10-25, due 2026-11-08');
  });

  it('shows an empty state for an empty queue and for a client filter matching nothing, without a new request (R8.3, R9.4, R9.5)', async () => {
    const empty = fakeApi({ 'GET /moderation': QUEUE([]), 'GET /projects': PROJECTS });
    const { unmount } = renderScreen(<ModerationQueueScreen />, { client: empty.client, administrator: true });
    expect(await screen.findByText('No Outside Submission matches.')).toBeTruthy();
    unmount();
    const api = fakeApi({ 'GET /moderation': QUEUE([entry()]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('link', { name: 'OS-0001' });
    const before = api.calls.length;
    fireEvent.change(screen.getByLabelText('Filter loaded rows'), { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('No loaded Outside Submission matches the filter.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter loaded rows'), { target: { value: 'mara' } });
    expect(screen.getByRole('link', { name: 'OS-0001' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Sort loaded rows'), { target: { value: 'reference' } });
    expect(api.calls.length).toBe(before);
  });

  it('filters the queue by type, state, and Project (R39.14)', async () => {
    const api = fakeApi({ 'GET /moderation*': QUEUE([entry()]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Moderation queue' });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'correction' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'accepted' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'general' } });
    await waitFor(() => expect(api.calls.some((call) => call.path.includes('type=correction') && call.path.includes('state=accepted') && call.path.includes('project=general'))).toBe(true));
  });
});

describe('the outside submission view', () => {
  it('shows the submitter, text, Project, and the files (R14.8, R32.17)', async () => {
    const api = submissionApi([entry({ pageRef: '/public/page', files: [{ id: FILE_ID, fileName: 'scan.pdf', sizeBytes: 2048, sha256: 'abc' }] })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    expect(screen.getByText('Mara Submitter')).toBeTruthy();
    expect(screen.getByText('Please consider this material.')).toBeTruthy();
    expect(screen.getByText('/public/page')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'File scan.pdf' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download full file' })).toBeTruthy();
  });

  it('shows a failed-email notice when the submitter email failed (R32.11)', async () => {
    const api = submissionApi([entry({ failedEmail: true })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    expect(await screen.findByText('The email to this submitter could not be sent.')).toBeTruthy();
  });

  it('shows the Response_Target with an overdue mark on the submission (R46.24)', async () => {
    const api = submissionApi([entry({ type: 'correction', responseTarget: { receivedOn: '2026-10-01', dueOn: '2026-10-15', overdue: true } })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Correction' });
    expect(screen.getByText('Response target: received 2026-10-01, due 2026-10-15 — overdue')).toBeTruthy();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
  });

  it('says when the submission is not in the queue', async () => {
    const api = submissionApi([entry()]);
    renderScreen(<OutsideSubmissionScreen id="01J0000000000000000000MISS" />, { client: api.client, administrator: true });
    expect(await screen.findByText('This Outside Submission is not in the queue, or you cannot see it.')).toBeTruthy();
  });
});

describe('recording a decision', () => {
  it('shows the exact email text first and applies only after confirmation (R32.10)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      'GET /moderation': QUEUE([entry()]),
      'GET /projects': PROJECTS,
      'GET /value-sets': { valueSets: VALUE_SETS },
      'GET /parties': { parties: [PARTY, HIDDEN_PARTY] },
      'GET /members': { members: MEMBERS },
      [`POST /moderation/${SUB_ID}/decide`]: (call) => {
        bodies.push(call.body);
        const confirm = (call.body as { confirm: boolean }).confirm;
        return json({ reference: 'OS-0001', email: { subject: 'Your submission (OS-0001)', body: ['Thank you for your submission.', 'After review, it has not been accepted.'] },
          ...(confirm ? { applied: { decisionId: 'D1', kind: 'rejected', createdUnitIds: [] } } : {}) });
      },
    });
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'rejected' } });
    fireEvent.change(screen.getByLabelText(/Message to the submitter/u), { target: { value: 'Not this time.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email' }));
    expect(await screen.findByText('Subject: Your submission (OS-0001)')).toBeTruthy();
    expect(screen.getByText('Thank you for your submission.')).toBeTruthy();
    // Only the preview request so far, with confirm:false.
    expect(bodies).toEqual([{ decision: 'rejected', confirm: false, text: 'Not this time.' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('The decision was recorded and the email queued.');
    expect(bodies[1]).toEqual({ decision: 'rejected', confirm: true, text: 'Not this time.' });
  });

  it('builds an acceptance of Items and reports the created units (R32.4, R32.13)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      'GET /moderation': QUEUE([entry()]),
      'GET /projects': PROJECTS,
      'GET /value-sets': { valueSets: VALUE_SETS },
      'GET /parties': { parties: [PARTY, HIDDEN_PARTY] },
      'GET /members': { members: MEMBERS },
      [`POST /moderation/${SUB_ID}/decide`]: (call) => {
        bodies.push(call.body);
        const confirm = (call.body as { confirm: boolean }).confirm;
        return json({ reference: 'OS-0001', email: { subject: 'Your submission was accepted (OS-0001)', body: ['Thank you.'] },
          ...(confirm ? { applied: { decisionId: 'D1', kind: 'accepted', createdUnitIds: ['01J0000000000000000000NEW1'] } } : {}) });
      },
    });
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'accepted' } });
    fireEvent.change(screen.getByLabelText(/Message to the submitter/u), { target: { value: 'Accepted.' } });
    // The default draft is a Finding; give it a title and claim.
    expect(screen.getByRole('group', { name: 'Accepted unit 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email' }));
    await screen.findByText('Subject: Your submission was accepted (OS-0001)');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('The decision was recorded and the email queued.');
    expect(screen.getByRole('link', { name: '01J0000000000000000000NEW1' })).toBeTruthy();
    const applied = bodies[1] as { decision: string; items: unknown[] };
    expect(applied.decision).toBe('accepted');
    expect(applied.items).toHaveLength(1);
  });

  it('offers removal decisions and sends the statement with changed elements (R46.23)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      'GET /moderation': QUEUE([entry({ type: 'removal_request' })]),
      'GET /projects': PROJECTS,
      'GET /value-sets': { valueSets: VALUE_SETS },
      'GET /parties': { parties: [PARTY, HIDDEN_PARTY] },
      'GET /members': { members: MEMBERS },
      [`POST /moderation/${SUB_ID}/decide`]: (call) => {
        bodies.push(call.body);
        const confirm = (call.body as { confirm: boolean }).confirm;
        return json({ reference: 'OS-0001', email: { subject: 'Your removal request was actioned (OS-0001)', body: ['Thank you.'] },
          ...(confirm ? { applied: { decisionId: 'D1', kind: 'accepted', createdUnitIds: [] } } : {}) });
      },
    });
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Removal request' });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'removal_accepted' } });
    fireEvent.change(screen.getByLabelText(/Statement to the submitter/u), { target: { value: 'We removed it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a changed element' }));
    fireEvent.change(screen.getByLabelText('Element 1 kind'), { target: { value: 'entry_section' } });
    fireEvent.change(screen.getByLabelText('Element 1 reference'), { target: { value: 'RF-0007 §2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email' }));
    await screen.findByText('Subject: Your removal request was actioned (OS-0001)');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('The decision was recorded and the email queued.');
    expect(bodies[1]).toEqual({ decision: 'removal_accepted', confirm: true, statement: 'We removed it.', changed: [{ kind: 'entry_section', reference: 'RF-0007 §2' }] });
  });

  it('shows the recorded final decision when one already exists (R32.16)', async () => {
    const api = fakeApi({
      'GET /moderation': QUEUE([entry()]),
      'GET /projects': PROJECTS,
      'GET /value-sets': { valueSets: VALUE_SETS },
      'GET /parties': { parties: [PARTY, HIDDEN_PARTY] },
      'GET /members': { members: MEMBERS },
      [`POST /moderation/${SUB_ID}/decide`]: json({ error: 'conflict', details: { rule: 'decision_open', decision: { kind: 'accepted', admin: { displayName: 'Ada Example' }, at: '2026-10-28T00:00:00.000Z' } } }, 409),
    });
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'rejected' } });
    fireEvent.change(screen.getByLabelText(/Message to the submitter/u), { target: { value: 'No.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the email' }));
    expect(await screen.findByText('A accepted decision was already recorded by Ada Example.')).toBeTruthy();
  });

  it('hides the decision form from a non-administrator', async () => {
    const api = submissionApi([entry()]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client });
    await screen.findByRole('heading', { name: 'Material' });
    expect(screen.queryByLabelText('Decision')).toBeNull();
  });
});

describe('the acceptance builder', () => {
  it('turns drafts into selections, naming a Parent created earlier (R32.4)', () => {
    const parent = { ...emptyDraft('finding'), ref: 'f1' };
    const reply = { ...emptyDraft(), unit: 'reply' as const, parentCreated: 'f1', replyText: { text: { text: 'A note.', spans: [] } } };
    const selections = draftsToSelections([parent, reply]);
    expect(selections[0]).toMatchObject({ unit: 'research_item', ref: 'f1', kind: 'finding' });
    expect(selections[1]).toEqual({ unit: 'reply', parent: { created: 'f1' }, text: { text: 'A note.', spans: [] } });
  });

  it('requires a Project for each Item of a General_Choice submission (R32.18)', () => {
    renderScreen(<AcceptanceBuilder drafts={[emptyDraft('finding')]} onChange={() => undefined} projects={[PROJECT as never]} generalChoice submissionProject={null} data={FORM_DATA} errors={[]} />, { client: fakeApi({}).client });
    const project = screen.getByLabelText(/Project/u) as HTMLSelectElement;
    expect(project.getAttribute('aria-required') ?? project.required).toBeTruthy();
  });
});

describe('the email preview and changed elements', () => {
  it('shows the subject and every line of the email', () => {
    const view = renderScreen(<EmailPreview email={{ subject: 'Re: OS-1', body: ['Line one.', 'Line two.'] }} />, { client: fakeApi({}).client });
    expect(view.container.textContent).toContain('Subject: Re: OS-1');
    expect(view.container.textContent).toContain('Line one.');
    expect(view.container.textContent).toContain('Line two.');
  });

  it('adds and removes changed elements', () => {
    const entries: unknown[][] = [];
    const changed = [{ kind: 'item' as const, reference: 'RF-1' }];
    renderScreen(<ChangedElements value={changed} onChange={(next) => entries.push(next)} errors={[]} />, { client: fakeApi({}).client });
    fireEvent.click(screen.getByRole('button', { name: 'Add a changed element' }));
    expect(entries[0]).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove element 1' }));
    expect(entries[entries.length - 1]).toHaveLength(0);
  });
});

const ADMIN = { id: '01J00000000000000000ADMIN1', displayName: 'Ada Example' };

describe('contact review marks and the due filter', () => {
  it('marks a due and an overdue contact review in the queue rows (R32.19, R32.21)', async () => {
    const due = entry({ state: 'accepted', contactReview: { dueOn: '2027-10-27', overdue: false } });
    const overdue = entry({ id: 'B', reference: 'OS-0009', state: 'accepted', contactReview: { dueOn: '2026-09-01', overdue: true } });
    const api = fakeApi({ 'GET /moderation': QUEUE([due, overdue]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Moderation queue' });
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(within(first!).getByText('Contact review due')).toBeTruthy();
    expect(within(second!).getByText('Contact review overdue')).toBeTruthy();
  });

  it('filters the queue to those due for a contact review (R32.19)', async () => {
    const api = fakeApi({ 'GET /moderation*': QUEUE([entry({ state: 'accepted', contactReview: { dueOn: '2027-10-27', overdue: false } })]), 'GET /projects': PROJECTS });
    renderScreen(<ModerationQueueScreen />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Moderation queue' });
    fireEvent.change(screen.getByLabelText('Contact review'), { target: { value: 'due' } });
    await waitFor(() => expect(api.calls.some((call) => call.path.includes('contactReview=due'))).toBe(true));
  });
});

describe('the contact review form', () => {
  it('records a Keep with a reason (R32.20)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact-review`]: (call) => { bodies.push(call.body); return json({ recorded: true, action: 'keep' }); } });
    const done: boolean[] = [];
    renderScreen(<ContactReviewForm submissionId={SUB_ID} onDone={() => done.push(true)} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Contact review'), { target: { value: 'keep' } });
    fireEvent.change(screen.getByLabelText(/Reason to keep the contact/u), { target: { value: 'Correspondence is ongoing.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep the contact' }));
    await waitFor(() => expect(done).toHaveLength(1));
    expect(bodies[0]).toEqual({ choice: 'keep', reason: 'Correspondence is ongoing.' });
  });

  it('records an Erase without a reason (R32.20)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact-review`]: (call) => { bodies.push(call.body); return json({ recorded: true, action: 'erase' }); } });
    const done: boolean[] = [];
    renderScreen(<ContactReviewForm submissionId={SUB_ID} onDone={() => done.push(true)} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Contact review'), { target: { value: 'erase' } });
    expect(screen.getByText(/will be erased within 24 hours/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Erase the contact' }));
    await waitFor(() => expect(done).toHaveLength(1));
    expect(bodies[0]).toEqual({ choice: 'erase' });
  });

  it('shows the field error when a Keep reason is rejected (R32.20)', async () => {
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact-review`]: json({ error: 'validation', fields: [{ field: 'reason', rule: 'Give a reason.' }] }, 422) });
    renderScreen(<ContactReviewForm submissionId={SUB_ID} onDone={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Contact review'), { target: { value: 'keep' } });
    fireEvent.change(screen.getByLabelText(/Reason to keep the contact/u), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep the contact' }));
    expect(await screen.findByText('Give a reason.')).toBeTruthy();
  });
});

describe('the correction form', () => {
  it('corrects the attribution, clearing a blank affiliation (R32.22)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact`]: (call) => { bodies.push(call.body); return json({ corrected: true, kind: 'attribution', erased: false }); } });
    const done: boolean[] = [];
    renderScreen(<CorrectionForm entry={entry({ state: 'accepted' })} onDone={() => done.push(true)} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Correction'), { target: { value: 'attribution' } });
    fireEvent.change(screen.getByLabelText(/Submitter name/u), { target: { value: 'Augusta Ada King' } });
    fireEvent.change(screen.getByLabelText('Submitter affiliation'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Reason for the correction/u), { target: { value: 'She asked us to use her full name.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record the correction' }));
    await waitFor(() => expect(done).toHaveLength(1));
    expect(bodies[0]).toEqual({ kind: 'attribution', name: 'Augusta Ada King', reason: 'She asked us to use her full name.' });
  });

  it('corrects the contact email (R32.22)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact`]: (call) => { bodies.push(call.body); return json({ corrected: true, kind: 'contact', erased: false }); } });
    renderScreen(<CorrectionForm entry={entry({ state: 'accepted' })} onDone={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Correction'), { target: { value: 'contact' } });
    fireEvent.change(screen.getByLabelText(/Submitter email/u), { target: { value: 'new@example.test' } });
    fireEvent.change(screen.getByLabelText(/Reason for the correction/u), { target: { value: 'A new address was given.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record the correction' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ kind: 'contact', email: 'new@example.test', reason: 'A new address was given.' });
  });

  it('erases the contact at once (R32.22)', async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({ [`POST /moderation/${SUB_ID}/contact`]: (call) => { bodies.push(call.body); return json({ corrected: true, kind: 'contact', erased: true }); } });
    renderScreen(<CorrectionForm entry={entry({ state: 'accepted' })} onDone={() => undefined} />, { client: api.client, administrator: true });
    fireEvent.change(screen.getByLabelText('Correction'), { target: { value: 'contact_erasure' } });
    fireEvent.change(screen.getByLabelText(/Reason for the correction/u), { target: { value: 'A deletion request.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record the correction' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ kind: 'contact_erasure', reason: 'A deletion request.' });
  });

  it('hides the erase option once the contact is already erased (R32.22)', () => {
    renderScreen(<CorrectionForm entry={entry({ state: 'accepted', submitter: { name: 'Mara', email: null, affiliation: null } })} onDone={() => undefined} />, { client: fakeApi({}).client, administrator: true });
    const select = screen.getByLabelText('Correction');
    expect(within(select).queryByText('Erase the contact')).toBeNull();
  });
});

describe('the contact review and correction history', () => {
  it('shows contact reviews with their reasons and the corrections, never a previously erased email (R32.20, R32.22)', () => {
    const history: SubmissionHistory = {
      contactReviews: [
        { action: 'erase', reason: null, admin: ADMIN, at: '2027-11-01 09:00 UTC' },
        { action: 'keep', reason: 'Correspondence is ongoing.', admin: ADMIN, at: '2026-11-01 09:00 UTC' },
      ],
      corrections: [
        { kind: 'contact', erased: true, newName: null, newAffiliation: null, newEmail: null, prevName: null, prevAffiliation: null, prevEmail: null, admin: ADMIN, reason: 'Deletion request.', at: '2027-01-01 09:00 UTC' },
        { kind: 'attribution', erased: false, newName: 'Augusta Ada King', newAffiliation: 'Countess', newEmail: null, prevName: 'Ada Lovelace', prevAffiliation: null, prevEmail: null, admin: ADMIN, reason: 'Full name.', at: '2026-12-01 09:00 UTC' },
      ],
    };
    const view = renderScreen(<SubmissionHistoryView history={history} />, { client: fakeApi({}).client });
    expect(screen.getByText('Correspondence is ongoing.')).toBeTruthy();
    expect(screen.getByText('Augusta Ada King')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Contact erased' })).toBeTruthy();
    // No email address appears anywhere in the history (R32.22).
    expect(view.container.textContent).not.toMatch(/@/u);
  });

  it('says when nothing has been recorded', () => {
    renderScreen(<SubmissionHistoryView history={{ contactReviews: [], corrections: [] }} />, { client: fakeApi({}).client });
    expect(screen.getByText('No contact review or correction has been recorded.')).toBeTruthy();
  });
});

describe('the submission view contact management', () => {
  it('offers the contact review and correction forms to an administrator for an accepted submission that still holds a contact', async () => {
    const api = submissionApi([entry({ state: 'accepted' })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    expect(screen.getByRole('form', { name: 'Record a contact review' })).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Correct the submitter' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Contact reviews and corrections' })).toBeTruthy();
  });

  it('hides the contact review form once the contact is erased but keeps the correction form and history', async () => {
    const api = submissionApi([entry({ state: 'accepted', submitter: { name: 'Mara', email: null, affiliation: null } })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client, administrator: true });
    await screen.findByRole('heading', { name: 'Material' });
    expect(screen.queryByRole('form', { name: 'Record a contact review' })).toBeNull();
    expect(screen.getByRole('form', { name: 'Correct the submitter' })).toBeTruthy();
  });

  it('shows a non-administrator the history but no forms', async () => {
    const api = submissionApi([entry({ state: 'accepted', history: { contactReviews: [{ action: 'keep', reason: 'Kept.', admin: ADMIN, at: '2026-11-01 09:00 UTC' }], corrections: [] } })]);
    renderScreen(<OutsideSubmissionScreen id={SUB_ID} />, { client: api.client });
    await screen.findByRole('heading', { name: 'Material' });
    expect(screen.queryByRole('form', { name: 'Record a contact review' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Correct the submitter' })).toBeNull();
    expect(screen.getByText('Kept.')).toBeTruthy();
  });
});
