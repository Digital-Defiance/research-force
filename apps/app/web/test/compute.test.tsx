import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CoverageScreen } from '../src/compute/coverage';
import { artifactStatus, draftOf, EMPTY_PACKAGE, packageBody, parseRanges } from '../src/compute/model';
import type { PackageView } from '../src/compute/model';
import { ComputePanel } from '../src/compute/panel';
import { failure, fakeApi, renderScreen } from './helpers';
import { makeItem } from './fixtures';

const RUN = '01J0000000000000000000RN01';
const ATTEMPT = '01J0000000000000000000RN02';
const SCHEMA = '01J0000000000000000000SC01';
const run = () => makeItem({ id: RUN, kind: 'run', rev: 5 });
const pkg = (overrides: Partial<PackageView> = {}): PackageView => ({
  runId: RUN, version: 2, latest: true, manifestHash: 'b'.repeat(64), state: 'incomplete', stateName: 'Incomplete', createdByName: 'Ada Example', createdAt: '2026-10-20T10:00:00.000Z',
  manifest: {
    code: { repository: 'https://example.org/synthetic/sieve.git', commit: 'a'.repeat(40) }, command: './sieve --range 0:99', usesRandomness: true, configuration: { batch: 64, seed: '12345678901234567890' },
    environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }], artifacts: [],
  },
  artifacts: [
    { role: 'input', type: 'external', uri: 'https://example.org/synthetic/in', held: false, verified: false },
    { role: 'output', type: 'attachment', unitId: '01J0000000000000000000AT01', title: 'Output archive', held: true, verified: false, sha256: 'c'.repeat(64) },
    { role: 'checkpoint', type: 'attachment', unitId: '01J0000000000000000000AT02', title: 'Checkpoint', held: true, verified: true, sha256: 'd'.repeat(64) },
  ],
  missing: [{ ingredient: 'hardware', name: 'The hardware' }, { ingredient: 'seeds', name: 'The random seeds, since randomness is used' }], held: 2, unverified: 1,
  hashVerifiable: false, configurationIntact: true,
  versions: [{ version: 1, state: 'incomplete', createdAt: '2026-10-19T10:00:00.000Z' }, { version: 2, state: 'incomplete', createdAt: '2026-10-20T10:00:00.000Z' }],
  ...overrides,
});
const scope = (overrides: Record<string, unknown> = {}) => ({
  id: '01J0000000000000000000SP01', runId: RUN, runIdentifier: 'RI-1', runTitle: 'Run', packageVersion: 2, manifestHash: 'b'.repeat(64), comparable: true, label: null,
  schema: { id: SCHEMA, name: 'Key ranges', version: 1 }, text: null, assumptions: ['The sieve is exhaustive.'], universe: '200', createdAt: '2026-10-21T10:00:00.000Z', current: true,
  counts: { completed: '100', attempted: '10' }, elimination: { counts: false, reasons: ['run_not_finished', 'outputs_unverified'] },
  entries: [{ state: 'completed', stateName: 'Completed', region: { key: [{ from: '0', to: '49' }, { from: '60', to: '60' }], mode: ['fast'] } }], ...overrides,
});
const SCHEMAS = { schemas: [{ id: SCHEMA, name: 'Key ranges', version: 1, description: null, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '99' }, { kind: 'set', name: 'mode', members: ['fast', 'slow'] }] }] };
const handlers = (extra: Record<string, unknown> = {}) => ({
  [`GET /runs/${RUN}/package`]: { package: pkg() }, [`GET /runs/${RUN}/scope`]: { current: scope(), history: [scope(), scope({ id: '01J0000000000000000000SP00', current: false })] },
  [`GET /runs/${RUN}/reproductions`]: { reproductions: [] }, '/projects': { schemas: [] }, 'GET /projects/*': SCHEMAS, ...extra,
}) as never;

