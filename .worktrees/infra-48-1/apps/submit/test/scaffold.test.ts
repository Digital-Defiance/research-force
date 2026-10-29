import { expect, it } from 'vitest';
import worker from '../src/index';

it('refuses public submissions until budget and validation gates are implemented', () => {
  expect(worker.fetch().status).toBe(404);
});
