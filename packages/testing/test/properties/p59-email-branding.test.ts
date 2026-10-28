// Feature: research-collab-cms, Property 59: Emails carry the brand and full-address links
import { expect, it } from 'vitest';
import { COLOURS, DEFAULT_ACCENT, FONT_STACKS } from '@researchforce/design/tokens';
import { composeEmail, SENDER_NAME } from '@researchforce/public-render/email/compose';
import { fc } from '../../src/fc';

/** Validates R20.7, R45.21: the sender name, a "ResearchForce:" subject, links whose text is their address, and token styles only. */
const word = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .,]{0,30}$/u);
const address = fc.stringMatching(/^[a-z0-9]{1,12}$/u).map((path) => `https://app.example.test/go/${path}`);
const entryArb = fc.record({ heading: word, lines: fc.array(word, { maxLength: 3 }), notes: fc.array(word, { maxLength: 2 }), url: address }, { requiredKeys: ['heading', 'lines', 'notes'] });
const contentArb = fc.record({ subject: word, intro: word, entries: fc.array(entryArb, { maxLength: 4 }), preferencesUrl: address, closing: fc.array(word, { maxLength: 2 }) }, { requiredKeys: ['subject', 'entries', 'closing'] });

const TOKEN_COLOURS = new Set<string>([...Object.values(COLOURS).flatMap((pair) => [pair.light, pair.dark]), DEFAULT_ACCENT.light, DEFAULT_ACCENT.dark].map((value) => value.toLowerCase()));
const TOKEN_FONTS = new Set<string>(Object.values(FONT_STACKS).flat());

it('every email names the sender, starts its subject with the brand, links with full addresses, and styles from tokens only', () => {
  fc.assert(fc.property(contentArb, (content) => {
    const email = composeEmail(content);
    expect(email.subject.startsWith('ResearchForce: ')).toBe(true);
    expect(email.html).toContain(SENDER_NAME);
    const anchors = [...email.html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/gu)];
    expect(anchors.length).toBe(email.html.split('<a ').length - 1);
    for (const [, href, shown] of anchors) expect(shown).toBe(href);
    const expected = [...content.entries.flatMap((entry) => entry.url ?? []), ...(content.preferencesUrl === undefined ? [] : [content.preferencesUrl])];
    expect(anchors.map(([, href]) => href)).toEqual(expected);
    for (const url of expected) expect(email.text).toContain(url);
    for (const [, colour] of email.html.matchAll(/(?:color|background):(#[0-9a-fA-F]{3,8})/gu)) expect(TOKEN_COLOURS.has(colour!.toLowerCase())).toBe(true);
    for (const [, family] of email.html.matchAll(/font-family:([^;]*);/gu)) {
      for (const name of family!.split(',').map((part) => part.trim().replaceAll("'", ''))) {
        expect(TOKEN_FONTS.has(name) || ['serif', 'sans-serif', 'monospace'].includes(name)).toBe(true);
      }
    }
    if (content.preferencesUrl) expect(email.text).toContain(content.preferencesUrl);
  }));
});
