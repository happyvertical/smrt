/**
 * Inference mode and the typed AI-unavailable state (#4757): every AI entry
 * point throws `InferenceUnavailableError` (`AI_UNAVAILABLE`) with the right
 * reason before any client is built, `is()` never answers `false` for it,
 * nothing reaches the usage pipeline, and the probe / status endpoint answer
 * without calling a model.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import { field } from '../decorators';
import { ErrorUtils } from '../errors.js';
import { handleInferenceStatusRoute } from '../generators/inference-status-route.js';
import {
  type InferenceResolver,
  resolveInferenceMode,
  setInferenceResolver,
} from '../inference.js';
import {
  AI_UNAVAILABLE,
  type InferenceMode,
  InferenceUnavailableError,
  isInferenceUnavailableError,
} from '../inference-availability.js';
import {
  createInferenceStatusHandler,
  getInferenceStatus,
  isInferenceAvailable,
} from '../inference-status.js';
import { resolveInferenceTarget } from '../inference-target.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

@smrt()
class Issue4757Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = 'note';
}

const ENV_KEYS = [
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_MODEL',
  'OPENAI_API_KEY',
  'HAVE_AI_BASE_URL',
  'HAVE_AI_API_KEY',
  'SMRT_INFERENCE_DEFAULT_TIER',
];

const BASE_AI = { provider: 'openai', apiKey: 'sk-base', model: 'base-model' };

/**
 * A resolver whose stored mode the test flips, standing in for the
 * per-user resolver (#4756) after a settings write invalidated its cache.
 */
function switchableResolver(initial: InferenceMode): InferenceResolver & {
  mode: NonNullable<InferenceResolver['mode']>;
  set(next: InferenceMode): void;
} {
  let current = initial;
  return {
    set(next) {
      current = next;
    },
    resolve(request) {
      const tierResolved =
        request.tier === 'auto' ? 'good' : (request.tier as 'good');
      if (current === 'off') {
        return {
          tierResolved,
          target: {},
          via: 'resolver',
          mode: 'off',
          unavailable: 'off',
        };
      }
      return {
        tierResolved,
        via: 'resolver',
        mode: current,
        target: {
          provider: 'openai',
          baseUrl: 'https://byo.example/v1',
          apiKey: 'sk-user',
          model: 'user-model',
          source: 'byo',
        },
      };
    },
    mode() {
      return current === 'off'
        ? { mode: 'off', unavailable: 'off' }
        : { mode: current };
    },
  };
}

