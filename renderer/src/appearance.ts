import { api } from './api';

/**
 * The color scheme. The default (Blue and Maize) is the static stylesheet; any other scheme is a small stylesheet injected
 * after it that overrides the color tokens for both the light and the dark theme. Every window (main, quick-add) runs this,
 * so a change in Settings reaches them all without a restart.
 */
export function applyScheme(css: string) {
  let el = document.getElementById('tally-scheme');
  if (!css) { el?.remove(); return; }
  if (!el) { el = document.createElement('style'); el.id = 'tally-scheme'; document.head.appendChild(el); }
  if (el.textContent !== css) el.textContent = css;
}

export function startAppearance() {
  const load = () => { api.appearance().then((a) => applyScheme(a.css)).catch(() => {}); };
  load();
  window.addEventListener('focus', load); // a window that was hidden (the quick-add window) catches up when it is shown
  window.addEventListener('planner:appearance', (e) => applyScheme(String((e as CustomEvent<string>).detail ?? '')));
}
