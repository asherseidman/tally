import type { Ctx } from '../core/ctx';
import { runningTimers, stopAll, type RunningTimer } from './timerOps';

/**
 * What happens to a running timer when the app quits. The Electron side (dialog, app.quit) lives in electron/main.ts; this is the
 * decision, kept free of Electron so it can be tested against a real database file, including reopening it afterwards.
 *   stop   - end the session now and record its time
 *   keep   - leave the session open in the database: it keeps counting while the app is closed and is still running after a restart
 *   cancel - do not quit
 */
export type QuitChoice = 'stop' | 'keep' | 'cancel';
export interface QuitResult {
  action: 'quit' | 'cancel';
  choice: QuitChoice | null;
  running: RunningTimer[];
  stopped: { taskId: number; minutes: number; total: number }[];
}

export async function resolveQuit(
  ctx: Ctx | undefined,
  ask: (running: RunningTimer[]) => Promise<QuitChoice>,
  trace: (msg: string) => void = () => {},
): Promise<QuitResult> {
  const running = ctx ? runningTimers(ctx) : [];
  if (!ctx || running.length === 0) {
    trace('no timer is running: quitting without asking');
    return { action: 'quit', choice: null, running, stopped: [] };
  }
  trace(`${running.length} timer(s) running (session ${running.map((r) => `#${r.sessionId}`).join(', ')}): asking what to do`);
  let choice: QuitChoice;
  try {
    choice = await ask(running);
  } catch (e) {
    // if the question itself fails, the safe answer is not to quit: nothing is lost and the person can try again
    trace(`the question failed (${(e as Error).message}): not quitting`);
    return { action: 'cancel', choice: 'cancel', running, stopped: [] };
  }
  trace(`answer: ${choice}`);
  if (choice === 'cancel') return { action: 'cancel', choice, running, stopped: [] };
  const stopped = choice === 'stop' ? stopAll(ctx) : [];
  if (choice === 'keep') trace(`leaving session(s) ${running.map((r) => `#${r.sessionId}`).join(', ')} open in the database`);
  return { action: 'quit', choice, running, stopped };
}
