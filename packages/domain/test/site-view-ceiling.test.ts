import { describe, expect, it } from 'vitest';
import { FREE_PLAN_SITE_VIEW_CEILING, siteViewCeiling } from '../src/slice-budget';

describe('siteViewCeiling', () => {
  it('accepts a positive integer and falls back to the Free-plan default otherwise', () => {
    expect(siteViewCeiling('4000')).toBe(4000);
    expect(siteViewCeiling(' 1200 ')).toBe(1200);
    for (const bad of [undefined, '', 'abc', '0', '-5', '1.5', '1e3', '9999999999']) expect(siteViewCeiling(bad)).toBe(FREE_PLAN_SITE_VIEW_CEILING);
    expect(FREE_PLAN_SITE_VIEW_CEILING).toBe(750);
  });
});
