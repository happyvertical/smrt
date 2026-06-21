import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportCommand } from '../export.js';

// ---------------------------------------------------------------------------
// Dynamic-import mocks for the export command handler.
// ---------------------------------------------------------------------------

const getConfig = vi.fn();
const getPackageConfig = vi.fn();
vi.mock('@happyvertical/smrt-config', () => ({
  getConfig: (...args: unknown[]) => getConfig(...args),
  getPackageConfig: (...args: unknown[]) => getPackageConfig(...args),
}));

vi.mock('../config.js', () => ({
  DEFAULT_CLI_CONFIG: { database: { type: 'sqlite', url: ':memory:' } },
}));

const getDatabase = vi.fn();
const dbQuery = vi.fn();
vi.mock('@happyvertical/sql', () => ({
  getDatabase: (...args: unknown[]) => getDatabase(...args),
}));

// Registry mock: a single STI Article on the `contents` table with a handful of
// fields, so getCommonFields / queryWithProjection have something to project.
vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getTableStrategy: vi.fn(() => 'sti'),
    getSTIBase: vi.fn((t: string) => t),
    getTableName: vi.fn((t: string) =>
      t === 'Article' || t === 'Content' ? 'contents' : null,
    ),
    getAllFields: vi.fn(
      () =>
        new Map<string, any>([
          ['id', { type: 'text', _meta: { __smrtSystemField: true } }],
          ['slug', { type: 'text', _meta: { __smrtSystemField: true } }],
          ['title', { type: 'string' }],
          ['body', { type: 'string' }],
          ['status', { type: 'string' }],
        ]),
    ),
    getSchema: vi.fn(() => ({
      tableName: 'contents',
      columns: {
        id: { type: 'TEXT' },
        slug: { type: 'TEXT' },
        _meta_type: { type: 'TEXT' },
        _meta_data: { type: 'JSON' },
        title: { type: 'TEXT' },
        body: { type: 'TEXT' },
        status: { type: 'TEXT' },
      },
    })),
  },
}));

