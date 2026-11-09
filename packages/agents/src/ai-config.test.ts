import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachAiUsageRecorder,
  createAiUsageRecorder,
  ObjectRegistry,
  setInferenceResolver,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  Secret,
  SecretAuditLog,
  SecretService,
  TenantKey,
} from '@happyvertical/smrt-secrets';
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import { Tenant, TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent.js';
import { resolveAgentAIOptions } from './ai-config.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const secretsManifest = JSON.parse(
  readFileSync(
    resolve(FIXTURE_DIR, '../../secrets/dist/manifest.json'),
    'utf8',
  ),
);
const usersManifest = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, '../../users/dist/manifest.json'), 'utf8'),
);
const secretsRegistrationManifest = {
  ...secretsManifest,
  objects: {
    Secret: secretsManifest.objects['@happyvertical/smrt-secrets:Secret'],
    SecretAuditLog:
      secretsManifest.objects['@happyvertical/smrt-secrets:SecretAuditLog'],
    TenantKey: secretsManifest.objects['@happyvertical/smrt-secrets:TenantKey'],
  },
};
const usersRegistrationManifest = {
  ...usersManifest,
  objects: {
    Tenant: usersManifest.objects['@happyvertical/smrt-users:Tenant'],
  },
};

@smrt()
class GeminiSecretAgent extends Agent {
  protected config = {
    ai: {
      type: 'gemini',
      defaultModel: 'gemini-flash-latest',
      apiKeySecretFallback: 'ancestors' as const,
    },
  };

  async run(): Promise<void> {}
}

@smrt()
class NoAncestorFallbackAgent extends Agent {
  protected config = {
    ai: {
      type: 'gemini',
      defaultModel: 'gemini-flash-latest',
      apiKeySecretFallback: 'none' as const,
    },
  };

  async run(): Promise<void> {}
}

