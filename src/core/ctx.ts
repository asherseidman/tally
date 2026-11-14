import type { Db } from '../db/index';
import type { Clock } from '../clock';

/** Everything a core operation needs. Core modules never read the real clock or settings directly. */
export interface Ctx {
  db: Db;
  clock: Clock;
  tz: string;
  defaultTime: string;
}

export const nowIso = (ctx: Ctx) => ctx.clock.now().toISOString();
