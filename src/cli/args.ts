export interface Args {
  positional: string[];
  flags: Set<string>;
}
export function parseArgs(argv = process.argv.slice(2)): Args {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of argv) (a.startsWith('--') ? flags.add(a.slice(2)) : positional.push(a));
  return { positional, flags };
}

const BOOLEAN_FLAGS = new Set(['demo', 'yes', 'dry-run', 'all-terms', 'deleted', 'done', 'all', 'archived', 'current', 'apply', 'fake-calendar', 'json', 'help', 'needs-size', 'optional', 'required', 'est-from-size', 'replace', 'include-optional', 'deadline-only', 'schedulable', 'per-assignment']);

export interface Cli {
  positional: string[];
  opts: Record<string, string>;
  flags: Set<string>;
}

/**
 * Parses `cmd arg --flag --opt several words --opt2 x`. Boolean flags take no value; any other
 * --opt takes every following token up to the next --flag, so `--due fri 5pm` needs no quotes.
 */
export function parseCli(argv = process.argv.slice(2)): Cli {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.add(name);
      continue;
    }
    const vals: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) vals.push(argv[++i]);
    opts[name] = vals.join(' ');
  }
  return { positional, opts, flags };
}
