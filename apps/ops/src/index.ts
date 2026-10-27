import { WorkerEntrypoint } from 'cloudflare:workers';

// No fetch handler or public route. Narrow RPC methods are introduced in later tasks.
export default class Ops extends WorkerEntrypoint {}
