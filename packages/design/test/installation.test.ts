import { describe, expect, it } from 'vitest';
import {
  PublicCopyError, assertPublicCopy, publicCopyDigest, validatePublicCopy,
  type InstallationPublicCopy,
} from '../src/installation';
import { RESEARCHFORCE_PUBLIC_COPY } from '../src/researchforce-copy';

/** A complete, visibly synthetic bundle; tests mutate copies of it to exercise each rejection. */
const COMPLETE: InstallationPublicCopy = {
  version: '2026-03-04',
  name: 'Example Collective',
  strapline: 'A synthetic strapline',
  mission: { heading: 'Our mission', paragraphs: ['We study synthetic questions.', 'We keep a synthetic record.'] },
  about: ['The Example Collective is a fixture.', 'It has synthetic members.'],
  principles: [
    { name: 'First', text: 'The first synthetic principle.' },
    { name: 'Second', text: 'The second synthetic principle.' },
  ],
};

describe('validatePublicCopy', () => {
  it('accepts a complete bundle', () => {
    expect(validatePublicCopy(COMPLETE)).toEqual([]);
  });

  it('refuses a missing bundle with a single actionable issue', () => {
    for (const missing of [undefined, null]) {
      const issues = validatePublicCopy(missing);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.field).toBe('publicCopy');
    }
  });

  it('rejects a missing or blank masthead name, strapline, or version', () => {
    const fields = (copy: InstallationPublicCopy): string[] => validatePublicCopy(copy).map((issue) => issue.field);
    expect(fields({ ...COMPLETE, name: '   ' })).toContain('name');
    expect(fields({ ...COMPLETE, strapline: '' })).toContain('strapline');
    expect(fields({ ...COMPLETE, version: '' })).toContain('version');
    expect(fields({ ...COMPLETE, version: 'not-a-date' })).toContain('version');
  });

  it('rejects a missing mission heading, an empty mission, or a blank mission paragraph', () => {
    const fields = (copy: InstallationPublicCopy): string[] => validatePublicCopy(copy).map((issue) => issue.field);
    expect(fields({ ...COMPLETE, mission: { heading: ' ', paragraphs: ['A paragraph.'] } })).toContain('mission.heading');
    expect(fields({ ...COMPLETE, mission: { heading: 'Mission', paragraphs: [] } })).toContain('mission.paragraphs');
    expect(fields({ ...COMPLETE, mission: { heading: 'Mission', paragraphs: ['ok', '   '] } })).toContain('mission.paragraphs.1');
  });

  it('rejects empty or blank About prose', () => {
    const fields = (copy: InstallationPublicCopy): string[] => validatePublicCopy(copy).map((issue) => issue.field);
    expect(fields({ ...COMPLETE, about: [] })).toContain('about');
    expect(fields({ ...COMPLETE, about: ['ok', ''] })).toContain('about.1');
  });

  it('rejects an empty principle list', () => {
    expect(validatePublicCopy({ ...COMPLETE, principles: [] }).map((issue) => issue.field)).toContain('principles');
  });

  it('rejects a principle with a missing name or text', () => {
    const fields = (copy: InstallationPublicCopy): string[] => validatePublicCopy(copy).map((issue) => issue.field);
    expect(fields({ ...COMPLETE, principles: [{ name: '', text: 'has text' }] })).toContain('principles.0.name');
    expect(fields({ ...COMPLETE, principles: [{ name: 'Named', text: '  ' }] })).toContain('principles.0.text');
  });

  it('rejects a duplicate principle name, compared case-insensitively on the trimmed name', () => {
    const issues = validatePublicCopy({ ...COMPLETE, principles: [{ name: 'Open', text: 'a' }, { name: ' open ', text: 'b' }] });
    expect(issues.map((issue) => issue.field)).toContain('principles.1.name');
  });

  it('collects every issue rather than stopping at the first', () => {
    const issues = validatePublicCopy({ ...COMPLETE, name: '', strapline: '', principles: [] });
    expect(issues.map((issue) => issue.field).sort()).toEqual(['name', 'principles', 'strapline']);
  });
});

describe('publicCopyDigest', () => {
  it('is a 64-character lowercase hex SHA-256', () => {
    expect(publicCopyDigest(COMPLETE)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is stable for equal content and changes when any content or the version changes', () => {
    const base = publicCopyDigest(COMPLETE);
    expect(publicCopyDigest({ ...COMPLETE })).toBe(base);
    expect(publicCopyDigest({ ...COMPLETE, strapline: 'A different strapline' })).not.toBe(base);
    expect(publicCopyDigest({ ...COMPLETE, version: '2027-01-01' })).not.toBe(base);
    expect(publicCopyDigest({ ...COMPLETE, principles: [COMPLETE.principles[0]!] })).not.toBe(base);
  });
});

describe('assertPublicCopy', () => {
  it('returns the bundle with its digest when valid', () => {
    const validated = assertPublicCopy(COMPLETE);
    expect(validated.digest).toBe(publicCopyDigest(COMPLETE));
    expect(validated.name).toBe(COMPLETE.name);
  });

  it('throws a PublicCopyError listing every issue when invalid', () => {
    expect(() => assertPublicCopy(undefined)).toThrow(PublicCopyError);
    try {
      assertPublicCopy({ ...COMPLETE, name: '', principles: [] });
    } catch (error) {
      expect(error).toBeInstanceOf(PublicCopyError);
      expect((error as PublicCopyError).issues.map((issue) => issue.field).sort()).toEqual(['name', 'principles']);
    }
  });
});

describe('the ResearchForce.org bundle', () => {
  it('is encoded verbatim from the content doc and passes validation', () => {
    expect(validatePublicCopy(RESEARCHFORCE_PUBLIC_COPY)).toEqual([]);
    expect(RESEARCHFORCE_PUBLIC_COPY.name).toBe('Research Force');
    expect(RESEARCHFORCE_PUBLIC_COPY.strapline).toBe('Independent research, on the record');
    expect(RESEARCHFORCE_PUBLIC_COPY.principles).toHaveLength(7);
    expect(RESEARCHFORCE_PUBLIC_COPY.principles.map((principle) => principle.name)).toEqual([
      'Independence', 'For its own sake', 'Provenance first', 'Keep the whole record', 'Credit every contributor', 'Consent before publication', 'Open to correction',
    ]);
    expect(assertPublicCopy(RESEARCHFORCE_PUBLIC_COPY).digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
