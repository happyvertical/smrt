import { describe, expect, it } from 'vitest';
import { newestFirst, timeAgo } from './format.ts';

describe('format', () => {
  const now = Date.parse('2026-06-10T12:00:00Z');
  it('describes elapsed time', () => {
    expect(timeAgo('2026-06-10T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-06-10T11:55:00Z', now)).toBe('5 minutes ago');
    expect(timeAgo('2026-06-10T09:00:00Z', now)).toBe('3 hours ago');
    expect(timeAgo('2026-06-09T09:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('nope', now)).toBe('');
    expect(timeAgo(null, now)).toBe('');
  });
  it('sorts versions newest first', () => {
    expect(
      newestFirst([{ version: 1 }, { version: 3 }, { version: 2 }]),
    ).toEqual([{ version: 3 }, { version: 2 }, { version: 1 }]);
  });
});
