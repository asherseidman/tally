import { createHash } from 'node:crypto';

export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Immutable identity of an imported task: hash of term + course + normalized original title.
 * Computed once at import; later edits to title/date never change it.
 */
export function makeImportKey(termName: string, course: string, title: string): string {
  const parts = [normalizeTitle(termName), normalizeTitle(course), normalizeTitle(title)];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}