async function expectUnavailable(
  promise: Promise<unknown>,
  reason: string,
): Promise<InferenceUnavailableError> {
  const error = await promise.then(
    (value) => {
      throw new Error(`expected AI_UNAVAILABLE, got ${String(value)}`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(InferenceUnavailableError);
  const typed = error as InferenceUnavailableError;
  expect(typed.code).toBe(AI_UNAVAILABLE);
  expect(typed.reason).toBe(reason);
  return typed;
}

describe('#4757 typed AI-unavailable state', () => {
  const saved: Record<string, string | undefined> = {};
  const usage = { handle: vi.fn(async () => {}) };

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    usage.handle.mockClear();
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (options: Record<string, unknown>) => ({
      embed: () => {},
      message: vi.fn(async () => '{"result": true}'),
      options,
    }));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
  });

  describe('unconfigured (no provider anywhere)', () => {
    it('throws unconfigured from do(), describe(), is() and evaluate()', async () => {
      const note = new Issue4757Note({ usage: { handlers: [usage] } } as never);
      const doError = await expectUnavailable(
        note.do('summarize'),
        'unconfigured',
      );
      expect(doError.mode).toBe('off');
      expect(doError.retryable).toBe(false);
      expect(doError.message).not.toMatch(/sk-|stack/);
      await expectUnavailable(note.describe(), 'unconfigured');
      // is() never turns the unavailable state into `false` (#3158).
      await expectUnavailable(note.is('is a note'), 'unconfigured');
      await expectUnavailable(note.evaluate('is a note'), 'unconfigured');
      await expectUnavailable(
        note.do('summarize', { tier: 'great' }),
        'unconfigured',
      ).then((error) => expect(error.tier).toBe('great'));
      expect(getAIMock).not.toHaveBeenCalled();
      expect(usage.handle).not.toHaveBeenCalled();
    });

    it('reports off / unconfigured from the probes', async () => {
      const note = new Issue4757Note({});
      expect(await note.getInferenceStatus()).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
      });
      expect(await note.getInferenceStatus({ tier: 'auto' })).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
        tier: 'good',
      });
      expect(await isInferenceAvailable()).toBe(false);
      expect(await getInferenceStatus({ tier: 'cheap' })).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
        tier: 'cheap',
      });
    });

    it('reports available with a configured provider', async () => {
      process.env.SMRT_AI_PROVIDER = 'openai';
      process.env.SMRT_AI_API_KEY = 'sk-env';
      expect(await getInferenceStatus()).toEqual({
        available: true,
        mode: 'hosted',
      });
      process.env.SMRT_AI_PROVIDER = 'ollama';
      expect(await getInferenceStatus({ tier: 'good' })).toEqual({
        available: true,
        mode: 'local',
        tier: 'good',
      });
      expect(getAIMock).not.toHaveBeenCalled();
    });
  });

  describe('mode off from the resolver', () => {
    it('throws off on every entry point, tiered and untiered, and records nothing', async () => {
      const resolver = switchableResolver('off');
      setInferenceResolver(resolver);
      const note = new Issue4757Note({
        ai: BASE_AI,
        usage: { handlers: [usage] },
      } as never);
      await expectUnavailable(note.do('summarize'), 'off');
      await expectUnavailable(note.do('summarize', { tier: 'good' }), 'off');
      await expectUnavailable(note.describe({ tier: 'auto' }), 'off');
      await expectUnavailable(note.is('is a note'), 'off');
      await expectUnavailable(
        note.evaluate('is a note', { tier: 'best' }),
        'off',
      );
      // Only the configured client was built at init; no call ran.
      const clients = await Promise.all(
        getAIMock.mock.results.map((result) => result.value),
      );
      for (const client of clients) {
        expect(client.message).not.toHaveBeenCalled();
      }
      expect(usage.handle).not.toHaveBeenCalled();
      expect(await note.getInferenceStatus({ tier: 'good' })).toEqual({
        available: false,
        mode: 'off',
        reason: 'off',
        tier: 'good',
      });
      expect(await note.isInferenceAvailable()).toBe(false);
    });

    it('takes a switch from off to byo on the next call, without restart', async () => {
      const resolver = switchableResolver('off');
      setInferenceResolver(resolver);
      const note = new Issue4757Note({ ai: BASE_AI } as never);
      await expectUnavailable(note.do('hi', { tier: 'good' }), 'off');
      resolver.set('byo');
      await expect(note.do('hi', { tier: 'good' })).resolves.toBe(
        '{"result": true}',
      );
      await expect(note.do('hi')).resolves.toBe('{"result": true}');
      expect(await note.getInferenceStatus({ tier: 'good' })).toEqual({
        available: true,
        mode: 'byo',
        tier: 'good',
      });
      resolver.set('off');
      await expectUnavailable(note.do('hi'), 'off');
    });

    it('throws from resolveInferenceTarget() for raw-client sites', async () => {
      setInferenceResolver(switchableResolver('off'));
      const error = await expectUnavailable(
        resolveInferenceTarget({ base: BASE_AI, className: 'Raw' }),
        'off',
      );
      expect(error.message).toContain('Raw');
      expect(error.tier).toBe('good');
    });

    it('routes untiered calls of an explicit mode through auto, never the configured client', async () => {
      // Explicit `byo` with no key: tiered and untiered calls are both
      // unconfigured, and the probe says so (review round 1).
      let bound = false;
      const requests: unknown[] = [];
      setInferenceResolver({
        resolve(request) {
          requests.push(request);
          const tierResolved = request.tier === 'auto' ? 'good' : request.tier;
          return bound
            ? {
                tierResolved,
                via: 'resolver',
                mode: 'byo',
                target: {
                  provider: 'openai',
                  baseUrl: 'https://byo.example/v1',
                  apiKey: 'sk-user',
                  model: 'user-model',
                  source: 'byo',
                },
              }
            : {
                tierResolved,
                target: {},
                via: 'resolver',
                mode: 'off',
                unavailable: 'unconfigured',
              };
        },
        mode: () => ({ mode: 'byo' }),
      });
      const note = new Issue4757Note({ ai: BASE_AI } as never);
      await expectUnavailable(note.do('hi'), 'unconfigured');
      await expectUnavailable(note.describe(), 'unconfigured');
      expect(await note.getInferenceStatus()).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
      });
      expect(await getInferenceStatus({ configured: BASE_AI })).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
      });

      // With the key stored, untiered calls run on the chosen binding with
      // its model and tier tags, not on the configured client.
      bound = true;
      await expect(note.do('hi')).resolves.toBe('{"result": true}');
      const built = getAIMock.mock.calls.map(
        ([options]) => (options as Record<string, unknown>).baseUrl,
      );
      expect(built).toContain('https://byo.example/v1');
      const byoClient = await getAIMock.mock.results.at(-1)?.value;
      expect(byoClient.message).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          model: 'user-model',
          usageTags: expect.objectContaining({
            tierRequested: 'auto',
            source: 'byo',
          }),
        }),
      );
      expect(JSON.stringify(byoClient.message.mock.calls)).not.toContain(
        '"tier"',
      );
      expect(await note.getInferenceStatus()).toEqual({
        available: true,
        mode: 'byo',
      });
      expect(requests.length).toBeGreaterThan(0);
    });

    it('a shared-client scope sends userId null to mode() and resolve()', async () => {
      class SharedNote extends Issue4757Note {
        protected override inferenceUserScope(): null {
          return null;
        }
      }
      const seen: unknown[] = [];
      setInferenceResolver({
        resolve(request) {
          seen.push(['resolve', request.userId]);
          return undefined;
        },
        mode(request) {
          seen.push(['mode', request.userId]);
          return request.userId === null
            ? undefined
            : { mode: 'off', unavailable: 'off' };
        },
      });
      const note = new SharedNote({ ai: BASE_AI } as never);
      await expect(note.do('hi')).resolves.toBe('{"result": true}');
      await expect(note.do('hi', { tier: 'good' })).resolves.toBe(
        '{"result": true}',
      );
      expect(seen).toContainEqual(['mode', null]);
      expect(seen).toContainEqual(['resolve', null]);
      // The default scope still reads the ambient user's mode.
      await expectUnavailable(
        new Issue4757Note({ ai: BASE_AI } as never).do('hi'),
        'off',
      );
    });

    it('leaves untiered calls alone for resolvers without mode()', async () => {
      setInferenceResolver({ resolve: () => undefined });
      expect(await resolveInferenceMode({})).toBeUndefined();
      const note = new Issue4757Note({ ai: BASE_AI } as never);
      await expect(note.do('hi')).resolves.toBe('{"result": true}');
    });

    it('rejects an unknown mode or reason from a resolver', async () => {
      setInferenceResolver({
        resolve: () => ({
          tierResolved: 'good',
          target: {},
          via: 'resolver',
          mode: 'sometimes' as never,
        }),
        mode: () => ({ mode: 'off', unavailable: 'later' as never }),
      });
      await expect(getInferenceStatus({ tier: 'good' })).rejects.toThrow(
        /unknown mode/,
      );
      await expect(getInferenceStatus()).rejects.toThrow(/unknown unavailable/);
    });
  });

  describe('error shape', () => {
    it('is typed, non-retryable and recognisable across core copies', () => {
      const error = new InferenceUnavailableError({
        reason: 'entitlement',
        mode: 'hosted',
        tier: 'best',
      });
      expect(error.mode).toBe('hosted');
      expect(error.toStatus()).toEqual({
        available: false,
        mode: 'hosted',
        reason: 'entitlement',
        tier: 'best',
      });
      expect(ErrorUtils.isRetryable(error)).toBe(false);
      expect(
        isInferenceUnavailableError({ code: AI_UNAVAILABLE, reason: 'off' }),
      ).toBe(true);
      expect(
        isInferenceUnavailableError({ code: AI_UNAVAILABLE, reason: 'nope' }),
      ).toBe(false);
      // off / unconfigured always report mode off.
      expect(
        new InferenceUnavailableError({ reason: 'off', mode: 'byo' }).mode,
      ).toBe('off');
    });
  });

  describe('inferenceStatus endpoints', () => {
    it('serves the status as JSON without a key, and 400s an unknown tier', async () => {
      setInferenceResolver(switchableResolver('byo'));
      const handler = createInferenceStatusHandler();
      const response = await handler({
        url: new URL('https://app.test/api/inference?tier=great'),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        available: true,
        mode: 'byo',
        tier: 'great',
      });
      expect(text).not.toContain('sk-user');
      expect(text).not.toContain('byo.example');
      const bad = await handler({
        url: new URL('https://app.test/api/inference?tier=fast'),
      });
      expect(bad.status).toBe(400);
    });

    it('runs the probe inside the host context and hides resolver failures', async () => {
      let runs = 0;
      const run = async <T>(_event: unknown, probe: () => Promise<T>) => {
        runs += 1;
        return probe();
      };
      setInferenceResolver({
        resolve: () => {
          throw new Error('secret store down: sk-leak');
        },
      });
      const response = await createInferenceStatusHandler({
        tier: 'good',
        run,
      })({ url: new URL('https://app.test/s') });
      expect(runs).toBe(1);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('sk-leak');
    });

    it('generated REST _inference route honours authMiddleware', async () => {
      const refused = await handleInferenceStatusRoute(
        new Request('https://api.test/api/_inference'),
        {
          authMiddleware: (objectName, action) => async () => {
            expect([objectName, action]).toEqual(['_inference', 'status']);
            return new Response('no', { status: 401 });
          },
        },
      );
      expect(refused.status).toBe(401);
      const open = await handleInferenceStatusRoute(
        new Request('https://api.test/api/_inference'),
      );
      expect(await open.json()).toEqual({
        available: false,
        mode: 'off',
        reason: 'unconfigured',
      });
      const post = await handleInferenceStatusRoute(
        new Request('https://api.test/api/_inference', { method: 'POST' }),
      );
      expect(post.status).toBe(405);
    });
  });
});
