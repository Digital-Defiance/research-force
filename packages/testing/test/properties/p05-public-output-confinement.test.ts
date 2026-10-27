// Feature: research-collab-cms, Property 5: Public outputs contain only Public_View content
import { expect, it } from 'vitest';
import { fc } from '../../src/fc';
import { PUBLIC_CHANNELS } from '../../src/public-channels';
import { allowedCanaries, canariesIn, workspaceStateArb } from '../../src/workspace';

it('registers the kernel views as the first public channel', () => {
  expect(PUBLIC_CHANNELS[0]?.name).toBe('kernel public views');
});

it('every registered public channel emits only canaries from Public views and Withheld Disclosure_Lines', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const allowed = allowedCanaries(state);
    for (const channel of PUBLIC_CHANNELS) {
      for (const artifact of channel.artifacts(state)) {
        const leaked = canariesIn(artifact.content).filter((token) => !allowed.has(token));
        expect(leaked.map((token) => ({ channel: channel.name, artifact: artifact.name, token, from: state.canaries.get(token) }))).toEqual([]);
      }
    }
  }));
});

it('the generator places a canary in every Member, Party, Project, unit, and Outside_Submission', () => {
  fc.assert(fc.property(workspaceStateArb, (state) => {
    const owners = new Set([...state.canaries.values()].map((entry) => entry.owner));
    for (const member of state.input.members) expect(owners).toContain(`member:${member.id}`);
    for (const party of state.input.parties) expect(owners).toContain(`party:${party.id}`);
    for (const project of state.input.projects) expect(owners).toContain(`p:${project.id}`);
    for (const unit of state.input.units) expect(owners).toContain(`u:${unit.id}`);
    for (const submission of state.outsideSubmissions) expect(owners).toContain(`outside:${submission.id}`);
  }));
});
