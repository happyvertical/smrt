// The CLI's transport to the hosted receiver (#5638): the link token goes only
// in the Authorization header of one POST to the receive route, and no failure
// ever shows it.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CloudMigrationError } from '../cloud-migration.js';
import {
  createReceiveTransport,
  isReceiveToken,
  RECEIVE_PATH,
  RECEIVE_TOKEN_ENV,
  runReceiveOperation,
} from '../receive-transport.js';
import type { AppContext } from '../runtime.js';
import type { UserAppSection } from '../user-app-portability.js';

const SECRET = 'S3cret'.repeat(8).slice(0, 43);
const TOKEN = `smrt-rl1.0b1f1f1e-5c2a-4d7e-9a53-1c0d2e3f4a5b.${SECRET}`;
const ORIGIN = 'https://hosted.example.test';
const section = {
  digest: 'sha256-abc',
  version: 1,
} as unknown as UserAppSection;

type Call = { url: string; init: RequestInit };
const fakeFetch = (
  respond: (call: Call) => Response | Promise<Response>,
  calls: Call[] = [],
) =>
  Object.assign(
    (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
    { calls },
  );
const ok = (extra: object = {}) =>
  new Response(
    JSON.stringify({
      status: 'received',
      digest: 'sha256-abc',
      verified: true,
      ...extra,
    }),
    { status: 200 },
  );

describe('createReceiveTransport', () => {
  it('posts the section once to the receive route with the token only in the header', async () => {
    const f = fakeFetch(() => ok());
    const t = createReceiveTransport({
      origin: ORIGIN,
      token: TOKEN,
      fetch: f,
    });
    expect(await t.receiveUserApp?.(section)).toEqual({
      status: 'received',
      digest: 'sha256-abc',
      verified: true,
    });
    const [call] = f.calls;
    expect(call.url).toBe(`${ORIGIN}${RECEIVE_PATH}`);
    expect(call.url).not.toContain('?');
    expect(call.url).not.toContain(SECRET);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect((call.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(String(call.init.body)).not.toContain(SECRET);
    expect(JSON.parse(String(call.init.body))).toEqual({ bundle: section });
  });

  it('refuses a malformed token, a plain-http or non-bare origin before any request', () => {
    const f = fakeFetch(() => ok());
    for (const token of [
      '',
      'nonsense',
      `${TOKEN}x`,
      TOKEN.replace('smrt-rl1', 'smrt-rl2'),
    ])
      expect(() =>
        createReceiveTransport({ origin: ORIGIN, token, fetch: f }),
      ).toThrow(CloudMigrationError);
    for (const origin of [
      'http://hosted.example.test',
      `${ORIGIN}/path`,
      `${ORIGIN}?a=1`,
      'https://u:p@hosted.example.test',
    ])
      expect(() =>
        createReceiveTransport({ origin, token: TOKEN, fetch: f }),
      ).toThrow();
    expect(() =>
      createReceiveTransport({
        origin: 'http://localhost:5173',
        token: TOKEN,
        fetch: f,
      }),
    ).not.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it('never shows the token in a refusal, even one that echoes it', async () => {
    for (const respond of [
      () =>
        new Response(
          JSON.stringify({ error: `bad ${TOKEN} / Bearer ${TOKEN}` }),
          { status: 401 },
        ),
      () =>
        new Response(JSON.stringify({ error: `bad ${SECRET}` }), {
          status: 409,
        }),
      () => new Response('<html>nope</html>', { status: 502 }),
    ]) {
      const t = createReceiveTransport({
        origin: ORIGIN,
        token: TOKEN,
        fetch: fakeFetch(respond),
      });
      const error = await t.receiveUserApp?.(section).catch((e: Error) => e);
      expect(error).toBeInstanceOf(CloudMigrationError);
      expect((error as Error).message).not.toContain(SECRET);
      expect((error as Error).message).toMatch(/HTTP \d+/);
    }
    const net = createReceiveTransport({
      origin: ORIGIN,
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError(`fetch failed for ${TOKEN}`);
      }) as unknown as typeof fetch,
    });
    const error = (await net
      .receiveUserApp?.(section)
      .catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('could not be reached');
  });

  it('hands an unverified answer back so the journal does not record it', async () => {
    const t = createReceiveTransport({
      origin: ORIGIN,
      token: TOKEN,
      fetch: fakeFetch(() => ok({ verified: false })),
    });
    expect((await t.receiveUserApp?.(section))?.verified).toBe(false);
    const odd = createReceiveTransport({
      origin: ORIGIN,
      token: TOKEN,
      fetch: fakeFetch(
        () =>
          new Response(JSON.stringify({ status: 'weird' }), { status: 200 }),
      ),
    });
    await expect(odd.receiveUserApp?.(section)).rejects.toThrow(/unexpected/);
  });

  it('recognises the token shape only', () => {
    expect(isReceiveToken(TOKEN)).toBe(true);
    expect(isReceiveToken(`${TOKEN}\n`)).toBe(false);
    expect(isReceiveToken(undefined)).toBe(false);
  });
});

describe('smrt app receive', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'receive-cmd-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'export.json');
  writeFileSync(
    file,
    JSON.stringify({ application: 'demo', userApp: section }),
    { mode: 0o600 },
  );
  const context = (f: typeof fetch) => {
    const out: string[] = [];
    return {
      out,
      ctx: {
        sourceRoot: dir,
        appId: 'demo',
        io: { stdout: (t: string) => void out.push(t), stderr: () => {} },
        deps: { fetch: f },
      } as unknown as AppContext,
    };
  };

  it('sends the export section with the token from the environment only', async () => {
    const f = fakeFetch(() => ok());
    const { ctx, out } = context(f);
    expect(
      await runReceiveOperation(ctx, ['--origin', ORIGIN, '--bundle', file], {
        [RECEIVE_TOKEN_ENV]: TOKEN,
      }),
    ).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(out.join('')).toContain('"verified":true');
    expect(out.join('')).not.toContain(SECRET);
  });

  it('refuses without a token, with a token as an argument, or with a mismatched digest', async () => {
    const f = fakeFetch(() => ok());
    const { ctx } = context(f);
    await expect(
      runReceiveOperation(ctx, ['--origin', ORIGIN, '--bundle', file], {}),
    ).rejects.toThrow(RECEIVE_TOKEN_ENV);
    await expect(
      runReceiveOperation(
        ctx,
        ['--origin', ORIGIN, '--bundle', file, '--token', TOKEN],
        {},
      ),
    ).rejects.toThrow(/Unknown/);
    await expect(
      runReceiveOperation(ctx, [], { [RECEIVE_TOKEN_ENV]: TOKEN }),
    ).rejects.toThrow(/Usage/);
    const wrong = context(fakeFetch(() => ok({ digest: 'sha256-other' })));
    await expect(
      runReceiveOperation(wrong.ctx, ['--origin', ORIGIN, '--bundle', file], {
        [RECEIVE_TOKEN_ENV]: TOKEN,
      }),
    ).rejects.toThrow(/did not confirm/);
    expect(f.calls).toHaveLength(0);
  });
});
