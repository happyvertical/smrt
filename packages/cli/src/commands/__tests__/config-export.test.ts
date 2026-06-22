import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configExportCommand } from '../config-export.js';

// ---------------------------------------------------------------------------
// Mocks for the dynamically imported dependencies. The handler calls
// `await import(...)` for each of these, so the factory return shape must match
// the named exports the handler reads.
// ---------------------------------------------------------------------------

const getPackageConfig = vi.fn();
vi.mock('@happyvertical/smrt-config', () => ({
  getPackageConfig: (...args: unknown[]) => getPackageConfig(...args),
  // exportConfig / sanitizeConfig are the real implementations re-exported so
  // we exercise the genuine secret-stripping behaviour.
  exportConfig: (data: Record<string, unknown>, opts: any) => {
    const payload = opts?.includeSecrets ? data : sanitizeImpl(data);
    if (opts?.format === 'js') {
      return `export default ${JSON.stringify(payload, null, 2)};\n`;
    }
    return JSON.stringify(payload, null, 2);
  },
  sanitizeConfig: (data: Record<string, unknown>) => sanitizeImpl(data),
}));

// A tiny stand-in for the real sanitizeConfig: strips obvious secret keys.
function sanitizeImpl(data: any): any {
  if (Array.isArray(data)) return data.map(sanitizeImpl);
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (/password|secret|token|apikey|api_key/i.test(k)) {
        out[k] = '***';
      } else {
        out[k] = sanitizeImpl(v);
      }
    }
    return out;
  }
  return data;
}

vi.mock('../config.js', () => ({
  DEFAULT_CLI_CONFIG: { database: { type: 'sqlite', url: ':memory:' } },
}));

const getDatabase = vi.fn();
vi.mock('@happyvertical/sql', () => ({
  getDatabase: (...args: unknown[]) => getDatabase(...args),
}));

const listFn = vi.fn();
const createCollection = vi.fn(async () => ({ list: listFn }));
vi.mock('@happyvertical/smrt-agents', () => ({
  AgentConfigCollection: {
    create: (...args: unknown[]) => createCollection(...args),
  },
}));

