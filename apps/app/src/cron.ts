import type { Timestamp } from '@researchforce/domain/types';
import type { Env } from './env';
import type { Logger } from './log';
import { kickAll } from './outbox';
import { sweepStages } from './records/stages';

/** The two Cron Triggers in `wrangler.jsonc` (design "Cron Triggers"). */
export const EVERY_MINUTE = '* * * * *';
export const HOURLY = '7 * * * *';

export interface Sweep {
  readonly name: string;
  /** Remove what is due at `now` and return how many records went. */
  run(env: Env, now: Timestamp): Promise<number>;
}

/** The hourly sweeps in order; each feature adds its own. */
export const HOURLY_SWEEPS: readonly Sweep[] = [
  { name: 'staging_rows', run: (env, now) => sweepStages(env.RF_CORE, now) },
];

/** Run every sweep; one that fails is logged and the rest still run. */
export async function runSweeps(env: Env, now: Timestamp, log: Logger, sweeps: readonly Sweep[] = HOURLY_SWEEPS): Promise<void> {
  for (const sweep of sweeps) {
    try {
      log('info', 'sweep', { sweep: sweep.name, removed: await sweep.run(env, now) });
    } catch (error) {
      log('error', 'sweep_failed', { sweep: sweep.name, error });
    }
  }
}

export async function runScheduled(cron: string, env: Env, scheduledAt: Date, log: Logger): Promise<void> {
  if (cron === EVERY_MINUTE) await kickAll(env, log);
  else if (cron === HOURLY) await runSweeps(env, scheduledAt.toISOString() as Timestamp, log);
  else log('warn', 'cron_unknown', { cron });
}
