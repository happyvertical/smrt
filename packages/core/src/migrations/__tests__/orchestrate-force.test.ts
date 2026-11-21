/**
 * `migrateSmrtSchemas` forwards the tracker's force options, so a refused
 * retry's documented remedy (`forceMigrations: [id]`, #5325) is reachable
 * through the orchestrator.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';

describe('migrateSmrtSchemas force options', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a targeted and a batch force to the tracker', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      forced_items: {
        tableName: 'forced_items',
        columns: { id: { type: 'TEXT', primaryKey: true } },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      },
    });
    const applyAll = vi.spyOn(MigrationTracker.prototype, 'applyAll');

    await migrateSmrtSchemas({
      db,
      packageName: '@test/orchestrate-force',
      engineHint: 'sqlite',
      name: 'forced_sync',
      forceMigrations: ['forced_sync'],
      force: true,
    });

    expect(applyAll).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'forced_sync' })],
      expect.objectContaining({
        forceMigrations: ['forced_sync'],
        force: true,
      }),
    );
    await db.close?.();
  });
});