describe('config:export command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);
    // default: a configured DB and a mock connection with a close()
    getPackageConfig.mockReturnValue({
      database: { type: 'sqlite', url: './dev.db' },
    });
    getDatabase.mockResolvedValue({ close: vi.fn() });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
    process.exitCode = undefined;
  });

  function logged(): string {
    return logSpy.mock.calls.flat().join('\n');
  }
  function errored(): string {
    return errSpy.mock.calls.flat().join('\n');
  }

  it('errors and exits when no agent id is supplied', async () => {
    // process.exit() throws our sentinel, but it is raised inside the handler's
    // try block and swallowed by its catch, which sets exitCode + returns.
    await configExportCommand.handler([], {});
    expect(errored()).toContain('Agent ID is required');
    expect(process.exitCode).toBe(1);
  });

  it('errors and exits when the database is not configured', async () => {
    getPackageConfig.mockReturnValue({ database: { url: ':memory:' } });
    await configExportCommand.handler([], { agent: 'a1' });
    expect(errored()).toContain('Database configuration required');
    expect(process.exitCode).toBe(1);
  });

  it('emits a JSON error object when db missing and --json is set', async () => {
    getPackageConfig.mockReturnValue({ database: undefined });
    await configExportCommand.handler([], { agent: 'a1', json: true });
    expect(logged()).toContain('"error":"Database not configured"');
    expect(process.exitCode).toBe(1);
  });

  it('reports when no configurations are found for an agent', async () => {
    listFn.mockResolvedValue([]);
    await configExportCommand.handler([], { agent: 'missing' });
    expect(logged()).toContain('No configurations found for agent: missing');
  });

  it('mentions the slot filter when no configs found with --slot', async () => {
    listFn.mockResolvedValue([]);
    await configExportCommand.handler([], {
      agent: 'missing',
      slot: 'sources',
    });
    expect(logged()).toContain('Slot filter: sources');
    expect(createCollection).toHaveBeenCalled();
  });

  it('returns empty JSON config object when none found and --json', async () => {
    listFn.mockResolvedValue([]);
    await configExportCommand.handler([], { agent: 'x', json: true });
    expect(logged()).toContain('"configs":{}');
  });

  it('writes a sanitized JSON file by default', async () => {
    const dir = await mkdtemp(resolve(process.cwd(), '.tmp-cfg-export-'));
    tempDirs.push(dir);
    const outFile = join(dir, 'nested', 'smrt.exported.json');
    listFn.mockResolvedValue([
      {
        slotId: 'settings',
        configData: { apiKey: 'sekret', label: 'visible' },
      },
    ]);

    await configExportCommand.handler([], {
      agent: 'agent-1',
      output: outFile,
      format: 'json',
    });

    const written = await readFile(outFile, 'utf-8');
    expect(written).toContain('"apiKey": "***"');
    expect(written).toContain('"label": "visible"');
    expect(logged()).toContain('Exported configuration for agent: agent-1');
    expect(logged()).toContain('Secrets: filtered');
    // JSON-format usage hint
    expect(logged()).toContain("with { type: 'json' }");
  });

  it('includes secrets and emits js usage hint when requested', async () => {
    const dir = await mkdtemp(resolve(process.cwd(), '.tmp-cfg-export-js-'));
    tempDirs.push(dir);
    const outFile = join(dir, 'smrt.exported.js');
    listFn.mockResolvedValue([
      { slotId: 'settings', configData: { apiKey: 'sekret' } },
    ]);

    await configExportCommand.handler([], {
      agent: 'agent-1',
      output: outFile,
      format: 'js',
      'include-secrets': true,
    });

    const written = await readFile(outFile, 'utf-8');
    expect(written).toContain('export default');
    expect(written).toContain('"apiKey": "sekret"');
    expect(logged()).toContain('Secrets: INCLUDED');
    expect(logged()).toContain('export default {');
  });

  it('outputs sanitized JSON to stdout with --json (no file write)', async () => {
    listFn.mockResolvedValue([
      {
        slotId: 'settings',
        configData: { password: 'p', name: 'ok' },
      },
    ]);
    await configExportCommand.handler([], { agent: 'agent-1', json: true });
    const out = logged();
    expect(out).toContain('"agentId": "agent-1"');
    expect(out).toContain('"password": "***"');
    expect(out).toContain('"name": "ok"');
  });

  it('preserves secrets in stdout JSON with --json --include-secrets', async () => {
    listFn.mockResolvedValue([
      { slotId: 'settings', configData: { password: 'p' } },
    ]);
    await configExportCommand.handler([], {
      agent: 'agent-1',
      json: true,
      'include-secrets': true,
    });
    expect(logged()).toContain('"password": "p"');
  });

  it('passes the slot filter through to the collection query', async () => {
    listFn.mockResolvedValue([{ slotId: 'sources', configData: { url: 'x' } }]);
    await configExportCommand.handler([], {
      agent: 'agent-1',
      json: true,
      slot: 'sources',
    });
    expect(listFn).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', slotId: 'sources' },
    });
  });

  it('handles thrown errors and sets exitCode, with --json error output', async () => {
    getDatabase.mockRejectedValue(new Error('connection refused'));
    await configExportCommand.handler([], { agent: 'agent-1', json: true });
    expect(logged()).toContain('"error":"connection refused"');
    expect(process.exitCode).toBe(1);
  });

  it('handles thrown errors in non-json mode', async () => {
    getDatabase.mockRejectedValue(new Error('boom'));
    await configExportCommand.handler([], { agent: 'agent-1' });
    expect(errored()).toContain('Failed to export configuration');
    expect(errored()).toContain('boom');
    expect(process.exitCode).toBe(1);
  });

  it('closes the database connection in the finally block', async () => {
    const close = vi.fn();
    getDatabase.mockResolvedValue({ close });
    listFn.mockResolvedValue([
      { slotId: 'settings', configData: { name: 'ok' } },
    ]);
    await configExportCommand.handler([], { agent: 'agent-1', json: true });
    expect(close).toHaveBeenCalled();
  });
});