describe('export command handler', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    delete process.env.PUBLIC_SHOW_DRAFTS;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    getDatabase.mockResolvedValue({ query: dbQuery, close: vi.fn() });
    dbQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
    process.exitCode = undefined;
  });

  const logged = () => logSpy.mock.calls.flat().join('\n');
  const errored = () => errSpy.mock.calls.flat().join('\n');
  const warned = () => warnSpy.mock.calls.flat().join('\n');

  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(resolve(process.cwd(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it('exits when there is no smrt config', async () => {
    getConfig.mockReturnValue(undefined);
    await exportCommand.handler([], {});
    expect(errored()).toContain('No smrt.config.js found');
    expect(process.exitCode).toBe(1);
  });

  it('emits a JSON error when no smrt config and --json', async () => {
    getConfig.mockReturnValue(undefined);
    await exportCommand.handler([], { json: true });
    expect(logged()).toContain('"error":"No smrt.config.js found"');
  });

  it('exits when no export configuration is present', async () => {
    getConfig.mockReturnValue({ export: {} });
    await exportCommand.handler([], {});
    expect(errored()).toContain('No export configuration found');
    expect(process.exitCode).toBe(1);
  });

  it('emits JSON error for missing export config when --json', async () => {
    getConfig.mockReturnValue({});
    await exportCommand.handler([], { json: true });
    expect(logged()).toContain('"error":"No export configuration found"');
  });

  it('exits when the database is not configured', async () => {
    getConfig.mockReturnValue({ export: { contents: { types: ['Article'] } } });
    getPackageConfig.mockReturnValue({ database: { url: ':memory:' } });
    await exportCommand.handler([], {});
    expect(errored()).toContain('Database configuration required');
    expect(process.exitCode).toBe(1);
  });

  it('emits a JSON db error when db missing and --json', async () => {
    getConfig.mockReturnValue({ export: { contents: { types: ['Article'] } } });
    getPackageConfig.mockReturnValue({ database: undefined });
    await exportCommand.handler([], { json: true });
    expect(logged()).toContain('"error":"Database not configured"');
  });

  it('writes a JSON export file with projected records', async () => {
    const dir = await tmp('.tmp-export-json-');
    getConfig.mockReturnValue({
      export: {
        fieldExportDefault: true,
        contents: { types: ['Article'], filters: { status: ['published'] } },
      },
    });
    dbQuery.mockResolvedValue({
      rows: [
        { id: '1', slug: 'a', title: 'Hello', body: 'B', status: 'published' },
      ],
    });

    await exportCommand.handler([], { output: dir });

    const written = await readFile(join(dir, 'contents.json'), 'utf-8');
    const parsed = JSON.parse(written);
    expect(parsed[0].title).toBe('Hello');
    expect(logged()).toContain('Export complete');
    expect(logged()).toContain('contents.json: 1 records');
  });

  it('honors --dry-run without writing files', async () => {
    const dir = await tmp('.tmp-export-dry-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'] } },
    });
    dbQuery.mockResolvedValue({ rows: [{ id: '1', title: 'X' }] });

    await exportCommand.handler([], { output: dir, 'dry-run': true });

    await expect(
      readFile(join(dir, 'contents.json'), 'utf-8'),
    ).rejects.toThrow();
    expect(logged()).toContain('(dry-run)');
  });

  it('writes ndjson when the file config requests it', async () => {
    const dir = await tmp('.tmp-export-ndjson-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'], format: 'ndjson' } },
    });
    dbQuery.mockResolvedValue({
      rows: [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
      ],
    });

    await exportCommand.handler([], { output: dir });

    const written = await readFile(join(dir, 'contents.ndjson'), 'utf-8');
    expect(written.split('\n')).toHaveLength(2);
  });

  it('writes csv with a header row', async () => {
    const dir = await tmp('.tmp-export-csv-');
    getConfig.mockReturnValue({
      export: { format: 'csv', contents: { types: ['Article'] } },
    });
    dbQuery.mockResolvedValue({
      rows: [
        { id: '1', slug: 's', title: 'A', body: 'b', status: 'published' },
      ],
    });

    await exportCommand.handler([], { output: dir });

    const written = await readFile(join(dir, 'contents.csv'), 'utf-8');
    expect(written.split('\n')[0]).toContain('title');
  });

  it('skips file configs that specify no types', async () => {
    const dir = await tmp('.tmp-export-notypes-');
    getConfig.mockReturnValue({
      export: { contents: { types: [] } },
    });
    await exportCommand.handler([], { output: dir });
    expect(warned()).toContain('No types specified for contents');
  });

  it('limits export to a single file via --file', async () => {
    const dir = await tmp('.tmp-export-onlyfile-');
    getConfig.mockReturnValue({
      export: {
        contents: { types: ['Article'] },
        events: { types: ['Article'] },
      },
    });
    dbQuery.mockResolvedValue({ rows: [] });

    await exportCommand.handler([], {
      output: dir,
      file: 'contents',
      verbose: true,
    });

    expect(logged()).toContain('Processing: contents');
    expect(logged()).not.toContain('Processing: events');
  });

  it('emits a JSON summary with --json', async () => {
    const dir = await tmp('.tmp-export-jsonsummary-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'] } },
    });
    dbQuery.mockResolvedValue({ rows: [{ id: '1', title: 'A' }] });

    await exportCommand.handler([], { output: dir, json: true });

    const out = logged();
    expect(out).toContain('"contents"');
    expect(out).toContain('"records": 1');
  });

  it('reports show-drafts mode when enabled', async () => {
    const dir = await tmp('.tmp-export-drafts-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'] } },
    });
    dbQuery.mockResolvedValue({ rows: [] });

    await exportCommand.handler([], { output: dir, 'show-drafts': true });
    expect(logged()).toContain('Including drafts');
  });

  it('handles query failures and sets exitCode', async () => {
    const dir = await tmp('.tmp-export-fail-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'] } },
    });
    dbQuery.mockRejectedValue(new Error('db blew up'));

    await exportCommand.handler([], { output: dir, verbose: true });
    expect(errored()).toContain('Export failed');
    expect(process.exitCode).toBe(1);
  });

  it('handles query failures in JSON mode', async () => {
    const dir = await tmp('.tmp-export-failjson-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'] } },
    });
    dbQuery.mockRejectedValue(new Error('db blew up'));

    await exportCommand.handler([], { output: dir, json: true });
    expect(logged()).toContain('"error"');
    expect(process.exitCode).toBe(1);
  });

  it('writes an empty csv for a file with no records', async () => {
    const dir = await tmp('.tmp-export-emptycsv-');
    getConfig.mockReturnValue({
      export: { contents: { types: ['Article'], format: 'csv' } },
    });
    dbQuery.mockResolvedValue({ rows: [] });

    await exportCommand.handler([], { output: dir });

    const written = await readFile(join(dir, 'contents.csv'), 'utf-8');
    expect(written).toBe('');
  });

  it('falls back to the events table for unknown event-like types', async () => {
    const dir = await tmp('.tmp-export-fallback-');
    // 'Meeting' is not mapped by the registry getTableName mock, so the handler
    // exercises the heuristic table-name fallback ('events').
    getConfig.mockReturnValue({
      export: { meetings: { types: ['Meeting'] } },
    });
    dbQuery.mockResolvedValue({ rows: [{ id: '1', title: 'Town hall' }] });

    await exportCommand.handler([], { output: dir });

    const written = await readFile(join(dir, 'meetings.json'), 'utf-8');
    expect(JSON.parse(written)).toHaveLength(1);
    // SQL targeted the heuristic 'events' table.
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM events'),
      ...['%:Meeting'],
    );
  });
});
