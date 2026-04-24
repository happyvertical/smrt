import { describe, expect, it, vi } from 'vitest';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactConnectionString,
} from '../db-command-utils.js';

describe('db command utilities', () => {
  it('redacts credentials in connection strings', () => {
    expect(
      redactConnectionString(
        'postgresql://anytown:super-secret@localhost:5432/anytown?sslmode=require&token=abc',
      ),
    ).toBe(
      'postgresql://anytown:***@localhost:5432/anytown?sslmode=require&token=***',
    );
  });

  it('formats relative database paths without leaking credentials', () => {
    expect(formatDatabaseDisplayUrl('sqlite', './data/dev.db')).toBe(
      'sqlite://./data/dev.db',
    );
  });

  it('closes database handles when commands finish', async () => {
    const close = vi.fn();

    await closeDatabaseConnection({ close });

    expect(close).toHaveBeenCalledOnce();
  });
});
