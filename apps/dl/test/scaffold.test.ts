import { expect, it } from 'vitest';
import { notFound } from '../src/index';
it('uses the same refusal as an unknown path', () => { expect(notFound().status).toBe(404); });