describe('agent AI secret resolution', () => {
  let db: DatabaseInterface;
  let secrets: SecretService;
  let tenants: TenantCollection;

  beforeEach(async () => {
    enableTenancy();
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;

    ObjectRegistry.register(Secret, {
      name: 'Secret',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(SecretAuditLog, {
      name: 'SecretAuditLog',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(TenantKey, {
      name: 'TenantKey',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(Tenant, {
      name: 'Tenant',
      packageName: '@happyvertical/smrt-users',
      _manifest: usersRegistrationManifest,
    });
    db = await getTestDatabase();
    secrets = await SecretService.create({ db });
    tenants = await TenantCollection.create({ db });
  });

  afterEach(() => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
    vi.restoreAllMocks();
  });

  async function createTenantHierarchy() {
    const root = await tenants.create({
      name: 'Anytown Network',
      slug: 'anytown',
    });
    await root.save();

    const child = await tenants.create({
      name: 'Bentley Alberta',
      slug: 'bentleyalberta',
      parentTenantId: root.id,
      hierarchyLevel: 1,
      hierarchyPath: root.id,
    });
    await child.save();

    return { root, child };
  }

  it('resolves the default provider secret from the current tenant', async () => {
    const { child } = await createTenantHierarchy();

    await withTenant({ tenantId: child.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'tenant-specific-key');

      const agent = new GeminiSecretAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('tenant-specific-key');
    });
  });

  it('falls back to ancestor tenant secrets by default', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new GeminiSecretAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('network-key');
    });
  });

  it('respects explicit api keys over tenant secrets', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new GeminiSecretAgent({
        db,
        ai: {
          type: 'gemini',
          apiKey: 'explicit-key',
          apiKeySecretFallback: 'ancestors',
        },
      });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('explicit-key');
    });
  });

  it('can opt out of ancestor fallback', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new NoAncestorFallbackAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBeUndefined();
    });
  });

  it('rethrows unexpected secret retrieval failures', async () => {
    const { child } = await createTenantHierarchy();

    vi.spyOn(SecretService.prototype, 'retrieve').mockRejectedValue(
      new Error('decrypt exploded'),
    );

    await expect(
      resolveAgentAIOptions({
        aiConfig: {
          type: 'gemini',
          defaultModel: 'gemini-flash-latest',
        },
        db,
        tenantId: child.id,
      }),
    ).rejects.toThrow('decrypt exploded');
  });

  describe('usage recording for per-call clients (#3077)', () => {
    const usageEvent = {
      provider: 'gemini',
      model: 'gemini-flash-latest',
      operation: 'chat',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      duration: 7,
      timestamp: new Date('2026-11-08T00:00:00.000Z'),
    };

    type UsageSink = { onUsage?: (event: unknown) => Promise<void> };

    it('wires an agent config so getAI(this.options.ai) records for the tenant', async () => {
      const { child } = await createTenantHierarchy();

      await withTenant({ tenantId: String(child.id) }, async () => {
        await secrets.store('GEMINI_API_KEY', 'tenant-specific-key');
        const agent = new GeminiSecretAgent({ db });
        await agent.initialize();

        const ai = agent.options.ai as UsageSink;
        expect(typeof ai.onUsage).toBe('function');
        await ai.onUsage?.(usageEvent);

        const rows = await agent.listAiUsage({
          className: 'GeminiSecretAgent',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          provider: 'gemini',
          model: 'gemini-flash-latest',
          tenantId: child.id,
        });
      });
    });

    it('resolveAgentAIOptions attaches a recorder when given a db', async () => {
      const { child } = await createTenantHierarchy();
      const agent = new GeminiSecretAgent({ db });
      await agent.initialize();

      const explicit = (await resolveAgentAIOptions({
        aiConfig: { type: 'gemini', apiKey: 'k' },
        db,
        tenantId: child.id,
        className: 'PerCallAgent',
      })) as UsageSink;
      await explicit.onUsage?.(usageEvent);

      const ambient = await withTenant(
        { tenantId: String(child.id) },
        async () => {
          const options = (await resolveAgentAIOptions({
            aiConfig: { type: 'gemini', apiKey: 'k' },
            db,
          })) as UsageSink;
          await options.onUsage?.(usageEvent);
          return options;
        },
      );
      expect(typeof ambient.onUsage).toBe('function');

      const rows = await agent.listAiUsage({ tenantId: child.id });
      expect(rows.map((row) => row.className).sort()).toEqual([
        'Agent',
        'PerCallAgent',
      ]);

      const unrecorded = (await resolveAgentAIOptions({
        aiConfig: { type: 'gemini', apiKey: 'k' },
        db,
        recordUsage: false,
      })) as UsageSink;
      expect(unrecorded.onUsage).toBeUndefined();
      const noDb = (await resolveAgentAIOptions({
        aiConfig: { type: 'gemini', apiKey: 'k' },
        db: undefined,
      })) as UsageSink;
      expect(noDb.onUsage).toBeUndefined();
    });

    it('keeps an explicit recorder attribution passed as agent ai (review round 3)', async () => {
      const { root, child } = await createTenantHierarchy();

      await withTenant({ tenantId: String(root.id) }, async () => {
        const agent = new GeminiSecretAgent({
          db,
          ai: attachAiUsageRecorder(
            { type: 'gemini', apiKey: 'explicit-key' },
            createAiUsageRecorder({
              tenantId: child.id,
              tags: { feature: 'per-call' },
            }),
          ),
        });
        await agent.initialize();
        await (agent.options.ai as UsageSink).onUsage?.(usageEvent);

        const rows = await agent.listAiUsage({
          className: 'GeminiSecretAgent',
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          tenantId: child.id,
          tags: { feature: 'per-call' },
        });
      });
    });
  });
  describe('stored inference bindings (#4756)', () => {
    const userTarget = {
      provider: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'user/model',
      apiKey: 'sk-user-binding',
      source: 'byo' as const,
    };

    afterEach(() => {
      setInferenceResolver(undefined);
    });

    it('falls through to the registered resolver when no agent secret is named', async () => {
      const { child } = await createTenantHierarchy();
      const requests: Array<Record<string, unknown>> = [];
      setInferenceResolver({
        resolve: (request) => {
          requests.push({ ...request });
          return {
            tierResolved: request.tier === 'auto' ? 'good' : request.tier,
            target: { ...userTarget },
            via: 'resolver',
          };
        },
      });

      // Initialized inside a user's request: the agent keeps the options
      // for every later run, so the resolver is told no user applies.
      await withTenant(
        { tenantId: String(child.id), userId: 'u-1' },
        async () => {
          await secrets.store('GEMINI_API_KEY', 'tenant-specific-key');
          const agent = new GeminiSecretAgent({ db });
          await agent.initialize();
          const ai = agent.options.ai as Record<string, unknown> & {
            onUsage?: (event: unknown) => Promise<void>;
          };
          expect(ai).toMatchObject({
            provider: 'openai',
            model: 'user/model',
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKey: 'sk-user-binding',
          });
          await ai.onUsage?.({
            provider: 'openai',
            model: 'user/model',
            operation: 'chat',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
          const rows = await agent.listAiUsage({
            className: 'GeminiSecretAgent',
          });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            tenantId: child.id,
            tags: expect.objectContaining({ source: 'byo' }),
          });
        },
      );
      expect(requests[0]).toMatchObject({ tenantId: child.id, userId: null });

      // A named agent secret keeps the secret path.
      await withTenant({ tenantId: String(child.id) }, async () => {
        await secrets.store('AGENT_KEY', 'agent-key');
        const named = await resolveAgentAIOptions({
          aiConfig: {
            type: 'gemini',
            defaultModel: 'gemini-flash-latest',
            apiKeySecretName: 'AGENT_KEY',
          },
          db,
          recordUsage: false,
        });
        expect(named).toMatchObject({ type: 'gemini', apiKey: 'agent-key' });
      });
    });

    it('re-resolves on every initialize, so a rotated tenant binding or secret is not kept', async () => {
      const { child } = await createTenantHierarchy();
      let key = 'sk-first';
      setInferenceResolver({
        resolve: (request) => ({
          tierResolved: request.tier === 'auto' ? 'good' : request.tier,
          target: { ...userTarget, apiKey: key },
          via: 'resolver',
        }),
      });
      await withTenant({ tenantId: String(child.id) }, async () => {
        const agent = new GeminiSecretAgent({ db });
        await agent.initialize();
        expect(agent.options.ai).toMatchObject({ apiKey: 'sk-first' });
        key = 'sk-rotated';
        await agent.initialize();
        expect(agent.options.ai).toMatchObject({ apiKey: 'sk-rotated' });

        // The tenant secret path re-reads too once the binding is removed.
        setInferenceResolver(undefined);
        await secrets.store('GEMINI_API_KEY', 'secret-one');
        await agent.initialize();
        expect(agent.options.ai).toMatchObject({ apiKey: 'secret-one' });
        await secrets.store('GEMINI_API_KEY', 'secret-two');
        await agent.initialize();
        expect(agent.options.ai).toMatchObject({ apiKey: 'secret-two' });
      });
    });

    it('keeps the agent config against an app inference binding', async () => {
      setInferenceResolver({
        resolve: (request) => ({
          tierResolved: request.tier === 'auto' ? 'good' : request.tier,
          target: { provider: 'openai', model: 'app-model', source: 'app' },
          via: 'resolver',
        }),
      });
      const options = await resolveAgentAIOptions({
        aiConfig: { type: 'gemini', defaultModel: 'gemini-flash-latest' },
        db: undefined,
      });
      expect(options).toMatchObject({ type: 'gemini' });
      expect(options).not.toHaveProperty('provider', 'openai');
    });
  });
});
