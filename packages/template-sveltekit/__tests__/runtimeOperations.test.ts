import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  readOwnedProcess,
  writeProcessRecord,
} from '../template/scripts/smrt-process.mjs';
import { validateImportBundle } from '../template/scripts/smrt-portability.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const template = join(here, '..', 'template');
const appDriver = readFileSync(join(template, 'scripts', 'smrt-app.mjs'), 'utf8');
const worker = readFileSync(join(template, 'scripts', 'smrt-worker.mjs'), 'utf8');
const compose = readFileSync(join(template, 'compose.yaml'), 'utf8');
const hooks = readFileSync(join(template, 'src', 'hooks.server.ts'), 'utf8');

describe('profile-aware application operations', () => {
  it('uses app-runtime paths and emits secret-free recovery diagnostics', () => {
    expect(appDriver).toContain('resolveLocalRuntimePaths');
    expect(appDriver).toContain('initializeLocalApplicationRuntime');
    expect(appDriver).toContain('prepareDatabase: options.prepareDatabase');
    expect(appDriver).toContain("run('pnpm', ['exec', 'smrt', 'db:migrate']");
    expect(appDriver).toContain("rawCommandArgs[0] === '--'");
    expect(appDriver).toContain('stateRoot: stateRoot()');
    expect(appDriver).toContain("code: 'unsafe-local-bind'");
    expect(appDriver).toContain("code: 'migration-required'");
    expect(appDriver).toContain('secretValuesIncluded: false');
    expect(hooks).toContain(
      'export const init: ServerInit = ensureApplicationRuntimeReady',
    );
    expect(appDriver).not.toMatch(/console\.(?:log|error)\(process\.env/);
  });

  it('rejects a live PID that does not prove application identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'smrt-process-test-'));
    const record = join(directory, 'app.pid');
    try {
      writeProcessRecord(record, {
        pid: process.pid,
        instance: '0123456789abcdef0123456789abcdef',
      });
      expect(readOwnedProcess(record)).toBeNull();
      expect(existsSync(record)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects truncated and incomplete logical exports before import', () => {
    const expected = new Map([
      ['items', { name: 'items', columns: ['id', 'title'] }],
      ['owners', { name: 'owners', columns: ['id', 'name'] }],
    ]);
    expect(() =>
      validateImportBundle(
        {
          tables: [
            {
              name: 'items',
              columns: ['id', 'title'],
              rows: [{ id: '1', title: 'Proof' }],
            },
          ],
        },
        expected,
      ),
    ).toThrow('complete application schema');
    expect(() =>
      validateImportBundle(
        {
          tables: [
            {
              name: 'items',
              columns: ['id', 'title'],
              rows: [{ id: '1' }],
            },
            {
              name: 'owners',
              columns: ['id', 'name'],
              rows: [],
            },
          ],
        },
        expected,
      ),
    ).toThrow('incomplete columns');
  });

  it('keeps browser opening testable without launching a real browser', () => {
    expect(appDriver).toContain('SMRT_OPEN_STUB');
    expect(appDriver).toContain('waitForReady');
    expect(appDriver).toContain("platform() === 'darwin'");
    expect(appDriver).toContain("'xdg-open'");
  });

  it('provides separate deployed web and worker processes', () => {
    expect(worker).toContain('initializeDeployedApplicationRuntime');
    expect(worker).toContain('createTaskWorker');
    expect(worker).toContain('createScheduleWorker');
    expect(compose).toContain('worker:');
    expect(compose).toContain('schedule-worker:');
    expect(compose).toContain('migrate:');
    expect(compose).toContain('condition: service_completed_successfully');
    expect(compose).toContain('command: node build');
  });
});
