// Feature: research-collab-cms, Property 9: Companion fields are rendered together
import { expect, it } from 'vitest';
import { project } from '@researchforce/kernel/project';
import type { ResearchItemView } from '@researchforce/kernel/views';
import { composeEmail } from '@researchforce/public-render/email/compose';
import { emailEntryFor } from '@researchforce/public-render/email/views';
import { fc } from '../../src/fc';
import { EMAIL_ORIGIN } from '../../src/public-channels';
import { workspaceStateArb } from '../../src/workspace';

/**
 * Validates R5.6, R5.10, R6.3, R7.4, R8.3, R29.2 to R29.4, R43.3 for the email channel: where an Item's Public_View carries a status
 * with companion fields, the email shows them together, in the order the status, then the companion text.
 */
it('an email shows each status with its companion fields, the Elimination_Scope after Eliminated and the scope and caveats of a Finding', () => {
  let checked = 0;
  fc.assert(fc.property(workspaceStateArb, (state) => {
    for (const view of project(state.input).values()) {
      if (view.tag !== 'research_item' || !view.status) continue;
      const item: ResearchItemView = view;
      const entry = emailEntryFor(item, EMAIL_ORIGIN)!;
      const { text } = composeEmail({ subject: 'x', entries: [entry] });
      const status = item.status!;
      const companion = status.kind === 'hypothesis' ? status.eliminationScope : status.kind === 'finding' ? status.scopeCaveat : undefined;
      if (status.kind === 'hypothesis' || status.kind === 'finding') {
        expect(text).toContain(`Status: ${status.status.name}`);
        if (companion !== undefined) {
          expect(text.indexOf(companion.text)).toBeGreaterThan(text.indexOf(`Status: ${status.status.name}`));
          checked += 1;
        } else expect(text).not.toContain(status.kind === 'hypothesis' ? 'Elimination scope' : 'Scope and caveats');
      }
      if (status.kind === 'run') expect(text).toContain(`Tool: ${status.toolName} ${status.toolVersion}`);
    }
  }));
  expect(checked).toBeGreaterThan(0);
});
