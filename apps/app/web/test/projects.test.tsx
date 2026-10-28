import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROJECT_ACCENTS } from '@researchforce/design/tokens';
import { RESERVED_PROJECT_SLUGS } from '@researchforce/domain/schemas/people';
import { EditProjectPage, ProjectForm, RESERVED_SLUG_HINT } from '../src/projects/form';
import { ProjectHistory } from '../src/projects/history';
import { ProjectsPage } from '../src/projects/list';
import type { ProjectRecord } from '../src/types';
import { failure, fakeApi, MEMBER_ID, renderScreen } from './helpers';

const project = (position: number, overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: `P${position}`, name: `Project ${position}`, description: 'A synthetic project.', slug: `project-${position}`, slugFixed: false, featured: false, accent: null,
  position, disclosureLevel: 'not_published', disclosureLine: null, createdBy: MEMBER_ID, createdAt: '2026-10-01T00:00:00.000Z', rev: 2, researchItems: position, ...overrides,
});
const PROJECTS = [project(0, { featured: true }), project(1, { muted: true }), project(2)];

describe('creating and editing Projects', () => {
  it('lists the reserved slug names and creates a Project (R39.4)', async () => {
    const api = fakeApi({ 'POST /projects': { project: project(3) } });
    renderScreen(<ProjectForm />, { client: api.client });
    for (const slug of RESERVED_PROJECT_SLUGS) expect(RESERVED_SLUG_HINT).toContain(slug);
    expect(screen.getByText(RESERVED_SLUG_HINT)).toBeTruthy();
    expect(screen.queryByLabelText('Featured')).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: 'Tiles' } });
    fireEvent.change(screen.getByLabelText(/^Short description/u), { target: { value: 'About tiles.' } });
    fireEvent.change(screen.getByLabelText(/^Project Slug/u), { target: { value: 'tiles' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the Project' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/projects'));
    expect(api.writes()[0]!.body).toEqual({ name: 'Tiles', description: 'About tiles.', slug: 'tiles' });
  });

  it('shows a fixed slug as fixed and edits only the changed fields with the revision (R39.5, R45.5)', async () => {
    const api = fakeApi({ 'PATCH /projects/P0': { project: {} } });
    renderScreen(<ProjectForm project={project(0, { slugFixed: true, accent: PROJECT_ACCENTS[0]!.id })} />, { client: api.client });
    expect(screen.queryByLabelText(/^Project Slug/u)).toBeNull();
    expect(screen.getByText('Fixed')).toBeTruthy();
    expect(screen.getByText('The slug is fixed because the Project has appeared on the Public Site.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Featured'));
    fireEvent.click(screen.getByLabelText('No accent'));
    fireEvent.click(screen.getByRole('button', { name: 'Save the Project' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ rev: 2, featured: true, accent: null });
  });

  it('offers only the palette accents and none (R45.4)', () => {
    renderScreen(<ProjectForm project={project(1)} />, { client: fakeApi({}).client });
    const accents = screen.getByRole('group', { name: 'Accent colour' });
    expect(within(accents).getAllByRole('radio').map((radio) => radio.parentElement!.textContent)).toEqual(['No accent', ...PROJECT_ACCENTS.map((accent) => accent.name)]);
    expect((screen.getByLabelText('No accent') as HTMLInputElement).checked).toBe(true);
  });

  it('keeps the input after a conflict', async () => {
    const api = fakeApi({ 'PATCH /projects/P1': failure(409, 'conflict', { details: { rev: 3 } }) });
    renderScreen(<ProjectForm project={project(1)} />, { client: api.client });
    fireEvent.change(screen.getByLabelText(/^Name/u), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the Project' }));
    expect(await screen.findByText('Someone saved a change to this Project after you opened it. Your input was not saved; it is kept below.')).toBeTruthy();
    expect((screen.getByLabelText(/^Name/u) as HTMLInputElement).value).toBe('Renamed');
  });

  it('says so when the Project to edit does not exist', async () => {
    renderScreen(<EditProjectPage id="P9" />, { client: fakeApi({ 'GET /projects': { projects: PROJECTS } }).client });
    expect(await screen.findByText('This Project does not exist.')).toBeTruthy();
  });
});

