/**
 * Tests for `runAuthLogin` — focusing on the polling resilience added in
 * round 3. The device-code flow polls `/api/cli/auth/token` until the
 * user approves or the request expires; transient network errors must
 * not abort the whole login window. (#1311 review #2.)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAuthLogin } from '../commands/auth.js';
import type { CliConfigContext } from '../config.js';

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

let context: CliConfigContext;
let cfgBackup: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-app-cli-authtest-'));
  cfgBackup = process.env.AUTHTEST_CLI_CONFIG;
  process.env.AUTHTEST_CLI_CONFIG = join(dir, 'config.json');
  context = {
    envPrefix: 'AUTHTEST',
    appSlug: 'authtest',
    defaultServerUrl: 'https://example.test',
  };
});

afterEach(async () => {
  if (process.env.AUTHTEST_CLI_CONFIG) {
    await rm(process.env.AUTHTEST_CLI_CONFIG, { force: true }).catch(() => {});
  }
  process.env.AUTHTEST_CLI_CONFIG = cfgBackup;
});

describe('runAuthLogin polling resilience — #1311 review #2', () => {
  function mockFetch(responses: Array<{ status: number; body: unknown }>) {
    let i = 0;
    return vi.fn(async (url: string, _init?: RequestInit) => {
      const isStart = url.endsWith('/api/cli/auth/start');
      const isToken = url.endsWith('/api/cli/auth/token');
      if (isStart) {
        return new Response(
          JSON.stringify({
            deviceCode: 'dc_1',
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
            interval: 1,
            userCode: 'WG-XYZ',
            verificationUrl: 'https://example.test/cli',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (isToken) {
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  it('continues polling after a transient 503 and succeeds when server recovers', async () => {
    const stdout = buf();
    const stderr = buf();

    // Patch global fetch — auth.ts goes through requestJson which uses
    // global fetch by default.
    const realFetch = global.fetch;
    global.fetch = mockFetch([
      { status: 503, body: { error: 'temporarily unavailable' } },
      { status: 200, body: { status: 'pending', interval: 1 } },
      {
        status: 200,
        body: {
          status: 'approved',
          accessToken: 'tok_abc',
          tokenType: 'Bearer',
        },
      },
    ]) as any;

    try {
      await runAuthLogin(
        {
          context,
          stdout: stdout as any,
          stderr: stderr as any,
          noOpenDefault: true,
          sleepMs: () => Promise.resolve(),
        },
        [],
      );
    } finally {
      global.fetch = realFetch;
    }

    expect(stdout.contents()).toMatch(/Authenticated to /);
    // Warning surfaces the server-supplied error text; status-based
    // transient detection works off the `.status` property attached by
    // requestJson, not the message string.
    expect(stderr.contents()).toMatch(/auth poll:.*temporarily unavailable/);
  });

  it('continues polling after a fetch-level transient (network error)', async () => {
    const stdout = buf();
    const stderr = buf();

    const realFetch = global.fetch;
    let callCount = 0;
    global.fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/cli/auth/start')) {
        return new Response(
          JSON.stringify({
            deviceCode: 'dc_1',
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
            interval: 1,
            userCode: 'WG-XYZ',
            verificationUrl: 'https://example.test/cli',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError('fetch failed');
      }
      return new Response(
        JSON.stringify({
          status: 'approved',
          accessToken: 'tok_xyz',
          tokenType: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    try {
      await runAuthLogin(
        {
          context,
          stdout: stdout as any,
          stderr: stderr as any,
          noOpenDefault: true,
          sleepMs: () => Promise.resolve(),
        },
        [],
      );
    } finally {
      global.fetch = realFetch;
    }

    expect(stdout.contents()).toMatch(/Authenticated to /);
    expect(stderr.contents()).toMatch(/auth poll:.*fetch failed/);
  });

  it('still throws on non-transient 400 errors (malformed request)', async () => {
    const realFetch = global.fetch;
    global.fetch = mockFetch([
      { status: 400, body: { error: 'invalid device code' } },
    ]) as any;

    try {
      await expect(
        runAuthLogin(
          {
            context,
            stdout: buf() as any,
            stderr: buf() as any,
            noOpenDefault: true,
            sleepMs: () => Promise.resolve(),
          },
          [],
        ),
      ).rejects.toThrow();
    } finally {
      global.fetch = realFetch;
    }
  });
});
