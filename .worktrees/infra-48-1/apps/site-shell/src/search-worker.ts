import { createSearchEngine } from '@researchforce/search-public/engine';
import { fetchIndexFile, type WorkerReply, type WorkerRequest } from './search-protocol';

const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage(message: WorkerReply): void };
const engine = createSearchEngine(fetchIndexFile);
scope.onmessage = (event) => {
  const { id, request } = event.data;
  engine.search(request).then((response) => scope.postMessage({ id, response }), () => scope.postMessage({ id, failed: true }));
};
