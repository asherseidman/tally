import { describe, it, expect } from 'vitest';
import { makeImportKey, normalizeTitle } from '../src/import/importKey';

describe('import key', () => {
  it('normalizes case, punctuation and whitespace', () => {
    expect(normalizeTitle('  Homework #3:  Limits!! ')).toBe('homework 3 limits');
  });
  it('is stable across cosmetic title differences', () => {
    expect(makeImportKey('T1', 'MATH 101', 'Homework 3')).toBe(makeImportKey('T1', 'math 101', ' homework  3. '));
  });
  it('differs by term', () => {
    expect(makeImportKey('T1', 'MATH 101', 'Homework 3')).not.toBe(makeImportKey('T2', 'MATH 101', 'Homework 3'));
  });
  it('differs by course and title', () => {
    const a = makeImportKey('T1', 'MATH 101', 'Homework 3');
    expect(a).not.toBe(makeImportKey('T1', 'PHYS 101', 'Homework 3'));
    expect(a).not.toBe(makeImportKey('T1', 'MATH 101', 'Homework 4'));
  });
  it('does not collide on boundary shifts', () => {
    expect(makeImportKey('T1', 'ab', 'c')).not.toBe(makeImportKey('T1', 'a', 'bc'));
  });
});