describe('what a package form sends', () => {
  it('leaves blanks out, keeps the configuration exactly, and refuses text that is not JSON', () => {
    const draft = { ...EMPTY_PACKAGE, repository: ' https://example.org/r.git ', command: './run', configuration: '{"seed":"12345678901234567890","n":3}', usesRandomness: true,
      environment: [{ kind: 'toolchain' as const, name: 'rustc', value: '1.86.0' }, { kind: 'hardware' as const, name: '', value: '' }],
      artifacts: [{ role: 'input' as const, type: 'external' as const, unitId: '', uri: 'https://example.org/in', name: '', sha256: '' }, { role: 'output' as const, type: 'attachment' as const, unitId: '', uri: '', name: '', sha256: '' }] };
    expect(packageBody(draft, 4, 2)).toEqual({ body: {
      rev: 4, expectedVersion: 2, code: { repository: 'https://example.org/r.git' }, command: './run', usesRandomness: true, configuration: { seed: '12345678901234567890', n: 3 },
      environment: [{ kind: 'toolchain', name: 'rustc', value: '1.86.0' }], artifacts: [{ type: 'external', role: 'input', uri: 'https://example.org/in' }],
    } });
    expect(packageBody({ ...draft, configuration: '{oops' }, 4, 2)).toEqual({ error: 'The configuration is not valid JSON.' });
    expect(draftOf(pkg()).configuration).toContain('12345678901234567890');
  });
  it('never calls an external reference or a changed file verified', () => {
    expect(artifactStatus({ type: 'external', held: false, verified: false })).toMatch(/does not hold it and has not verified/);
    expect(artifactStatus({ type: 'attachment', held: true, verified: false })).toMatch(/has changed/);
    expect(artifactStatus({ type: 'attachment', held: true, verified: true })).toMatch(/hash matches/);
  });
  it('reads whole-number ranges and refuses anything else', () => {
    expect(parseRanges('0-99, 200')).toEqual({ ranges: [{ from: '0', to: '99' }, { from: '200', to: '200' }] });
    for (const bad of ['-5', '1.5', 'a', '', '1e3']) expect(parseRanges(bad), bad).toHaveProperty('error');
  });
});

