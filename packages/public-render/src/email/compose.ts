import { COLOURS, DEFAULT_ACCENT, FONT_STACKS } from '@researchforce/design/tokens';
import { escapeHtml } from '@researchforce/design/render-string';

/** The sender's display name, and the start of every subject (R20.7, R45.21). */
export const SENDER_NAME = 'ResearchForce';
export const SUBJECT_PREFIX = 'ResearchForce: ';

/** One thing an email tells about: an Item, an Outside_Submission, or an alert. */
export interface EmailEntry {
  /** What it is, as its Public_View allows: the kind and the title, the Disclosure_Line, or only the kind. */
  readonly heading: string;
  /** What happened: the Event_Type, the acting Member, and the time in the recipient's zone. */
  readonly lines: readonly string[];
  /** Text that belongs with the heading, such as an Elimination_Scope, a Group_Note view, or a Log_Summary with its Dissent_Notes. */
  readonly notes?: readonly string[];
  /** The login address that opens it; it is shown in full wherever it is linked. */
  readonly url?: string;
}
export interface EmailContent {
  /** The subject without the brand prefix. */
  readonly subject: string;
  readonly intro?: string;
  readonly entries: readonly EmailEntry[];
  /** Every Member email ends with a link to the Notification_Preferences (R20.7). */
  readonly preferencesUrl?: string;
  readonly closing?: readonly string[];
}
export interface ComposedEmail { readonly subject: string; readonly text: string; readonly html: string }

const text = COLOURS.text.light;
const muted = COLOURS['text-muted'].light;
const rule = COLOURS['border-subtle'].light;
const surface = COLOURS.surface.light;
const bodyFont = FONT_STACKS.body.map((family) => `'${family}'`).join(', ') + ', serif';
const uiFont = FONT_STACKS.ui.map((family) => `'${family}'`).join(', ') + ', sans-serif';

/** A link whose visible text is its full address (R20.7). */
export function addressLink(url: string): string {
  return `<a href="${escapeHtml(url)}" style="color:${DEFAULT_ACCENT.light};">${escapeHtml(url)}</a>`;
}

const paragraph = (value: string, colour: string = text): string => `<p style="margin:0 0 8px 0;color:${colour};font-family:${bodyFont};font-size:17px;line-height:1.6;">${escapeHtml(value)}</p>`;

/**
 * The email as plain text first, and the HTML from the same structure: the text is what a reader without markup sees, and the
 * HTML adds only inline styles from the Design_System's typefaces and colours (R20.7, R45.21).
 */
export function composeEmail(content: EmailContent): ComposedEmail {
  const plain: string[] = [];
  if (content.intro) plain.push(content.intro, '');
  for (const entry of content.entries) {
    plain.push(entry.heading, ...entry.lines.map((line) => `  ${line}`), ...(entry.notes ?? []).map((note) => `  ${note}`));
    if (entry.url) plain.push(`  ${entry.url}`);
    plain.push('');
  }
  for (const line of content.closing ?? []) plain.push(line);
  if (content.preferencesUrl) plain.push('Change which emails you receive:', content.preferencesUrl);

  const blocks = content.entries.map((entry) => [
    `<div style="margin:0 0 16px 0;padding:0 0 12px 0;border-bottom:1px solid ${rule};">`,
    `<p style="margin:0 0 4px 0;color:${text};font-family:${uiFont};font-size:15px;font-weight:600;line-height:1.4;">${escapeHtml(entry.heading)}</p>`,
    ...entry.lines.map((line) => paragraph(line, muted)),
    ...(entry.notes ?? []).map((note) => paragraph(note)),
    ...(entry.url ? [`<p style="margin:0;font-family:${uiFont};font-size:15px;">${addressLink(entry.url)}</p>`] : []),
    '</div>',
  ].join(''));
  const html = [
    `<div style="background:${surface};color:${text};font-family:${bodyFont};padding:16px;">`,
    `<p style="margin:0 0 16px 0;color:${DEFAULT_ACCENT.light};font-family:${uiFont};font-size:15px;font-weight:700;">${SENDER_NAME}</p>`,
    ...(content.intro ? [paragraph(content.intro)] : []),
    ...blocks,
    ...(content.closing ?? []).map((line) => paragraph(line, muted)),
    ...(content.preferencesUrl ? [`<p style="margin:16px 0 0 0;color:${muted};font-family:${uiFont};font-size:14px;">Change which emails you receive: ${addressLink(content.preferencesUrl)}</p>`] : []),
    '</div>',
  ].join('');
  return { subject: `${SUBJECT_PREFIX}${content.subject}`, text: plain.join('\n').trimEnd(), html };
}
