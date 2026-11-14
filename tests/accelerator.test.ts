import { describe, it, expect } from 'vitest';
import { validateAccelerator, accelFromEvent, DEFAULT_QUICK_ADD_SHORTCUT } from '../src/app/accelerator';

describe('validateAccelerator', () => {
  it('has a sensible default', () => {
    expect(DEFAULT_QUICK_ADD_SHORTCUT).toBe('CommandOrControl+Shift+Space');
    expect(validateAccelerator(DEFAULT_QUICK_ADD_SHORTCUT)).toBe(DEFAULT_QUICK_ADD_SHORTCUT);
  });
  it('normalizes case, aliases and modifier order', () => {
    expect(validateAccelerator('cmd+shift+space')).toBe('Command+Shift+Space');
    expect(validateAccelerator('ctrl+alt+k')).toBe('Control+Alt+K');
    expect(validateAccelerator('Shift+CmdOrCtrl+J')).toBe('CommandOrControl+Shift+J');
    expect(validateAccelerator('option+f5')).toBe('Alt+F5');
    expect(validateAccelerator('  CommandOrControl + Shift + ArrowUp ')).toBe('CommandOrControl+Shift+Up');
  });
  it('accepts letters, digits, function keys and named keys', () => {
    for (const k of ['A', '7', 'F1', 'F12', 'F24', 'Space', 'Tab', 'Enter', 'Escape', 'Up', 'PageDown', 'Home', 'Backspace', '`', '/', ';']) {
      expect(() => validateAccelerator(`CommandOrControl+${k}`)).not.toThrow();
    }
  });
  it('needs at least one modifier so it cannot hijack plain typing', () => {
    expect(() => validateAccelerator('Space')).toThrow(/modifier/i);
    expect(() => validateAccelerator('A')).toThrow(/modifier/i);
    expect(() => validateAccelerator('Shift+A')).toThrow(/Command, Control or Alt/i);
  });
  it('needs exactly one key', () => {
    expect(() => validateAccelerator('Command+Shift')).toThrow(/key/i);
    expect(() => validateAccelerator('Command+A+B')).toThrow(/one key/i);
    expect(() => validateAccelerator('Command+Command+A')).toThrow(/twice/i);
  });
  it('rejects empty, unknown and nonsense', () => {
    expect(() => validateAccelerator('')).toThrow();
    expect(() => validateAccelerator('Command+Banana')).toThrow(/Unknown key/);
    expect(() => validateAccelerator('Command+')).toThrow();
  });
});

describe('accelFromEvent (recording a shortcut by pressing it)', () => {
  const ev = (o: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: '', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });
  it('ignores a bare modifier press', () => {
    expect(accelFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), true)).toBeNull();
    expect(accelFromEvent(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBeNull();
  });
  it('mac: Cmd means CommandOrControl; a lone Ctrl stays Control', () => {
    expect(accelFromEvent(ev({ code: 'Space', key: ' ', metaKey: true, shiftKey: true }), true)).toBe('CommandOrControl+Shift+Space');
    expect(accelFromEvent(ev({ code: 'KeyK', key: 'k', ctrlKey: true }), true)).toBe('Control+K');
    expect(accelFromEvent(ev({ code: 'KeyK', key: 'k', metaKey: true, ctrlKey: true }), true)).toBe('Command+Control+K');
  });
  it('windows/linux: Ctrl means CommandOrControl', () => {
    expect(accelFromEvent(ev({ code: 'Space', key: ' ', ctrlKey: true, shiftKey: true }), false)).toBe('CommandOrControl+Shift+Space');
    expect(accelFromEvent(ev({ code: 'KeyJ', key: 'j', ctrlKey: true, altKey: true }), false)).toBe('CommandOrControl+Alt+J');
  });
  it('maps physical keys (so Option+K on a Mac is K, not the typed symbol)', () => {
    expect(accelFromEvent(ev({ code: 'KeyK', key: '˚', altKey: true, metaKey: true }), true)).toBe('CommandOrControl+Alt+K');
    expect(accelFromEvent(ev({ code: 'Digit4', key: '4', metaKey: true }), true)).toBe('CommandOrControl+4');
    expect(accelFromEvent(ev({ code: 'F6', key: 'F6', metaKey: true }), true)).toBe('CommandOrControl+F6');
    expect(accelFromEvent(ev({ code: 'ArrowUp', key: 'ArrowUp', metaKey: true }), true)).toBe('CommandOrControl+Up');
  });
  it('a key without a modifier is not a valid shortcut yet (returns the bare key text for the field to reject)', () => {
    expect(accelFromEvent(ev({ code: 'KeyA', key: 'a' }), true)).toBe('A');
  });
});
