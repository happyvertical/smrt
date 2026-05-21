import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getClassByQualifiedNameMock,
  getClassMock,
  getAllFieldsMock,
  getTableStrategyMock,
  getSTIBaseMock,
  getTableNameMock,
} = vi.hoisted(() => ({
  getClassByQualifiedNameMock: vi.fn(),
  getClassMock: vi.fn(),
  getAllFieldsMock: vi.fn(),
  getTableStrategyMock: vi.fn(),
  getSTIBaseMock: vi.fn(),
  getTableNameMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getClassByQualifiedName: getClassByQualifiedNameMock,
    getClass: getClassMock,
    getAllFields: getAllFieldsMock,
    getTableStrategy: getTableStrategyMock,
    getSTIBase: getSTIBaseMock,
    getTableName: getTableNameMock,
  },
}));

import {
  assertNoUnsupportedMigrationFiles,
  evaluateSchemaContract,
  UnsupportedFileMigrationsError,
  UnsupportedMigrationModeError,
} from '../schema-contract.js';

describe('schema contract', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    getTableStrategyMock.mockReturnValue('cti');
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('fails when schema commands discover package manifests but no local project manifest', async () => {
    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/node_modules/@happyvertical/smrt-content/dist/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-content',
          packageVersion: '0.1.0',
          objectCount: 1,
          objectNames: ['@happyvertical/smrt-content:Mirror'],
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ code: 'missing_local_manifest' }),
    );
  });

  it('does not accept legacy project manifest locations for schema commands', async () => {
    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/static-manifest.js',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
        {
          path: '/repo/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Publication'],
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.localManifest).toEqual({
      ok: false,
      count: 0,
      paths: [],
    });
    expect(report.failures).toContainEqual(
      expect.objectContaining({ code: 'missing_local_manifest' }),
    );
  });

  it('fails before migration when a required object is missing', async () => {
    getClassByQualifiedNameMock.mockReturnValue(undefined);

    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
      ],
      schemaContract: {
        requiredObjects: ['@app/dashboard:Publication'],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        code: 'missing_required_object',
        ref: '@app/dashboard:Publication',
      }),
    );
  });

  it('infers STI field database shape from required semantic fields', async () => {
    const mirrorEntry = {
      name: 'Mirror',
      qualifiedName: '@happyvertical/smrt-content:Mirror',
    };
    getClassByQualifiedNameMock.mockReturnValue(mirrorEntry);
    getAllFieldsMock.mockResolvedValue(new Map([['feedSourceId', {}]]));
    getTableStrategyMock.mockReturnValue('sti');
    getSTIBaseMock.mockReturnValue('Content');
    getTableNameMock.mockImplementation((className: string) =>
      className === 'Content' ? 'contents' : undefined,
    );

    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
      ],
      schemaContract: {
        requiredFields: ['@happyvertical/smrt-content:Mirror.feedSourceId'],
      },
      db: {
        getTableSchema: vi.fn().mockResolvedValue({
          columns: { feed_source_id: { type: 'TEXT' } },
          indexes: {},
        }),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.inferredDatabaseShape.columns).toEqual([
      'contents.feed_source_id',
    ]);
    expect(report.requiredDatabaseShape.columns).toContainEqual({
      ref: 'contents.feed_source_id',
      present: true,
    });
  });

  it('uses the canonical SMRT snake-case algorithm for acronym field names', async () => {
    const mirrorEntry = {
      name: 'Mirror',
      qualifiedName: '@happyvertical/smrt-content:Mirror',
    };
    getClassByQualifiedNameMock.mockReturnValue(mirrorEntry);
    getAllFieldsMock.mockResolvedValue(new Map([['feedURLId', {}]]));
    getTableStrategyMock.mockReturnValue('sti');
    getSTIBaseMock.mockReturnValue('Content');
    getTableNameMock.mockImplementation((className: string) =>
      className === 'Content' ? 'contents' : undefined,
    );

    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
      ],
      schemaContract: {
        requiredFields: ['@happyvertical/smrt-content:Mirror.feedURLId'],
      },
      db: {
        getTableSchema: vi.fn().mockResolvedValue({
          columns: { feed_u_r_l_id: { type: 'TEXT' } },
          indexes: {},
        }),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.inferredDatabaseShape.columns).toEqual([
      'contents.feed_u_r_l_id',
    ]);
  });

  it('fails after migration/status when inferred columns are absent from the live database', async () => {
    const mirrorEntry = {
      name: 'Mirror',
      qualifiedName: '@happyvertical/smrt-content:Mirror',
    };
    getClassByQualifiedNameMock.mockReturnValue(mirrorEntry);
    getAllFieldsMock.mockResolvedValue(new Map([['feedSourceId', {}]]));
    getTableStrategyMock.mockReturnValue('sti');
    getSTIBaseMock.mockReturnValue('Content');
    getTableNameMock.mockReturnValue('contents');

    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
      ],
      schemaContract: {
        requiredFields: ['@happyvertical/smrt-content:Mirror.feedSourceId'],
      },
      db: {
        getTableSchema: vi.fn().mockResolvedValue({
          columns: {},
          indexes: {},
        }),
      },
    });

    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        code: 'missing_required_column',
        ref: 'contents.feed_source_id',
      }),
    );
  });

  it('checks explicit required indexes from live database index arrays', async () => {
    const report = await evaluateSchemaContract({
      discovered: [
        {
          path: '/repo/.smrt/manifest.json',
          source: 'project',
          objectCount: 1,
          objectNames: ['@app/dashboard:Site'],
        },
      ],
      schemaContract: {
        requiredDatabaseShape: {
          indexes: ['contents.contents_feed_source_id_idx'],
        },
      },
      db: {
        getTableSchema: vi.fn().mockResolvedValue({
          columns: {},
          indexes: [
            {
              name: 'contents_feed_source_id_idx',
              columns: ['feed_source_id'],
            },
          ],
        }),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.requiredDatabaseShape.indexes).toContainEqual({
      ref: 'contents.contents_feed_source_id_idx',
      present: true,
    });
  });

  it('rejects raw SQL or TypeScript migration files in the configured directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'smrt-schema-contract-'));
    await mkdir(join(tempDir, 'migrations'));
    await writeFile(join(tempDir, 'migrations', '0001_raw.sql'), 'SELECT 1;');
    await writeFile(
      join(tempDir, 'migrations', '0002_raw.ts'),
      'export default {};',
    );

    await expect(
      assertNoUnsupportedMigrationFiles(
        { migrations: { directory: './migrations' } },
        tempDir,
      ),
    ).rejects.toThrow(UnsupportedFileMigrationsError);
  });

  it('rejects unsupported file-backed migration modes at runtime', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'smrt-schema-contract-'));

    await expect(
      assertNoUnsupportedMigrationFiles(
        { migrations: { directory: './migrations', mode: 'file' } },
        tempDir,
      ),
    ).rejects.toThrow(UnsupportedMigrationModeError);
  });
});
