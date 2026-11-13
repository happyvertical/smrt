// The owner pastes a provider key in Settings and the assistant uses it.
// Real SQLite shell.db, real SecretService sealed under a test master key,
// the real registered user resolver and the real route actions; the model is
// a stub, so nothing reaches a network.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const getAI = vi.fn();
vi.mock('@happyvertical/ai', () => ({ getAI }));

import {
  assistantStatus,
  resolveAssistantOptions,
} from '$lib/server/assistant/config';
import { createAiModelFactory } from '$lib/server/assistant/model';
import { installShellInference, shellInference } from '$lib/server/inference';
import {
  openShell,
  type ShellHarness,
  TEST_MASTER_KEY,
} from '$lib/server/test-support';
import { actions, load } from './+page.server';

const API_KEY = 'sk-test-shell-roundtrip-0123456789';
const ENV_KEY = 'sk-ant-env-0123456789';

let h: ShellHarness;
const output: string[] = [];

const localsOf = (who: { id: string; tenantId: string }) => ({
  user: { id: who.id },
  tenantId: who.tenantId,
  permissions: [] as string[],
});

function form(payload: unknown): Request {
  const body = new FormData();
  body.set('payload', JSON.stringify(payload));
  return new Request('http://localhost/settings/inference?/saveKey', {
    method: 'POST',
    body,
  });
}

async function saveKey(
  who: { id: string; tenantId: string },
  payload: unknown,
) {
  return (actions.saveKey as (e: unknown) => Promise<unknown>)({
    request: form(payload),
    locals: localsOf(who),
  });
}

async function loadAs(who: { id: string; tenantId: string }) {
  return (await (load as (e: unknown) => unknown)({
    locals: localsOf(who),
    url: new URL('http://localhost/settings/inference'),
    depends: () => {},
  })) as { defaults: { keySet: boolean } };
}

beforeAll(async () => {
  h = await openShell();
  for (const stream of [process.stdout, process.stderr]) {
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as never);
  }
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
  }
  // What `smrt.ts` does at startup.
  installShellInference();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h.close();
});
afterEach(() => getAI.mockReset());

describe('Inference settings for the shell owner', () => {
  it('has no key and an unconfigured assistant on a fresh app', async () => {
    expect((await loadAs(h.owner)).defaults.keySet).toBe(false);
    await expect(
      resolveAssistantOptions(h.owner, { env: {} }),
    ).rejects.toMatchObject({ code: 'assistant_not_configured' });
    expect(await assistantStatus(h.owner, { env: {} })).toMatchObject({
      configured: false,
    });
  });

  it('saves a key, shows it as set, and the assistant resolves and runs on it', async () => {
    const saved = await saveKey(h.owner, { provider: 'openai', key: API_KEY });
    expect(saved).toMatchObject({ ok: true });

    const page = await loadAs(h.owner);
    expect(page.defaults.keySet).toBe(true);
    // The browser never receives a key.
    expect(JSON.stringify(page)).not.toContain(API_KEY);

    // Same process, no restart: the assistant's resolver finds the key.
    const options = await resolveAssistantOptions(h.owner, { env: {} });
    expect(options).toMatchObject({ apiKey: API_KEY });
    expect(await assistantStatus(h.owner, { env: {} })).toEqual({
      configured: true,
    });

    // The production factory builds its client from those options.
    const chat = vi.fn(async () => ({ content: 'hi there', toolCalls: [] }));
    getAI.mockResolvedValue({ chat });
    const model = await createAiModelFactory({ env: {} })({
      principal: h.owner,
    });
    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: API_KEY }),
    );
    const reply = await model.complete({
      messages: [],
      tools: [],
      maxTokens: 10,
      signal: new AbortController().signal,
      onText: () => {},
    });
    expect(reply.text).toBe('hi there');
  });

  it('seals the key at rest and keeps it out of every log', async () => {
    const rows = await h.db.query('SELECT * FROM secrets');
    expect(JSON.stringify(rows.rows)).not.toContain(API_KEY);
    const written = output.join('\n');
    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain(TEST_MASTER_KEY);
  });

  it('prefers the saved key over the environment, and the environment still works without one', async () => {
    const env = { ANTHROPIC_API_KEY: ENV_KEY };
    // The saved key wins over config/env for the owner.
    expect(await resolveAssistantOptions(h.owner, { env })).toMatchObject({
      apiKey: API_KEY,
    });
    // Another principal (no saved key) falls through to the environment.
    const fallback = await resolveAssistantOptions(
      { ...h.owner, id: 'u-someone-else' },
      { env },
    );
    expect(fallback).toMatchObject({ apiKey: ENV_KEY });
  });

  it('refuses a key it cannot bind without echoing it', async () => {
    const outcome = (await saveKey(h.owner, {
      provider: 'no-such-provider-xyz',
      key: API_KEY,
    })) as { status: number; data: { error: string } };
    expect(outcome.status).toBeGreaterThanOrEqual(400);
    expect(outcome.data.error).not.toContain(API_KEY);
  });

  it('refuses a member and a stranger before reading the request, and writes nothing', async () => {
    for (const who of [h.member, h.stranger]) {
      const request = form({
        provider: 'openai',
        key: 'sk-intruder-0123456789',
      });
      await expect(
        (actions.saveKey as (e: unknown) => Promise<unknown>)({
          request,
          locals: localsOf(who),
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(request.bodyUsed).toBe(false);
      await expect(loadAs(who)).rejects.toMatchObject({ status: 403 });
    }
    // Nobody signed in.
    await expect(
      (actions.saveKey as (e: unknown) => Promise<unknown>)({
        request: form({}),
        locals: { user: null, tenantId: null, permissions: [] },
      }),
    ).rejects.toMatchObject({ status: 401 });
    // The intruder's key was never stored: the member resolves nothing of its own.
    const bindings = await shellInference().userResolver().resolveBindings();
    expect(JSON.stringify(bindings)).not.toContain('sk-intruder');
  });
});

describe('first-start schema', () => {
  it('creates the inference, preference and secrets tables', async () => {
    const tables = (
      await h.db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
    ).rows.map((row) => String(row.name));
    expect(tables).toEqual(
      expect.arrayContaining([
        '_smrt_inference_overrides',
        'secrets',
        'secret_audit_logs',
        'tenant_keys',
      ]),
    );
    expect(tables.some((name) => name.includes('preference'))).toBe(true);
  });
});
