import type { ULID } from '@researchforce/domain/types';
import { composeEmail } from '@researchforce/public-render/email/compose';
import type { EmailMessage } from './provider';

/** The invitation email of a queued `outgoing_emails` row: a login link and nothing about any Item (R2.1, R20.7). */
export async function composeInvitation(db: D1Database, origin: string, emailId: ULID): Promise<EmailMessage | null> {
  const row = await db.prepare("SELECT recipient, kind FROM outgoing_emails WHERE id = ?1").bind(emailId).first<{ recipient: string; kind: string }>();
  if (row === null || row.kind !== 'invitation') return null;
  const composed = composeEmail({
    subject: 'You are invited to join ResearchForce',
    intro: 'You have been invited to join the ResearchForce workspace. Sign in with this address to accept:',
    entries: [{ heading: 'Open ResearchForce', lines: [], url: origin }],
  });
  return { to: row.recipient, subject: composed.subject, html: composed.html, text: composed.text };
}
