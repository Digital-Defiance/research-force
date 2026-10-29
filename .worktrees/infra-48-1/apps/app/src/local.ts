import { createWorker } from './index';
import { localRuntime } from './local/runtime';
export { Budget, Jobs, Publisher } from './durable-objects';
export { LocalServices } from './local/services';
export { LocalMailer as Mailer } from './local/mailer';

// The local runner selects this entrypoint. Deploy tooling refuses it.
export default createWorker(true, localRuntime);
