const ALIASES: Record<string, string> = { a: 'add', d: 'done', l: 'ls', s: 'search' };

/** Short aliases for the most-used commands; full names keep working. */
export const resolveCommand = (name: string): string => ALIASES[name] ?? name;