describe('the Project_Order', () => {
  it('moves a Project with buttons to the adjacent position (R39.7)', async () => {
    const api = fakeApi({ 'GET /projects': { projects: PROJECTS }, 'POST /projects/P1/move-position': { moved: true }, 'POST /projects/P2/move-position': { moved: true } });
    renderScreen(<ProjectsPage />, { client: api.client, administrator: true });
    const order = await screen.findByRole('list', { name: 'Project order' });
    expect(within(order).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent)).toEqual(['Project 0', 'Project 1', 'Project 2']);
    expect((screen.getByRole('button', { name: 'Move Project 0 up' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Move Project 2 down' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move Project 1 up' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Move Project 1 down' }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes().map((call) => [call.path, call.body])).toEqual([['/projects/P1/move-position', { position: 0 }], ['/projects/P1/move-position', { position: 2 }]]);
    expect(order.textContent).toContain('Featured');
    expect(order.textContent).toContain('Muted');
    expect(order.textContent).toContain('/project-2 · Not published · 2 Research Items');
  });

  it('moves a dragged Project to the position it is dropped on', async () => {
    const api = fakeApi({ 'GET /projects': { projects: PROJECTS }, 'POST /projects/P2/move-position': { moved: true } });
    renderScreen(<ProjectsPage />, { client: api.client, administrator: true });
    const items = within(await screen.findByRole('list', { name: 'Project order' })).getAllByRole('listitem');
    const dataTransfer = { effectAllowed: '', setData: () => undefined };
    fireEvent.dragStart(items[2]!, { dataTransfer });
    expect(items[2]!.getAttribute('aria-grabbed')).toBe('true');
    fireEvent.dragOver(items[0]!, { dataTransfer });
    fireEvent.drop(items[0]!, { dataTransfer });
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toMatchObject({ path: '/projects/P2/move-position', body: { position: 0 } });
    fireEvent.drop(items[1]!, { dataTransfer });
    expect(api.writes()).toHaveLength(1);
  });

  it('shows the order without move or edit controls to a Member whose Role lacks them', async () => {
    renderScreen(<ProjectsPage />, { client: fakeApi({ 'GET /projects': { projects: PROJECTS } }).client });
    const order = await screen.findByRole('list', { name: 'Project order' });
    expect(within(order).queryAllByRole('button')).toEqual([]);
    expect(within(order).getAllByRole('link').map((link) => link.textContent)).toEqual(['History of Project 0', 'History of Project 1', 'History of Project 2']);
    expect(screen.queryByRole('link', { name: 'Create a Project' })).toBeNull();
    expect(within(order).getAllByRole('listitem')[0]!.getAttribute('draggable')).toBe('false');
  });
});

describe('the Project history', () => {
  it('shows each Revision newest first with its fields before and after, and the creation (R39.18)', () => {
    renderScreen(<ProjectHistory entries={[
      { kind: 'correction', memberId: MEMBER_ID, displayName: 'Ada Example', at: '2026-10-03T10:00:00.000Z', reason: 'Wrong name.', changes: [{ field: 'name', before: 'Tils', after: 'Tiles' }, { field: 'featured', before: false, after: true }] },
      { kind: 'minor_edit', memberId: MEMBER_ID, displayName: null, at: '2026-10-02T10:00:00.000Z', changes: [{ field: 'position', before: 2, after: 0 }, { field: 'accent', before: null, after: 'teal' }, { field: 'disclosureLevel', before: 'not_published', after: 'public' }] },
      { kind: 'creation', memberId: MEMBER_ID, displayName: 'Ada Example', at: '2026-10-01T10:00:00.000Z', values: { name: 'Tils', slug: 'tiles' } },
    ]} />, { client: fakeApi({}).client });
    const entries = screen.getAllByRole('listitem').filter((item) => item.classList.contains('rf-section'));
    expect(entries.map((entry) => [...entry.querySelectorAll('p, li')].map((line) => line.textContent))).toEqual([
      ['Correction by Ada Example at 2026-10-03 10:00 UTC', 'Reason: Wrong name.', 'Name: Tils → Tiles', 'Featured: off → on'],
      ['Minor edit by a Member without a display name at 2026-10-02 10:00 UTC', 'Position: 3 → 1', 'Accent colour: none → teal', 'Disclosure level: Not published → Public'],
      ['Creation by Ada Example at 2026-10-01 10:00 UTC', 'Name: Tils', 'Project Slug: tiles'],
    ]);
    expect(within(entries[0]!).getByRole('link', { name: 'Ada Example' }).getAttribute('href')).toBe(`/members/${MEMBER_ID}`);
  });
});
