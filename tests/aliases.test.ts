import { describe, it, expect } from 'vitest';
import { resolveCommand } from '../src/cli/aliases';

describe('resolveCommand', () => {
  it('maps short aliases to full commands', () => {
    expect(resolveCommand('a')).toBe('add');
    expect(resolveCommand('d')).toBe('done');
    expect(resolveCommand('l')).toBe('ls');
    expect(resolveCommand('s')).toBe('search');
  });
  it('keeps full names and unknown names unchanged', () => {
    for (const c of ['add', 'done', 'ls', 'search', 'doctor', 'zzz']) expect(resolveCommand(c)).toBe(c);
  });
});
