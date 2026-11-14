/**
 * Keyboard-shortcut strings in Electron's accelerator syntax ("CommandOrControl+Shift+Space"). Pure functions so they can be
 * tested without Electron: `validateAccelerator` checks and normalizes what is typed or recorded; `accelFromEvent` turns a
 * key press into one so the Settings field can record a shortcut by pressing it.
 */
export const DEFAULT_QUICK_ADD_SHORTCUT = 'CommandOrControl+Shift+Space';

const MODIFIERS: Record<string, string> = {
  command: 'Command', cmd: 'Command', control: 'Control', ctrl: 'Control',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super',
};
const MOD_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift', 'Super'];
const NAMED: Record<string, string> = {
  space: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
  up: 'Up', arrowup: 'Up', down: 'Down', arrowdown: 'Down', left: 'Left', arrowleft: 'Left', right: 'Right', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus',
};
const PUNCT = '`-=[]\;\',./';

function normalizeKey(raw: string): string {
  const k = raw.trim();
  if (/^[a-z]$/i.test(k)) return k.toUpperCase();
  if (/^[0-9]$/.test(k)) return k;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if (k.length === 1 && PUNCT.includes(k)) return k;
  const named = NAMED[k.toLowerCase()];
  if (named) return named;
  throw new Error(`Unknown key "${raw.trim()}". Use a letter, digit, F1-F24, Space, Tab, Enter, an arrow key, or similar.`);
}

/** Returns the normalized accelerator or throws a readable message. Requires a modifier so a global shortcut cannot hijack plain typing. */
export function validateAccelerator(input: string): string {
  const text = input.trim();
  if (!text) throw new Error('Enter a shortcut such as CommandOrControl+Shift+Space.');
  const parts = text.split('+').map((p) => p.trim());
  if (parts.some((p) => p === '')) throw new Error('A shortcut looks like CommandOrControl+Shift+Space (no empty parts).');
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (m) {
      if (mods.includes(m)) throw new Error(`"${m}" appears twice in the shortcut.`);
      mods.push(m);
    } else keys.push(p);
  }
  if (keys.length === 0) throw new Error('A shortcut needs a key as well as the modifiers (for example Space or K).');
  if (keys.length > 1) throw new Error('A shortcut can have only one key (plus modifiers).');
  if (mods.length === 0) throw new Error('A global shortcut needs at least one modifier (Command, Control, Alt or Shift) so it cannot interfere with typing.');
  if (!mods.some((m) => m !== 'Shift')) throw new Error('Shift alone is not enough: include Command, Control or Alt as well.');
  const key = normalizeKey(keys[0]);
  return [...mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)), key].join('+');
}

export interface KeyEventLike { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** A key press as an accelerator, or null for a bare modifier press. Uses the physical key, so Option+K is "K" on a Mac. */
export function accelFromEvent(e: KeyEventLike, isMac: boolean): string | null {
  const c = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) key = c.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(c)) key = c;
  else if (c === 'Space') key = 'Space';
  else if (c === 'Tab') key = 'Tab';
  else if (c === 'Enter' || c === 'NumpadEnter') key = 'Enter';
  else if (c === 'Escape') key = 'Escape';
  else if (c === 'Backspace') key = 'Backspace';
  else if (c === 'Delete') key = 'Delete';
  else if (c === 'Insert') key = 'Insert';
  else if (/^Arrow(Up|Down|Left|Right)$/.test(c)) key = c.slice(5);
  else if (['Home', 'End', 'PageUp', 'PageDown'].includes(c)) key = c;
  else {
    const punct: Record<string, string> = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
    key = punct[c] ?? null;
  }
  if (!key) return null; // a modifier on its own, or a key we do not support
  const mods: string[] = [];
  const cmdLike = isMac ? e.metaKey : e.ctrlKey; // Cmd on a Mac, Ctrl elsewhere: the portable "CommandOrControl"
  if (cmdLike && !(isMac ? e.ctrlKey : e.metaKey)) mods.push('CommandOrControl');
  else {
    if (e.metaKey) mods.push('Command');
    if (e.ctrlKey) mods.push('Control');
  }
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return [...mods, key].join('+');
}
