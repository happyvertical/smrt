import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  checkComposeFile,
  DeployCommandError,
  deployChartValuesCommand,
  deployCheckCommand,
  parseImageOptions,
  resolveComposeFile,
} from '../deploy.js';
import { utilityCommands } from '../utilities.js';

const digest = `ghcr.io/acme/app@sha256:${'a'.repeat(64)}`;

const compose = `
x-defaults: &defaults
  build: .
x-happyvertical:
  version: 1
  preset: smrt
  domain: app.example.com
  migrate:
    command: ["pnpm", "exec", "smrt", "db:migrate"]
name: acme
services:
  web:
    <<: *defaults
    command: node build
    ports: ["3000:3000"]
    x-happyvertical:
      role: web
      health: { path: /health }
  worker:
    <<: *defaults
    command: node worker.js
    x-happyvertical:
      role: worker
      health: { command: ["node", "check.js"] }
  database:
    image: postgres:18-alpine
    x-happyvertical: { binding: postgres }
`;

const inputs = {
  release: { id: 'release-001', phase: 'maintenance', sequence: 0, attempt: 1 },
  app: { environment: 'production' },
  bindings: {
    postgres: {
      runtime: { secretName: 'app-runtime-v1', secretKey: 'uri' },
      migration: { secretName: 'app-migration-v1', secretKey: 'uri' },
    },
  },
  defaults: {
    resources: { requests: { cpu: '100m' }, limits: { cpu: '1' } },
    terminationGracePeriodSeconds: 90,
  },
  maintenance: { port: 8080 },
  ingress: { className: 'nginx' },
};

describe('deploy commands', () => {
  let directory: string;
  let previous: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'smrt-deploy-'));
    previous = process.cwd();
    process.chdir(directory);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    process.chdir(previous);
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  const write = (name: string, content: string) => {
    writeFileSync(join(directory, name), content);
    return join(directory, name);
  };
  const printed = () => log.mock.calls.map((call) => call[0]).join('\n');
  const failed = () => error.mock.calls.map((call) => call[0]).join('\n');

  it('is registered with the CLI', () => {
    expect(utilityCommands['deploy:check']).toBe(deployCheckCommand);
    expect(utilityCommands['deploy:chart-values']).toBe(
      deployChartValuesCommand,
    );
  });

  it('finds the Compose file the way Compose does', () => {
    expect(() => resolveComposeFile(directory, undefined)).toThrow(
      /No Compose file found/,
    );
    write('docker-compose.yml', compose);
    expect(resolveComposeFile(directory, undefined)).toBe(
      join(directory, 'docker-compose.yml'),
    );
    write('compose.yaml', compose);
    expect(resolveComposeFile(directory, undefined)).toBe(
      join(directory, 'compose.yaml'),
    );
    expect(resolveComposeFile(directory, 'docker-compose.yml')).toBe(
      join(directory, 'docker-compose.yml'),
    );
    expect(() => resolveComposeFile(directory, 'missing.yaml')).toThrow(
      DeployCommandError,
    );
  });

  it('parses repeatable --image options', () => {
    expect(parseImageOptions(undefined)).toEqual({});
    expect(parseImageOptions(`web=${digest}`)).toEqual({ web: digest });
    expect(parseImageOptions([`web=${digest}`, `worker=${digest}`])).toEqual({
      web: digest,
      worker: digest,
    });
    for (const bad of ['web', '=image', 'web=']) {
      expect(() => parseImageOptions(bad)).toThrow(/service=image/);
    }
  });

  it('honours YAML merge keys and reports invalid YAML plainly', () => {
    const result = checkComposeFile(write('compose.yaml', compose), {});
    expect(result.errors).toEqual([]);
    expect(result.declaration?.workloads.map((item) => item.name)).toEqual([
      'web',
      'worker',
    ]);
    expect(() =>
      checkComposeFile(write('broken.yaml', 'services: [unclosed'), {}),
    ).toThrow(/is not valid YAML/);
  });

  it('deploy:check prints a passing report', async () => {
    write('compose.yaml', compose);
    await requireCommandHandler(deployCheckCommand)([], {});
    expect(printed()).toContain('The deployment declaration is valid.');
    expect(printed()).toContain('Runs: web (web, port 3000), worker (worker)');
  });

  it('deploy:check exits 1 with the problems and their fixes', async () => {
    write('compose.yaml', compose.replace('preset: smrt', 'preset: rails'));
    await expect(
      requireCommandHandler(deployCheckCommand)([], {}),
    ).rejects.toThrow('exit:1');
    expect(printed()).toContain('The deployment declaration has 1 problem.');
    expect(printed()).toContain('Fix: Set `preset` to one of: `smrt`.');
  });

  it('deploy:check --deploy requires digests and --image supplies them', async () => {
    write('compose.yaml', compose);
    await expect(
      requireCommandHandler(deployCheckCommand)([], { deploy: true }),
    ).rejects.toThrow('exit:1');
    expect(printed()).toContain('never runs `build:`');

    log.mockClear();
    await requireCommandHandler(deployCheckCommand)(['compose.yaml'], {
      image: [`web=${digest}`, `worker=${digest}`],
      json: true,
    });
    const report = JSON.parse(printed());
    expect(report.ok).toBe(true);
    expect(report.declaration.stage).toBe('deploy');
    expect(report.declaration.migrate.image).toBe(digest);
  });

  it('deploy:check reports a missing file without a stack trace', async () => {
    await expect(
      requireCommandHandler(deployCheckCommand)([], {}),
    ).rejects.toThrow('exit:1');
    expect(failed()).toContain('No Compose file found');
  });

  it('deploy:chart-values prints chart values as JSON', async () => {
    write('compose.yaml', compose);
    write('inputs.json', JSON.stringify(inputs));
    await requireCommandHandler(deployChartValuesCommand)([], {
      inputs: 'inputs.json',
      image: [`web=${digest}`, `worker=${digest}`],
    });
    const values = JSON.parse(printed());
    expect(values.app).toEqual({ name: 'acme', environment: 'production' });
    expect(values.current).toBe(false);
    expect(Object.keys(values.target.workloads)).toEqual(['web', 'worker']);
    expect(values.target.migration.image).toBe(digest);
    expect(values.ingress.host).toBe('app.example.com');
  });

  it('deploy:chart-values refuses missing inputs, digests and bindings', async () => {
    write('compose.yaml', compose);
    const run = (options: Record<string, unknown>) =>
      expect(
        requireCommandHandler(deployChartValuesCommand)([], options),
      ).rejects.toThrow('exit:1');

    await run({});
    expect(failed()).toContain('needs --inputs');

    error.mockClear();
    await run({ inputs: 'missing.json' });
    expect(failed()).toContain('There is no file at');

    error.mockClear();
    write('inputs.json', JSON.stringify(inputs));
    await run({ inputs: 'inputs.json' });
    expect(failed()).toContain('never runs `build:`');

    error.mockClear();
    write('inputs.json', JSON.stringify({ ...inputs, bindings: {} }));
    await run({
      inputs: 'inputs.json',
      image: [`web=${digest}`, `worker=${digest}`],
    });
    expect(failed()).toContain('Cannot render smrt-app chart values');
    expect(failed()).toContain('no `bindings.postgres`');

    error.mockClear();
    write('inputs.json', '{');
    await run({ inputs: 'inputs.json' });
    expect(failed()).toContain('is not valid JSON');
  });
});
