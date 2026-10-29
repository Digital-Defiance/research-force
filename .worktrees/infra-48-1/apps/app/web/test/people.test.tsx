import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLE_IDS } from '@researchforce/domain/permissions';
import { MembersPage } from '../src/people/members';
import { MutedProjectsForm, PreferencesForm } from '../src/people/preferences';
import { LicenceAgreementForm, ProfileForm } from '../src/people/profile';
import { ProfileDetails } from '../src/people/view';
import type { ProjectRecord } from '../src/types';
import { BUILT_IN, failure, fakeApi, makeMe, MEMBER_ID, OTHER_ID, renderScreen, SPECIALTY_ID } from './helpers';
import { MEMBERS } from './fixtures';

const view = { displayName: 'Ada Example', specialties: ['Historian'], affiliations: [], biography: 'Reads registers.' };
const checkbox = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe('the Profile form', () => {
  it('shows the Public_Profile preview and saves only after confirmation (R46.4)', async () => {
    let refreshed = 0;
    const api = fakeApi({
      'PATCH /me/profile': (call) => ((call.body as { confirmation?: string }).confirmation === 'C1'
        ? { saved: true, profile: {} }
        : { saved: false, preview: { view, marks: [] }, confirmation: 'C1' }),
    });
    api.client.status.update({ profileMissing: ['displayName'] });
    renderScreen(<ProfileForm me={makeMe()} onSaved={() => { refreshed += 1; }} />, { client: api.client });
    fireEvent.change(screen.getByLabelText(/^Short biography/u), { target: { value: 'Reads registers.' } });
    fireEvent.click(checkbox(/^Public Profile/u));
    fireEvent.click(screen.getByRole('button', { name: 'Save the Profile' }));
    const preview = await screen.findByRole('region', { name: 'Public Profile preview' });
    expect([...preview.querySelectorAll('dd')].map((entry) => entry.textContent)).toEqual(['Ada Example', 'Historian', 'None', 'Reads registers.']);
    expect(refreshed).toBe(0);
    expect(api.writes()[0]!.body).toEqual({ displayName: 'Ada Example', specialtyIds: [SPECIALTY_ID], affiliations: [], biography: 'Reads registers.', timeZone: 'UTC', publicProfile: true });
    fireEvent.click(within(preview).getByRole('button', { name: 'Confirm and save with Public Profile on' }));
    expect(await screen.findByText('Your Profile was saved.')).toBeTruthy();
    expect(api.writes()[1]!.body).toMatchObject({ publicProfile: true, confirmation: 'C1' });
    expect(refreshed).toBe(1);
    expect(api.client.status.get().profileMissing).toBeNull();
  });

  it('shows the new preview when the confirmed one went stale', async () => {
    const stale = { preview: { view: { ...view, displayName: 'Ada E.' }, marks: [] }, confirmation: 'C2' };
    const api = fakeApi({
      'PATCH /me/profile': (call) => ((call.body as { confirmation?: string }).confirmation === undefined
        ? { saved: false, preview: { view, marks: [] }, confirmation: 'C1' }
        : failure(409, 'preview_stale', { details: stale })),
    });
    renderScreen(<ProfileForm me={makeMe()} onSaved={() => undefined} />, { client: api.client });
    fireEvent.click(screen.getByRole('button', { name: 'Save the Profile' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and save with Public Profile on' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Public Profile preview' }).querySelector('dd')?.textContent).toBe('Ada E.'));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to the form' }));
    expect(screen.getByRole('heading', { name: 'Your Profile' })).toBeTruthy();
  });

  it('names the missing fields and shows field errors without saving (R3.1, R3.6)', async () => {
    const api = fakeApi({ 'PATCH /me/profile': failure(422, 'validation', { fields: [{ field: 'displayName', rule: 'Another Member already uses this display name.' }] }) });
    renderScreen(<ProfileForm me={makeMe({ profile: null, missing: ['displayName', 'specialtyIds', 'timeZone'] })} onSaved={() => undefined} />, { client: api.client });
    expect(screen.getByRole('alert').textContent).toContain('Your Profile still needs a display name, at least one Specialty, a time zone.');
    fireEvent.change(screen.getByLabelText(/^Display name/u), { target: { value: 'Taken' } });
    fireEvent.click(checkbox('Cryptanalysis'));
    fireEvent.click(screen.getByRole('button', { name: 'Add an affiliation' }));
    fireEvent.change(screen.getByLabelText('Affiliation 1'), { target: { value: 'A society' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the Profile' }));
    expect(await screen.findByText('Another Member already uses this display name.')).toBeTruthy();
    expect(api.writes()[0]!.body).toMatchObject({ displayName: 'Taken', specialtyIds: ['0000000000000000000000S002'], affiliations: ['A society'], publicProfile: false });
  });

  it('keeps a retired Specialty the Member already has, marked as retired', () => {
    const me = makeMe();
    renderScreen(<ProfileForm me={{ ...me, profile: { ...me.profile!, specialties: [{ id: 'S9', name: 'Old craft', retired: true }] } }} onSaved={() => undefined} />, { client: fakeApi({}).client });
    expect(checkbox('Old craft (retired)').checked).toBe(true);
    expect(checkbox('Historian').checked).toBe(false);
  });
});

describe('the Licence_Agreement', () => {
  it('is given with a checkbox that is never preselected (R46.16)', async () => {
    let refreshed = 0;
    const api = fakeApi({ 'POST /me/licence-agreement': { agreed: true } });
    renderScreen(<LicenceAgreementForm me={makeMe()} onSaved={() => { refreshed += 1; }} />, { client: api.client });
    const box = checkbox('I agree that my contributions are published under CC BY 4.0.');
    expect(box.checked).toBe(false);
    const give = screen.getByRole('button', { name: 'Give the agreement' }) as HTMLButtonElement;
    expect(give.disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(give);
    await waitFor(() => expect(refreshed).toBe(1));
    expect(api.writes()[0]!.body).toEqual({ agreed: true, licenceName: 'CC BY 4.0' });
  });

  it('lists the agreements given and asks again only for a new Content Licence', () => {
    const me = makeMe();
    const agreed = { ...me, profile: { ...me.profile!, licence: { current: true, agreements: [{ licenceName: 'CC BY 4.0', givenOn: '2026-10-01' }] } } };
    const first = renderScreen(<LicenceAgreementForm me={agreed} onSaved={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.getByText('You agreed to CC BY 4.0 on 2026-10-01.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    first.unmount();
    const second = renderScreen(<LicenceAgreementForm me={{ ...agreed, contentLicence: 'CC BY-SA 4.0' }} onSaved={() => undefined} />, { client: fakeApi({}).client });
    expect(checkbox('I agree that my contributions are published under CC BY-SA 4.0.').checked).toBe(false);
    second.unmount();
    renderScreen(<LicenceAgreementForm me={{ ...agreed, contentLicence: null }} onSaved={() => undefined} />, { client: fakeApi({}).client });
    expect(screen.getByText('No Content Licence is configured yet.')).toBeTruthy();
  });
});

describe('notification settings', () => {
  it('saves a preference for each Event_Type and the Daily_Digest hour (R19.8, R20.13)', async () => {
    const api = fakeApi({ 'PUT /me/preferences': { saved: true } });
    renderScreen(<PreferencesForm me={makeMe({ preferences: { events: { reply: { inApp: false, email: 'off' } }, dailyDigestHour: 8 } })} onSaved={() => undefined} />, { client: api.client });
    expect(checkbox('Replies in the Workspace').checked).toBe(false);
    expect(checkbox('Mentions in the Workspace').checked).toBe(true);
    const mentionEmail = screen.getByLabelText('Mentions by email') as HTMLSelectElement;
    expect([...mentionEmail.options].map((option) => option.textContent)).toEqual(['Immediately', 'In the Daily Digest', 'Off']);
    fireEvent.change(mentionEmail, { target: { value: 'daily_digest' } });
    fireEvent.change(screen.getByLabelText('Daily Digest hour'), { target: { value: '21' } });
    expect((screen.getByLabelText('Daily Digest hour') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('21:00');
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }));
    expect(await screen.findByText('Your notification settings were saved. They apply to events from now on.')).toBeTruthy();
    expect(api.writes()[0]!.body).toEqual({ events: { reply: { inApp: false, email: 'off' }, mention: { inApp: true, email: 'daily_digest' } }, dailyDigestHour: 21 });
  });

  it('adds and removes Muted_Projects (R39.10)', async () => {
    const project = (id: string, name: string) => ({ id, name }) as ProjectRecord;
    const api = fakeApi({ 'PUT /me/mutes': { saved: true } });
    renderScreen(<MutedProjectsForm me={makeMe({ mutedProjectIds: ['P1'] })} projects={[project('P1', 'First'), project('P2', 'Second')]} onSaved={() => undefined} />, { client: api.client });
    fireEvent.click(checkbox('Mute First'));
    fireEvent.click(checkbox('Mute Second'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Muted Projects' }));
    await screen.findByText('Your Muted Projects were saved.');
    expect(api.writes()[0]!.body).toEqual({ projectIds: ['P2'] });
  });
});

describe('Profiles and Members', () => {
  it('shows a Profile with its recent Submissions linking to the Items they added (R3.4)', () => {
    renderScreen(<ProfileDetails view={{
      member: { id: OTHER_ID, status: 'revoked' }, profile: { displayName: 'Ben Sample', specialties: [{ id: 'S', name: 'Historian' }], affiliations: ['A society'], biography: '', timeZone: 'Europe/London', publicProfile: false },
      submissions: [{ id: 'SUB', kind: 'item', completedAt: '2026-10-26T08:00:00.000Z', items: [{ id: 'U1', unitType: 'research_item', rootId: 'U1' }, { id: 'R1', unitType: 'reply', rootId: 'U1' }] }],
    }} />, { client: fakeApi({}).client });
    expect(screen.getByRole('alert').textContent).toBe('This Member’s access has been revoked.');
    const recent = screen.getByRole('region', { name: 'Recent Submissions' });
    expect(within(recent).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([['Research Item U1', '/items/U1'], ['Reply R1', '/items/U1']]);
    expect(recent.textContent).toContain('2026-10-26 08:00 UTC');
  });

  const membersApi = () => fakeApi({
    'GET /members': { members: MEMBERS }, 'GET /roles': { roles: BUILT_IN },
    'POST /members/invite': { invited: true }, [`PATCH /members/${OTHER_ID}/role`]: { member: {} }, [`POST /members/${OTHER_ID}/revoke`]: { member: {} },
  });

  it('shows Members without email addresses or actions to a Member whose Role lacks them', async () => {
    renderScreen(<MembersPage />, { client: membersApi().client });
    const table = await screen.findByRole('table');
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Member', 'Role', 'Status']);
    expect(table.textContent).not.toContain('@example.test');
    expect(screen.queryByRole('form', { name: 'Invite a Member' })).toBeNull();
    expect(within(table).getByText('No Profile yet')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Ben Sample' }).getAttribute('href')).toBe(`/members/${OTHER_ID}`);
  });

  it('lets an Administrator invite, change a Role, and revoke after confirming (R2.1)', async () => {
    const api = membersApi();
    renderScreen(<MembersPage />, { client: api.client, administrator: true });
    const invite = await screen.findByRole('form', { name: 'Invite a Member' });
    fireEvent.change(within(invite).getByLabelText(/^Email address/u), { target: { value: 'new@example.test' } });
    fireEvent.change(within(invite).getByLabelText(/^Role/u), { target: { value: ROLE_IDS.contributor } });
    fireEvent.click(within(invite).getByRole('button', { name: 'Send the invitation' }));
    expect(await screen.findByText('An invitation to new@example.test is on its way.')).toBeTruthy();
    expect(api.writes()[0]!.body).toEqual({ email: 'new@example.test', roleId: ROLE_IDS.contributor });

    expect(screen.queryByLabelText('Role of Cy Gone')).toBeNull();
    fireEvent.change(screen.getByLabelText('Role of Ben Sample'), { target: { value: ROLE_IDS.administrator } });
    fireEvent.click(screen.getByRole('button', { name: 'Change the Role of Ben Sample' }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]).toMatchObject({ method: 'PATCH', path: `/members/${OTHER_ID}/role`, body: { roleId: ROLE_IDS.administrator } });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access for Ben Sample' }));
    expect(api.writes()).toHaveLength(2);
    expect(screen.getByText('Revoke Ben Sample’s access? Their records stay.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Ben Sample' }));
    await waitFor(() => expect(api.writes()).toHaveLength(3));
    expect(api.writes()[2]).toMatchObject({ method: 'POST', path: `/members/${OTHER_ID}/revoke` });
    expect(MEMBER_ID).toBe(MEMBERS[0]!.id);
  });
});
