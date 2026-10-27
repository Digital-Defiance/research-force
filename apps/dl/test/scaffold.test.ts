import { expect, it } from 'vitest';
import worker from '../src/index';

it('refuses downloads until token verification is implemented', () => {
  expect(worker.fetch().status).toBe(404);
});
