/**
 * Unit tests for git commands
 *
 * Tests JSON merge driver functionality for SMRT data files
 */

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeArraysByKey, mergeObjects } from '../git.js';

describe('git:merge-json', () => {
  describe('mergeArraysByKey', () => {
    it('should merge arrays with no overlap', () => {
      const base = [{ id: 'a', name: 'Event A' }];
      const ours = [
        { id: 'a', name: 'Event A' },
        { id: 'b', name: 'Event B' },
      ];
      const theirs = [
        { id: 'a', name: 'Event A' },
        { id: 'c', name: 'Event C' },
      ];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(3);
      expect(result.map((o) => o.id)).toContain('a');
      expect(result.map((o) => o.id)).toContain('b');
      expect(result.map((o) => o.id)).toContain('c');
    });

    it('should resolve conflicts by updated_at timestamp', () => {
      const base = [
        { id: 'a', name: 'Original', updated_at: '2024-01-01T00:00:00Z' },
      ];
      const ours = [
        { id: 'a', name: 'Ours', updated_at: '2024-01-02T00:00:00Z' },
      ];
      const theirs = [
        { id: 'a', name: 'Theirs', updated_at: '2024-01-03T00:00:00Z' },
      ];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Theirs'); // theirs is newer
    });

    it('should keep ours when ours is newer', () => {
      const base = [
        { id: 'a', name: 'Original', updated_at: '2024-01-01T00:00:00Z' },
      ];
      const ours = [
        { id: 'a', name: 'Ours', updated_at: '2024-01-03T00:00:00Z' },
      ];
      const theirs = [
        { id: 'a', name: 'Theirs', updated_at: '2024-01-02T00:00:00Z' },
      ];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Ours'); // ours is newer
    });

    it('should handle missing timestamps by preferring ours', () => {
      const base = [{ id: 'a', name: 'Original' }];
      const ours = [{ id: 'a', name: 'Ours' }];
      const theirs = [{ id: 'a', name: 'Theirs' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(1);
      // Without timestamps, ours wins (earlier in merge order)
      expect(result[0].name).toBe('Ours');
    });

    it('should handle empty base (new file scenario)', () => {
      const base: any[] = [];
      const ours = [{ id: 'a', name: 'Ours A' }];
      const theirs = [{ id: 'b', name: 'Theirs B' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(2);
      expect(result.map((o) => o.id).sort()).toEqual(['a', 'b']);
    });

    it('should preserve _meta_type for STI support', () => {
      const base = [{ id: 'a', _meta_type: 'Event', name: 'Event A' }];
      const ours = [{ id: 'a', _meta_type: 'Event', name: 'Event A' }];
      const theirs = [{ id: 'b', _meta_type: 'Meeting', name: 'Meeting B' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(2);
      const eventA = result.find((o) => o.id === 'a');
      const meetingB = result.find((o) => o.id === 'b');
      expect(eventA?._meta_type).toBe('Event');
      expect(meetingB?._meta_type).toBe('Meeting');
    });

    it('should sort by created_at for consistent ordering', () => {
      const base: any[] = [];
      const ours = [{ id: 'b', created_at: '2024-01-02T00:00:00Z' }];
      const theirs = [{ id: 'a', created_at: '2024-01-01T00:00:00Z' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result[0].id).toBe('a'); // earlier created_at comes first
      expect(result[1].id).toBe('b');
    });

    it('should use slug as fallback key when id is missing', () => {
      const base: any[] = [];
      const ours = [{ slug: 'event-a', name: 'Event A' }];
      const theirs = [{ slug: 'event-b', name: 'Event B' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(2);
      expect(result.map((o) => o.slug).sort()).toEqual(['event-a', 'event-b']);
    });

    it('should deduplicate by id', () => {
      const base = [{ id: 'a', name: 'Original' }];
      const ours = [
        { id: 'a', name: 'Ours' },
        { id: 'a', name: 'Duplicate' },
      ];
      const theirs = [{ id: 'a', name: 'Theirs' }];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(1);
    });

    it('should handle example from issue #514', () => {
      // Example from issue description
      const base = [{ id: 'a', name: 'Event A' }];
      const ours = [
        { id: 'a', name: 'Event A' },
        { id: 'weather-1', name: 'Forecast' },
      ];
      const theirs = [
        { id: 'a', name: 'Event A' },
        { id: 'meeting-1', name: 'Council Meeting' },
      ];

      const result = mergeArraysByKey(base, ours, theirs);

      expect(result).toHaveLength(3);
      expect(result.map((o) => o.id).sort()).toEqual([
        'a',
        'meeting-1',
        'weather-1',
      ]);
    });
  });

  describe('mergeObjects', () => {
    it('should merge root-level arrays', () => {
      const base = [{ id: 'a' }];
      const ours = [{ id: 'a' }, { id: 'b' }];
      const theirs = [{ id: 'a' }, { id: 'c' }];

      const result = mergeObjects(base, ours, theirs);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
    });

    it('should merge nested arrays with IDs', () => {
      const base = { events: [{ id: 'a' }] };
      const ours = { events: [{ id: 'a' }, { id: 'b' }] };
      const theirs = { events: [{ id: 'a' }, { id: 'c' }] };

      const result = mergeObjects(base, ours, theirs);

      expect(result.events).toHaveLength(3);
    });

    it('should prefer ours for simple values', () => {
      const base = { name: 'Original' };
      const ours = { name: 'Ours' };
      const theirs = { name: 'Theirs' };

      const result = mergeObjects(base, ours, theirs);

      expect(result.name).toBe('Ours');
    });

    it('should merge nested objects recursively', () => {
      const base = { config: { a: 1 } };
      const ours = { config: { a: 2, b: 3 } };
      const theirs = { config: { a: 1, c: 4 } };

      const result = mergeObjects(base, ours, theirs);

      expect(result.config.a).toBe(2); // ours wins
      expect(result.config.b).toBe(3); // from ours
      expect(result.config.c).toBe(4); // from theirs
    });

    it('should include keys from all three versions', () => {
      const base = { a: 1 };
      const ours = { b: 2 };
      const theirs = { c: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result).toHaveProperty('a');
      expect(result).toHaveProperty('b');
      expect(result).toHaveProperty('c');
    });

    it('should handle arrays without IDs (prefer ours)', () => {
      const base = { tags: ['a', 'b'] };
      const ours = { tags: ['c', 'd'] };
      const theirs = { tags: ['e', 'f'] };

      const result = mergeObjects(base, ours, theirs);

      // Simple arrays prefer ours
      expect(result.tags).toEqual(['c', 'd']);
    });

    it('should handle null and undefined values', () => {
      const base = { a: null };
      const ours = { a: undefined, b: 'value' };
      const theirs = { a: 'theirs', c: 'other' };

      const result = mergeObjects(base, ours, theirs);

      expect(result.b).toBe('value');
      expect(result.c).toBe('other');
    });
  });

  describe('merge-json integration scenarios', () => {
    // Note: The command handler calls process.exit() which doesn't work well in tests.
    // So we test the underlying merge functions directly with file-like scenarios.

    it('should merge JSON arrays correctly (simulated file merge)', () => {
      // Simulate reading from files
      const base = [{ id: 'a', name: 'Event A' }];
      const ours = [
        { id: 'a', name: 'Event A' },
        { id: 'b', name: 'Event B' },
      ];
      const theirs = [
        { id: 'a', name: 'Event A' },
        { id: 'c', name: 'Event C' },
      ];

      const merged = mergeObjects(base, ours, theirs);

      expect(merged).toHaveLength(3);
      expect(merged.map((o: any) => o.id).sort()).toEqual(['a', 'b', 'c']);
    });

    it('should handle empty base (simulated new file)', () => {
      const base: any[] = [];
      const ours = [{ id: 'a' }];
      const theirs = [{ id: 'b' }];

      const merged = mergeObjects(base, ours, theirs);

      expect(merged).toHaveLength(2);
    });

    it('should handle nested objects with events array (simulated file)', () => {
      const base = {
        version: '1.0',
        events: [{ id: 'a', name: 'Event A' }],
      };
      const ours = {
        version: '1.0',
        events: [
          { id: 'a', name: 'Event A' },
          { id: 'weather-1', name: 'Weather' },
        ],
      };
      const theirs = {
        version: '1.0',
        events: [
          { id: 'a', name: 'Event A' },
          { id: 'meeting-1', name: 'Meeting' },
        ],
      };

      const merged = mergeObjects(base, ours, theirs);

      expect(merged.version).toBe('1.0');
      expect(merged.events).toHaveLength(3);
      expect(merged.events.map((e: any) => e.id).sort()).toEqual([
        'a',
        'meeting-1',
        'weather-1',
      ]);
    });
  });
});

describe('git:init', () => {
  const testDir = resolve(process.cwd(), '.test-git-init');

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should have correct command structure', async () => {
    const { gitCommands } = await import('../git.js');
    const gitInit = gitCommands['git:init'];

    expect(gitInit).toBeDefined();
    expect(gitInit.name).toBe('git:init');
    expect(gitInit.description).toContain('merge driver');
    expect(gitInit.options).toHaveProperty('patterns');
    expect(gitInit.options).toHaveProperty('global');
    expect(gitInit.options).toHaveProperty('force');
  });

  it('should have merge-json command', async () => {
    const { gitCommands } = await import('../git.js');
    const mergeJson = gitCommands['merge-json'];

    expect(mergeJson).toBeDefined();
    expect(mergeJson.name).toBe('merge-json');
    expect(mergeJson.args).toEqual(['base', 'ours', 'theirs']);
  });
});
