import { describe, it, expect } from 'vitest';
import { backupFolderFor } from '../src/cli/context';

describe('backupFolderFor', () => {
  it('uses the configured folder when set', () => {
    expect(backupFolderFor('/cloud/b', '/data/planner.db', false)).toBe('/cloud/b');
  });
  it('defaults next to the database file, so a PLANNER_DB override never writes into the real data folder', () => {
    expect(backupFolderFor(undefined, '/tmp/x/test.db', false)).toBe('/tmp/x/backups');
    expect(backupFolderFor(undefined, '/data/demo.db', true)).toBe('/data/backups-demo');
  });
});
