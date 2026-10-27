import type { Env } from './env';
export { Budget, Jobs, Mailer, Publisher } from './durable-objects';

export default {
  fetch() {
    // Authentication and API routes are introduced in Task 13. Refuse all requests until then.
    return new Response('Not found', { status: 404 });
  },
  scheduled() {
    // Task 20 wires the transactional outbox and scheduled work.
  },
} satisfies ExportedHandler<Env>;
