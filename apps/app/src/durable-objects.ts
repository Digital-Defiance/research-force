import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

// Storage/binding scaffolds only. Each owner gains its behavior in its feature task.
export class Publisher extends DurableObject<Env> {}
export class Mailer extends DurableObject<Env> {}
export class Budget extends DurableObject<Env> {}
export class Jobs extends DurableObject<Env> {}
