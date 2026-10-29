import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../src/clock';

describe('simulated clock', () => {
  it('advances through a UTC daily budget boundary without waiting', () => {
    const clock = new SimulatedClock('2026-01-01T23:59:59.999Z');
    clock.advanceBy(1);
    expect(new Date(clock.now()).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    clock.advanceTo(Date.parse('2026-01-03T00:00:00Z'));
    expect(new Date(clock.now()).getUTCDate()).toBe(3);
  });

  it('refuses invalid times and backwards movement', () => {
    expect(() => new SimulatedClock('invalid')).toThrow(RangeError);
    const clock = new SimulatedClock(100);
    for (const value of [-1, NaN, Infinity]) expect(() => clock.advanceBy(value)).toThrow(RangeError);
    expect(() => clock.advanceTo(99)).toThrow(RangeError);
    expect(clock.now()).toBe(100);
  });
});
