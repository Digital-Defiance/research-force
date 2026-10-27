export interface Clock {
  now(): number;
}

/** Deterministic epoch-millisecond clock; no real timers or wall-clock sleeps. */
export class SimulatedClock implements Clock {
  #time: number;

  constructor(initial: number | string = 0) {
    this.#time = typeof initial === 'string' ? Date.parse(initial) : initial;
    if (!Number.isFinite(this.#time)) throw new RangeError('Clock needs a valid initial time.');
  }

  now(): number { return this.#time; }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('Clock advance must be finite and non-negative.');
    this.advanceTo(this.#time + milliseconds);
  }

  advanceTo(time: number): void {
    if (!Number.isFinite(time) || time < this.#time) throw new RangeError('Clock cannot move backwards.');
    this.#time = time;
  }
}
