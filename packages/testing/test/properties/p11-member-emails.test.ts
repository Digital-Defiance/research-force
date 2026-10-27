// Feature: research-collab-cms, Property 11: Member email addresses never appear publicly
import { expect, it } from 'vitest';
import { SEED_POLICY_SECTIONS, type SeedPolicySection } from '@researchforce/db/seed/policy-sections';
import type { MemberStatus, ULID } from '@researchforce/domain/types';
import type { MemberRecord, UnitRecord } from '@researchforce/kernel/input';
import { projectDetailed } from '@researchforce/kernel/project';
import { EMAIL_PLACEHOLDER, projectPolicyText, projectProfile } from '@researchforce/kernel/substitute';
import { canonicalJson, type PublicView } from '@researchforce/kernel/views';
import { POLICY_PAGE_KEYS } from '@researchforce/public-render/site';
import { fc } from '../../src/fc';
import { collapsed } from '../../src/html';
import { publicOutput } from '../../src/public-output';
import { canariesIn, workspaceStateArb, type WorkspaceState } from '../../src/workspace';

const LATE_EMAIL = 'Late.Member@Example.test';
const cased = (email: string, variant: number): string => [email.toLowerCase(), email.toUpperCase(), email][variant % 3]!;

/** Each registered address, in any letter case, replaced by the placeholder; longer addresses first. */
function scrubbed(text: string, emails: readonly string[]): string {
  const sorted = [...new Set(emails.map((email) => email.toLowerCase()))].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  let output = '';
  for (let index = 0; index < text.length;) {
    const email = sorted.find((candidate) => lower.startsWith(candidate, index));
    if (email === undefined) output += text[index++];
    else { output += EMAIL_PLACEHOLDER; index += email.length; }
  }
  return output;
}