describe('the package panel (R56.1, R56.2, R56.6)', () => {
  it('names what is missing, shows the exact description and each artifact’s real status, and offers the export', async () => {
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: fakeApi(handlers()).client });
    await screen.findByText(/Version 2 \(latest\): Incomplete/);
    expect(within(screen.getByRole('list', { name: 'Missing ingredients' })).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['The hardware', 'The random seeds, since randomness is used']);
    expect(screen.getByLabelText('Configuration').textContent).toContain('"seed": "12345678901234567890"');
    const artifacts = within(screen.getByRole('list', { name: 'Inputs, outputs and checkpoints' })).getAllByRole('listitem');
    expect(artifacts[0]!.textContent).toContain('External reference; the archive does not hold it and has not verified it');
    expect(artifacts[1]!.textContent).toContain('the file has changed since it was recorded');
    expect(artifacts[2]!.textContent).toContain('its hash matches the one recorded');
    expect(screen.getByText(/cannot be recomputed from what you see/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Export version 2 as JSON' }).getAttribute('href')).toBe(`/api/v1/runs/${RUN}/package/export?version=2`);
    expect(screen.getByText(/Manifest hash b{64}/)).toBeTruthy();
  });
  it('shows an older version when asked', async () => {
    const api = fakeApi(handlers({ [`GET /runs/${RUN}/package?version=1`]: { package: pkg({ version: 1, latest: false }) } }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    await screen.findByText(/Version 2 \(latest\)/);
    fireEvent.change(screen.getByLabelText('Version shown'), { target: { value: '1' } });
    await screen.findByText(/Version 1: Incomplete/);
  });
  it('offers to record the first package when none exists, and sends the form against the revision the Member saw', async () => {
    const api = fakeApi(handlers({ [`GET /runs/${RUN}/package`]: failure(404, 'not_found'), [`POST /runs/${RUN}/package`]: { package: pkg() }, [`POST /runs/${RUN}/package/validate`]: { valid: true, manifestHash: 'e'.repeat(64), stateName: 'Incomplete', missing: [{ name: 'The hardware' }] } }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    await screen.findByText('No package has been recorded for this Run.');
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: './sieve' } });
    fireEvent.change(screen.getByLabelText('Configuration (JSON)'), { target: { value: '{oops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this version' }));
    await screen.findByText('The configuration is not valid JSON.');
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Configuration (JSON)'), { target: { value: '{"n":3}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check this description' }));
    await screen.findByText(/Still missing: The hardware/);
    expect(api.writes()[0]!.path).toBe(`/runs/${RUN}/package/validate`);
    fireEvent.click(screen.getByRole('button', { name: 'Record this version' }));
    await waitFor(() => expect(api.writes()).toHaveLength(2));
    expect(api.writes()[1]!.body).toMatchObject({ rev: 5, expectedVersion: 0, command: './sieve', configuration: { n: 3 }, usesRandomness: false });
  });
  it('shows a refused secret as the server states it, and sends nothing else', async () => {
    const api = fakeApi(handlers({ [`POST /runs/${RUN}/package`]: failure(422, 'validation', { fields: [{ field: 'configuration.apiKey', rule: 'This key names a secret.' }] }) }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    await screen.findByText(/Version 2 \(latest\)/);
    fireEvent.change(screen.getByLabelText('Configuration (JSON)'), { target: { value: '{"apiKey":"x"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record this version' }));
    await screen.findByText(/This key names a secret/);
  });
});

describe('scopes and independent attempts on the Run page (R56.3, R56.4, R56.5)', () => {
  it('labels a scope that does not count with the reasons, and keeps earlier scopes apart', async () => {
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: fakeApi(handlers()).client });
    const section = await screen.findByRole('region', { name: 'Search scope' });
    await within(section).findAllByText(/Key ranges, version 1, for package version 2/);
    expect(within(section).getAllByText('Its completed work does not count toward elimination.').length).toBeGreaterThan(0);
    expect(within(section).getAllByText('The Run is not Complete or a Clean negative.').length).toBeGreaterThan(0);
    expect(within(section).getAllByText(/key: 0–49, 60; mode: fast/).length).toBeGreaterThan(0);
    expect(within(section).getByText('Earlier scopes (1)')).toBeTruthy();
  });
  it('marks a written description as not comparable', async () => {
    const api = fakeApi(handlers({ [`GET /runs/${RUN}/scope`]: { current: scope({ comparable: false, schema: null, entries: [], counts: null, text: 'Roughly the first thousand keys.', label: 'A written description: not machine-comparable, and never counted toward elimination.' }), history: [] } }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    expect(await screen.findByText(/not machine-comparable/)).toBeTruthy();
    expect(screen.getByText('Roughly the first thousand keys.')).toBeTruthy();
  });
  it('sends a structured scope as exact ranges and refuses a malformed range before sending', async () => {
    const api = fakeApi(handlers({ [`POST /runs/${RUN}/scope`]: { scope: scope() } }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    const form = await screen.findByRole('region', { name: 'Record a scope' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Key ranges, version 1' })).toBeTruthy());
    fireEvent.change(within(form).getByLabelText('Scope schema'), { target: { value: SCHEMA } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add an entry' }));
    fireEvent.change(within(form).getByLabelText('key, entry 1'), { target: { value: '-3' } });
    fireEvent.change(within(form).getByLabelText('mode, entry 1'), { target: { value: 'fast, slow' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this scope' }));
    await within(form).findByText(/not a whole number or a range/);
    expect(api.writes()).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('key, entry 1'), { target: { value: '0-49, 60' } });
    fireEvent.change(within(form).getByLabelText('Assumptions'), { target: { value: 'One.\n\nTwo.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this scope' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({
      rev: 5, packageVersion: 2, assumptions: ['One.', 'Two.'], schema: { id: SCHEMA, version: 1 },
      entries: [{ state: 'completed', region: { key: [{ from: '0', to: '49' }, { from: '60', to: '60' }], mode: ['fast', 'slow'] } }],
    });
  });
  it('lists attempts with their differences and records one by its own Run', async () => {
    const attempt = { id: '01J0000000000000000000RP01', attemptRunId: ATTEMPT, attemptRunIdentifier: 'RI-2', packageVersion: 2, outcome: 'not_reproduced', outcomeName: 'Not reproduced', evidence: [], note: 'Digest differed.', recordedByName: 'Ben Sample', recordedAt: '2026-10-22T10:00:00.000Z', differences: [{ kind: 'hardware', name: 'cpu', original: '8 cores', attempt: '4 cores' }] };
    const api = fakeApi(handlers({
      [`GET /runs/${RUN}/reproductions`]: { reproductions: [attempt] }, [`GET /items/RI-2`]: { item: { id: ATTEMPT } }, [`POST /runs/${RUN}/reproductions`]: { reproduction: attempt },
    }));
    renderScreen(<ComputePanel item={run()} onChanged={() => undefined} />, { client: api.client });
    const list = await screen.findByRole('list', { name: 'Attempts' });
    expect(list.textContent).toContain('Not reproduced by Ben Sample');
    expect(within(list).getByRole('list', { name: 'Differences' }).textContent).toContain('hardware: cpu — original 8 cores; attempt 4 cores');
    const form = screen.getByRole('region', { name: 'Record an independent attempt' });
    fireEvent.change(within(form).getByLabelText('Identifier of your attempt Run'), { target: { value: 'RI-2' } });
    fireEvent.change(within(form).getByLabelText('Outcome'), { target: { value: 'inconclusive' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add a difference' }));
    fireEvent.change(within(form).getByLabelText('What differed 1'), { target: { value: 'cpu' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record this attempt' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toMatchObject({ packageVersion: 2, attemptRunId: ATTEMPT, outcome: 'inconclusive', evidence: [], differences: [{ kind: 'environment', name: 'cpu' }] });
  });
});

describe('the coverage screen (R56.3, R56.4)', () => {
  const coverage = {
    universe: '200', eliminated: '160', fullElimination: false, truncated: false,
    contributions: [
      { scopeId: 'S1', runId: RUN, runIdentifier: 'RI-1', runTitle: 'First', counted: true, reasons: [], completed: '100' },
      { scopeId: 'S2', runId: ATTEMPT, runIdentifier: 'RI-2', runTitle: 'Second', counted: false, reasons: ['run_not_finished'], completed: '100' },
    ],
    incomparable: [{ runId: '01J0000000000000000000RN03', runIdentifier: 'RI-3', runTitle: 'Text only', reason: 'generic_text' }],
  };
  it('states what is covered, why a Run does not count, and keeps incomparable work apart', async () => {
    const api = fakeApi({ [`GET /projects/P1/scope-schemas`]: SCHEMAS, [`GET /projects/P1/coverage?schemaId=${SCHEMA}&version=1`]: { coverage } });
    renderScreen(<CoverageScreen projectId="P1" />, { client: api.client });
    await screen.findByLabelText('Scope schema');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Key ranges, version 1' })).toBeTruthy());
    fireEvent.change(screen.getAllByLabelText('Scope schema')[0]!, { target: { value: SCHEMA } });
    await screen.findByText('160 of 200 points are covered by completed, verified work you can read.');
    expect(screen.getByText(/The whole space is not shown to be covered/)).toBeTruthy();
    const considered = within(screen.getByRole('list', { name: 'Runs considered' })).getAllByRole('listitem');
    expect(considered[0]!.textContent).toContain('counts: 100 points completed');
    expect(considered[1]!.textContent).toContain('does not count: The Run is not Complete or a Clean negative.');
    expect(within(screen.getByRole('list', { name: 'Not comparable' })).getAllByRole('listitem')[0]!.textContent).toContain('written description');
  });
  it('answers incomparable scopes with no numbers and defines the next version of a schema for an editor', async () => {
    const api = fakeApi({
      [`GET /projects/P1/scope-schemas`]: SCHEMAS, [`GET /projects/P1/coverage/compare?a=A&b=B`]: { comparison: { comparable: false, reason: 'different_schema' } }, [`POST /projects/P1/scope-schemas`]: { schema: {} },
    });
    renderScreen(<CoverageScreen projectId="P1" />, { client: api.client, administrator: true });
    await screen.findByLabelText('First scope id');
    fireEvent.change(screen.getByLabelText('First scope id'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Second scope id'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await screen.findByText(/different schemas or versions/);
    fireEvent.change(screen.getByLabelText('Schema name'), { target: { value: 'Key ranges' } });
    fireEvent.change(screen.getByLabelText('Dimension name 1'), { target: { value: 'key' } });
    fireEvent.change(screen.getByLabelText('Largest value 1'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Define this schema' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]!.body).toEqual({ name: 'Key ranges', expectedVersion: 1, dimensions: [{ kind: 'integer', name: 'key', min: '0', max: '99' }] });
  });
  it('gives a reader no way to define a schema', async () => {
    renderScreen(<CoverageScreen projectId="P1" />, { client: fakeApi({ [`GET /projects/P1/scope-schemas`]: SCHEMAS }).client });
    await screen.findByLabelText('First scope id');
    expect(screen.queryByRole('region', { name: 'Define a scope schema' })).toBeNull();
  });
});
