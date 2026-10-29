import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
export { Jobs } from './do/jobs';
export { Mailer } from './do/mailer';

// Storage/binding scaffolds only. Each owner gains its behavior in its feature task; until then the
// rows of its outbox topic stay pending.
export class Publisher extends DurableObject<Env> {
  async kick(): Promise<void> {}
}
export class Budget extends DurableObject<Env> {}