const occurrences = (text: string): number => text.split(EMAIL_PLACEHOLDER).length - 1;
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return typeof value === 'object' && value !== null ? Object.values(value).flatMap(strings) : [];
}
const valueAt = (value: unknown, path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>((current, step) => (current as Record<string | number, unknown> | undefined)?.[step], value);

/** Text written before a Member with this address joined: the Member is added after the text, in any Member_Status. */
const stateArb = fc.tuple(workspaceStateArb, fc.constantFrom<MemberStatus>('active', 'pending', 'revoked'), fc.nat(), fc.nat()).map(([state, status, variant, target]): WorkspaceState => {
  const { input } = state;
  const written = ` or ${cased(LATE_EMAIL, variant)}`;
  const at = target % input.units.length;
  const units = input.units.map((unit, index): UnitRecord => {
    if (index !== at) return unit;
    switch (unit.type) {
      case 'research_item': return { ...unit, item: { ...unit.item, title: unit.item.title + written } };
      case 'attachment': return { ...unit, attachment: { ...unit.attachment, title: unit.attachment.title + written } };
      default: return { ...unit, text: { ...unit.text, text: unit.text.text + written } };
    }
  });
  const projects = input.projects.map((entry, index) => (index === 0 ? { ...entry, description: entry.description + written } : entry));
  const late: MemberRecord = { id: `01M${'9'.repeat(23)}` as ULID, displayName: 'Late Member', email: LATE_EMAIL, status, publicProfile: false };
  const profiles = new Map([...state.profiles].map(([id, profile], index) => [id, index === 0 ? { ...profile, biography: profile.biography + written } : profile]));
  return { ...state, input: { ...input, units, projects, members: [...input.members, late] }, profiles };
});

it('no registered Member address appears publicly in any case: each occurrence becomes the placeholder, and the previews mark each one', () => {
  fc.assert(fc.property(stateArb, fc.nat(), (state, variant) => {
    const { input } = state;
    const emails = input.members.map((member) => member.email);
    const policySections: SeedPolicySection[] = [
      ...SEED_POLICY_SECTIONS,
      ...POLICY_PAGE_KEYS.map((pageKey, index): SeedPolicySection => ({
        pageKey, sectionKey: `contact_${pageKey}`, title: 'Contact', required: false,
        text: `Write to ${emails.map((email, offset) => cased(email, variant + index + offset)).join(' or ')}.`,
      })),
    ];
    const out = publicOutput(state, { policySections });

    // The addresses reach no public output, in any letter case.
    const profiles = [...state.profiles].flatMap(([, profile]) => projectProfile(profile, emails) ?? []);
    const outputs = [
      ...out.files.values(), ...out.index.map((file) => file.content), ...[...out.site.views.values()].map(canonicalJson), ...profiles.map((entry) => canonicalJson(entry.view)),
    ].map((content) => content.toLowerCase());
    const localParts = emails.flatMap((email) => canariesIn(email));
    for (const content of outputs) {
      for (const email of emails) expect(content.includes(email.toLowerCase()), email).toBe(false);
      for (const token of localParts) expect(content.includes(token), token).toBe(false);
    }

    // Every occurrence becomes the placeholder.
    const units = new Map(input.units.map((unit) => [`u:${unit.id}`, unit]));
    const projects = new Map(input.projects.map((entry) => [`p:${entry.id}`, entry]));
    const pairs = (view: PublicView): [string | undefined, string | undefined][] => {
      if (view.tag === 'project') { const record = projects.get(view.key)!; return [[view.name, record.name], [view.description, record.description]]; }
      const unit = units.get(view.key);
      if (unit === undefined) return [];
      switch (view.tag) {
        case 'research_item': {
          const { item } = unit as Extract<UnitRecord, { type: 'research_item' }>;
          return [[view.title, item.title], [view.publicSummary?.text, item.publicSummary?.text], [view.withdrawal?.reason, unit.withdrawal?.reason],
            ...(view.full ? [[view.full.logSummary?.text, item.logSummary?.text] as [string | undefined, string | undefined]] : [])];
        }
        case 'attachment': {
          const file = (unit as Extract<UnitRecord, { type: 'attachment' }>).attachment;
          return [[view.title, file.title], [view.caption, file.caption], [view.origin, file.origin]];
        }
        case 'entry_section': case 'reply': case 'dissent_note': return [[view.text.text, (unit as { text: { text: string } }).text.text]];
        default: return [];
      }
    };
    for (const view of out.site.views.values()) for (const [shown, stored] of pairs(view)) expect(shown, view.key).toBe(stored === undefined ? undefined : scrubbed(stored, emails));
    for (const [id, profile] of state.profiles) {
      const projected = projectProfile(profile, emails);
      if (projected !== undefined) expect(projected.view.biography, id).toBe(scrubbed(profile.biography, emails));
    }
    const policyText = [...out.pages.values()].map((page) => page.mainText).join('\n');
    for (const section of policySections.slice(SEED_POLICY_SECTIONS.length)) expect(policyText).toContain(collapsed(scrubbed(section.text, emails)));

    // The previews mark each replacement, at the placeholder it left.
    const projection = projectDetailed(input);
    for (const [key, view] of projection.views) {
      const marks = projection.emailMarks.get(key) ?? [];
      for (const mark of marks) expect((valueAt(view, mark.path) as string).slice(mark.start, mark.end), `${key} ${mark.path.join('.')}`).toBe(EMAIL_PLACEHOLDER);
      expect(marks.length, key).toBe(strings(view).reduce((sum, text) => sum + occurrences(text), 0));
    }
    for (const entry of profiles) expect(entry.marks.length).toBe(strings(entry.view).reduce((sum, text) => sum + occurrences(text), 0));
    for (const section of policySections) {
      const projected = projectPolicyText({ text: section.text, spans: [] }, emails);
      for (const mark of projected.marks) expect(projected.text.text.slice(mark.start, mark.end)).toBe(EMAIL_PLACEHOLDER);
      expect(projected.marks.length).toBe(occurrences(projected.text.text));
    }
  }));
});
