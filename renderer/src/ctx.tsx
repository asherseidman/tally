import { createContext, useContext } from 'react';
import type { AppInfo } from '../../src/app/types';

export interface AppCtx {
  info: AppInfo;
  /** bumps after any change, so every screen reloads its data */
  version: number;
  changed: () => void;
  openTask: (id: number) => void;
  /** a transient message shown at the bottom of the window */
  toast: (msg: string, action?: { label: string; run: () => void }) => void;
}
export const Ctx = createContext<AppCtx>(null as never);
export const useApp = () => useContext(Ctx);

export const fmtMinutes = (m: number | null) => (m == null ? '' : m >= 90 ? `~${Math.round((m / 60) * 2) / 2}h` : `~${m}m`);
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** the machine-readable code of an API error, when it has one (google_reconnect: offer a Reconnect button) */
export const errCode = (e: unknown): string | undefined => (e && typeof e === 'object' && 'code' in e ? String((e as { code?: unknown }).code ?? '') || undefined : undefined);
