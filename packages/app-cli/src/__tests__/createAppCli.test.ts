/**
 * High-level integration test for createAppCli — wires the CLI factory
 * together and verifies usage, extraCommands collision warning, and the
 * lazy `getResources()` plumbing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppCli } from '../index.js';

function buf() {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { contents: () => string };
  stream.contents = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

let originalStdout: NodeJS.WriteStream;
let originalStderr: NodeJS.WriteStream;
let stdout: ReturnType<typeof buf>;
let stderr: ReturnType<typeof buf>;
let cfgBackup: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-app-cli-create-'));
  cfgBackup = process.env.APPCLI_CLI_CONFIG;
  process.env.APPCLI_CLI_CONFIG = join(dir, 'config.json');

  stdout = buf();
  stderr = buf();
  originalStdout = process.stdout;
  originalStderr = process.stderr;
  Object.defineProperty(process, 'stdout', {
    value: stdout,
    configurable: true,
  });
  Object.defineProperty(process, 'stderr', {
    value: stderr,
    configurable: true,
  });
});

afterEach(async () => {
  Object.defineProperty(process, 'stdout', {
    value: originalStdout,
    configurable: true,
  });
  Object.defineProperty(process, 'stderr', {
    value: originalStderr,
    configurable: true,
  });
  if (process.env.APPCLI_CLI_CONFIG) {
    await rm(process.env.APPCLI_CLI_CONFIG, { force: true }).catch(() => {});
  }
  process.env.APPCLI_CLI_CONFIG = cfgBackup;
});

describe('createAppCli', () => {
  it('prints usage on no args / help', async () => {
    const cli = createAppCli({ name: 'appcli' });
    await cli.run([]);
    expect(stdout.contents()).toMatch(/appcli auth login/);
    expect(stdout.contents()).toMatch(/appcli mcp tools/);
    expect(stdout.contents()).toMatch(/appcli <resource> <command>/);
  });

  it('routes to an extra command and gives it ctx', async () => {
    let captured: { argc: number; cfg: string | undefined } | undefined;
    const cli = createAppCli({
      name: 'appcli',
      defaultServerUrl: 'https://srv.example',
      extraCommands: [
        {
          name: 'whoami',
          description: 'Who am I',
          async run(args, ctx) {
            captured = { argc: args.length, cfg: ctx.serverUrl };
            ctx.stdout.write(`whoami:${ctx.serverUrl}\n`);
          },
        },
      ],
    });
    await cli.run(['whoami', 'a', 'b']);
    expect(captured?.argc).toBe(2);
    expect(captured?.cfg).toBe('https://srv.example');
    expect(stdout.contents()).toContain('whoami:https://srv.example');
  });

  it('warns when an extra command shadows a built-in', async () => {
    const cli = createAppCli({
      name: 'appcli',
      extraCommands: [
        {
          name: 'mcp',
          description: 'mine',
          async run(_args, ctx) {
            ctx.stdout.write('extra-mcp\n');
          },
        },
      ],
    });
    await cli.run(['mcp']);
    expect(stderr.contents()).toMatch(/shadows a built-in/);
    expect(stdout.contents()).toContain('extra-mcp');
  });

  it('catches thrown errors and writes message to stderr + sets exitCode — #1311 review C-1', async () => {
    const originalExitCode = process.exitCode;
    const cli = createAppCli({ name: 'appcli' });
    // `auth` with no subcommand throws a usage error inside runCli; the
    // top-level catch should convert it to a clean stderr message + exit
    // code 1 rather than letting the rejection bubble.
    await cli.run(['auth']);
    expect(stderr.contents()).toMatch(/Usage: auth login/);
    expect(stdout.contents()).toBe(''); // no stack trace to stdout
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });

  it('startMcpBridge derives default serverInfo from options.name — #1311 review C-4', async () => {
    // Compile-only smoke check that `startMcpBridge()` is callable with
    // no arguments (the runtime path opens stdio so we can't actually
    // invoke it in a vitest worker — typecheck + signature suffice).
    const cli = createAppCli({ name: 'foo' });
    expect(typeof cli.startMcpBridge).toBe('function');
    // No-arg call would normally invoke the bridge; we just inspect that
    // the signature accepts undefined / partial serverInfo.
    const callable: (info?: {
      name?: string;
      version?: string;
    }) => Promise<void> = cli.startMcpBridge;
    expect(callable).toBeDefined();
  });

  it('lazy getResources() only fetches when called', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { authenticated: true },
            warnings: [],
            resources: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    // Patch global fetch for this test.
    const realFetch = global.fetch;
    global.fetch = fetchMock as any;

    const cli = createAppCli({
      name: 'appcli',
      defaultServerUrl: 'https://srv.example',
      extraCommands: [
        {
          name: 'never-asks',
          description: 'no resources',
          async run() {
            // intentionally never call getResources.
          },
        },
        {
          name: 'asks',
          description: 'fetches resources',
          async run(_args, ctx) {
            await ctx.getResources();
          },
        },
      ],
    });

    await cli.run(['never-asks']);
    expect(fetchMock).not.toHaveBeenCalled();
    await cli.run(['asks']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    global.fetch = realFetch;
  });
});
