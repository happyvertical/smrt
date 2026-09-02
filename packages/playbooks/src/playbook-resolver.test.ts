import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPlaybookCache, getPlaybookCacheTtlMs } from './cache.js';
import { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
import { definePlaybook, PlaybookRegistry } from './playbook-registry.js';
import { resolvePlaybook } from './playbook-resolver.js';
import type {
  PlaybookOperationStep,
  PlaybookPlan,
  PlaybookPlane,
} from './types.js';

const CHECKOUT_STEPS = [
  {
    kind: 'operation' as const,
    model: '@happyvertical/smrt-commerce:Order',
    action: 'submit',
    label: 'Submit the order',
  },
  {
    kind: 'operation' as const,
    model: '@happyvertical/smrt-commerce:Payment',
    action: 'capture',
  },
];

function expectPlan(resolution: Awaited<ReturnType<typeof resolvePlaybook>>) {
  if (!resolution.ok) {
    throw new Error(
      `expected a plan, got rejection "${resolution.reason}": ${resolution.message}`,
    );
  }
  return resolution.plan satisfies PlaybookPlan;
}

describe('@happyvertical/smrt-playbooks', () => {
  let db: DatabaseInterface;
  let overrides: PlaybookOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    PlaybookRegistry.clear();
    clearPlaybookCache();
    clearCache();

    setConfig({ packages: { playbooks: { playbooks: {} } } });

    db = await getTestDatabase({ classes: ['PlaybookOverride'] });
    overrides = await PlaybookOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearPlaybookCache();
    PlaybookRegistry.clear();
    clearCache();
    resetTenancy();
    vi.useRealTimers();

    if (typeof (db as any)?.close === 'function') {
      await (db as any).close();
    }
  });

  describe('registry and definition-time validation', () => {
    it('resolves a package-bundled playbook without any application registration', async () => {
      definePlaybook({
        key: 'commerce.cart.checkout',
        title: 'Check out this cart',
        description: 'Submits the order and captures payment.',
        steps: CHECKOUT_STEPS,
      });

      const plan = expectPlan(await resolvePlaybook('commerce.cart.checkout'));

      expect(plan.title).toBe('Check out this cart');
      expect(plan.steps.map((planStep) => planStep.step)).toEqual(
        CHECKOUT_STEPS,
      );
      // Operation-only playbooks are valid on both planes by default.
      expect(plan.planes).toEqual(['browser', 'server']);
    });

    it('rejects a playbook referencing another playbook at definition time', () => {
      expect(() =>
        definePlaybook({
          key: 'commerce.cart.nested',
          title: 'Nested',
          description: 'Nested playbook',
          steps: [{ kind: 'playbook', key: 'commerce.cart.checkout' } as never],
        }),
      ).toThrow('nested playbooks are not supported');

      expect(() =>
        definePlaybook({
          key: 'commerce.cart.nested-prop',
          title: 'Nested',
          description: 'Nested playbook',
          steps: [
            {
              kind: 'operation',
              model: '@happyvertical/smrt-commerce:Order',
              action: 'submit',
              playbook: 'commerce.cart.checkout',
            } as never,
          ],
        }),
      ).toThrow('nested playbooks are not supported');
    });

    it('rejects unqualified model references and unknown step kinds', () => {
      expect(() =>
        definePlaybook({
          key: 'commerce.cart.unqualified',
          title: 'Unqualified',
          description: 'Unqualified model reference',
          steps: [
            { kind: 'operation', model: 'Order', action: 'submit' } as never,
          ],
        }),
      ).toThrow('must be a qualified pair');

      expect(() =>
        definePlaybook({
          key: 'commerce.cart.unknown-kind',
          title: 'Unknown',
          description: 'Unknown step kind',
          steps: [{ kind: 'tool', name: 'smrt_order_submit' } as never],
        }),
      ).toThrow('unknown kind');
    });

    it('refuses to mark steps editable', () => {
      expect(() =>
        definePlaybook({
          key: 'commerce.cart.editable-steps',
          title: 'Editable steps',
          description: 'Attempts to mark steps editable',
          steps: CHECKOUT_STEPS,
          editable: { steps: true } as never,
        }),
      ).toThrow('step lists are never editable');
    });

    it('deep-freezes the registered definition so declared policy cannot be mutated', () => {
      const definition = definePlaybook({
        key: 'commerce.cart.frozen',
        title: 'Frozen',
        description: 'Declared policy is immutable after registration',
        steps: CHECKOUT_STEPS,
        planes: ['browser'],
        metadata: { owner: 'code' },
      });

      // A shallow freeze would leave `planes` and `editable` writable, letting
      // a caller widen the plane or unlock a field on the object the registry
      // hands back.
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.planes)).toBe(true);
      expect(Object.isFrozen(definition.editable)).toBe(true);
      expect(Object.isFrozen(definition.metadata)).toBe(true);
      expect(Object.isFrozen(definition.steps)).toBe(true);
      expect(Object.isFrozen(definition.steps[0])).toBe(true);

      expect(() => {
        (definition.planes as PlaybookPlane[]).push('server');
      }).toThrow();
      expect(() => {
        (definition.editable as { enabled: boolean }).enabled = true;
      }).toThrow();

      expect(PlaybookRegistry.get('commerce.cart.frozen')?.planes).toEqual([
        'browser',
      ]);
    });

    it('defaults every editable flag to false', async () => {
      definePlaybook({
        key: 'commerce.cart.locked',
        title: 'Locked',
        description: 'All fields locked by default',
        steps: CHECKOUT_STEPS,
      });

      await expect(
        overrides.create({ key: 'commerce.cart.locked', title: 'Rebranded' }),
      ).rejects.toThrow('does not allow title overrides');
      await expect(
        overrides.create({
          key: 'commerce.cart.locked',
          description: 'Rewritten',
        }),
      ).rejects.toThrow('does not allow description overrides');
      await expect(
        overrides.create({ key: 'commerce.cart.locked', enabled: false }),
      ).rejects.toThrow('does not allow enablement overrides');
      await expect(
        overrides.create({
          key: 'commerce.cart.locked',
          planes: ['server'],
        }),
      ).rejects.toThrow('does not allow planes overrides');
      await expect(
        overrides.create({
          key: 'commerce.cart.locked',
          onStepFailure: 'continue',
        }),
      ).rejects.toThrow('does not allow onStepFailure overrides');
      await expect(
        overrides.create({
          key: 'commerce.cart.locked',
          metadata: { note: 'hi' },
        }),
      ).rejects.toThrow('does not allow metadata overrides');
    });

    it('allows an onStepFailure override only when the definition opts in', async () => {
      definePlaybook({
        key: 'commerce.cart.failure-policy',
        title: 'Failure policy',
        description: 'Opts in to failure-policy overrides',
        steps: CHECKOUT_STEPS,
        onStepFailure: 'abort',
        editable: { onStepFailure: true },
      });

      await overrides.create({
        key: 'commerce.cart.failure-policy',
        tenantId: 'tenant-a',
        onStepFailure: 'continue',
      });

      const plan = expectPlan(
        await resolvePlaybook('commerce.cart.failure-policy', {
          db,
          tenantId: 'tenant-a',
        }),
      );
      expect(plan.onStepFailure).toBe('continue');

      // A different tenant still inherits the locked code default.
      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.failure-policy', {
            db,
            tenantId: 'tenant-b',
          }),
        ).onStepFailure,
      ).toBe('abort');
    });
  });

  describe('layered resolution', () => {
    it('lets each layer override any subset of fields, inheriting the rest', async () => {
      definePlaybook({
        key: 'commerce.cart.layered',
        title: 'Code title',
        description: 'Code description',
        steps: CHECKOUT_STEPS,
        onStepFailure: 'abort',
        metadata: { owner: 'code', tone: 'code' },
        editable: {
          title: true,
          description: true,
          planes: true,
          enabled: true,
          metadata: true,
        },
      });

      setConfig({
        packages: {
          playbooks: {
            playbooks: {
              'commerce.cart.layered': {
                description: 'Config description',
                metadata: { tone: 'config' },
              },
            },
          },
        },
      });

      await overrides.create({
        key: 'commerce.cart.layered',
        tenantId: null,
        title: 'App title',
      });

      await overrides.create({
        key: 'commerce.cart.layered',
        tenantId: 'tenant-a',
        metadata: { tone: 'tenant' },
      });

      const plan = expectPlan(
        await resolvePlaybook('commerce.cart.layered', {
          db,
          tenantId: 'tenant-a',
          override: { title: 'Runtime title' },
        }),
      );

      expect(plan.title).toBe('Runtime title');
      expect(plan.description).toBe('Config description');
      expect(plan.metadata).toEqual({ owner: 'code', tone: 'tenant' });
      expect(plan.onStepFailure).toBe('abort');
    });

    it('keeps app-level overrides visible through CRUD inside a tenant context', async () => {
      definePlaybook({
        key: 'commerce.cart.scope',
        title: 'Scoped',
        description: 'Scoped playbook',
        steps: CHECKOUT_STEPS,
        editable: { title: true },
      });

      const appOverride = await overrides.create({
        key: 'commerce.cart.scope',
        tenantId: null,
        title: 'App title',
      });
      await overrides.create({
        key: 'commerce.cart.scope',
        tenantId: 'tenant-a',
        title: 'Tenant title',
      });

      await withTenant({ tenantId: 'tenant-a' }, async () => {
        const visible = await overrides.list({
          where: { key: 'commerce.cart.scope' },
          orderBy: 'createdAt ASC',
        });
        expect(visible.map((item) => item.tenantId)).toEqual([
          null,
          'tenant-a',
        ]);

        const loaded = await overrides.get({ id: appOverride.id as string });
        expect(loaded?.tenantId).toBeNull();
      });
    });
  });

  describe('steps are never editable', () => {
    it('rejects a steps key on a stored override, a config layer, and a runtime override', async () => {
      definePlaybook({
        key: 'commerce.cart.steps-locked',
        title: 'Steps locked',
        description: 'Steps locked',
        steps: CHECKOUT_STEPS,
        editable: {
          title: true,
          description: true,
          planes: true,
          enabled: true,
          metadata: true,
        },
      });

      // Direct model write, including through the untyped option bag.
      await expect(
        overrides.create({
          key: 'commerce.cart.steps-locked',
          tenantId: 'tenant-a',
          steps: [
            {
              kind: 'operation',
              model: '@happyvertical/smrt-commerce:Order',
              action: 'refund',
            },
          ],
        } as never),
      ).rejects.toThrow('step lists are never editable');

      // Runtime override layer.
      await expect(
        resolvePlaybook('commerce.cart.steps-locked', {
          db,
          override: { steps: [] } as never,
        }),
      ).rejects.toThrow('cannot set steps');

      // Config layer. Clear the TTL cache first so the config layer is
      // actually re-read rather than served from the earlier resolution.
      setConfig({
        packages: {
          playbooks: {
            playbooks: {
              'commerce.cart.steps-locked': { steps: [] } as never,
            },
          },
        },
      });
      clearPlaybookCache();
      await expect(
        resolvePlaybook('commerce.cart.steps-locked', { db }),
      ).rejects.toThrow('cannot set steps');
    });

    it('never has a steps column to persist into', async () => {
      definePlaybook({
        key: 'commerce.cart.no-column',
        title: 'No steps column',
        description: 'No steps column',
        steps: CHECKOUT_STEPS,
      });

      // The generated schema has no steps column, so no write of any kind —
      // model, REST, CLI, or raw SQL — has anywhere to put a step list.
      const schema = await (db as any).getTableSchema(
        '_smrt_playbook_overrides',
      );
      const columnNames = Object.keys(schema?.columns ?? {});

      expect(columnNames).toContain('key');
      expect(columnNames).toContain('context');
      expect(columnNames).not.toContain('steps');
    });
  });

  describe('enablement is one-directional', () => {
    it('lets a tenant disable but never re-enable', async () => {
      definePlaybook({
        key: 'commerce.cart.enablement',
        title: 'Enablement',
        description: 'Enablement rules',
        steps: CHECKOUT_STEPS,
        editable: { enabled: true },
      });

      await overrides.create({
        key: 'commerce.cart.enablement',
        tenantId: 'tenant-a',
        enabled: false,
      });

      const disabled = await resolvePlaybook('commerce.cart.enablement', {
        db,
        tenantId: 'tenant-a',
      });
      expect(disabled.ok).toBe(false);
      expect(disabled.ok === false && disabled.reason).toBe('disabled');

      // A different tenant still inherits the enabled code default.
      expect(
        (
          await resolvePlaybook('commerce.cart.enablement', {
            db,
            tenantId: 'tenant-b',
          })
        ).ok,
      ).toBe(true);

      // App layer disables; a tenant row cannot widen it back open.
      await overrides.create({
        key: 'commerce.cart.enablement',
        tenantId: null,
        enabled: false,
      });

      await expect(
        overrides.create({
          key: 'commerce.cart.enablement',
          tenantId: 'tenant-c',
          enabled: true,
        }),
      ).rejects.toThrow('cannot be re-enabled');

      // Nor through a runtime override.
      const runtime = await resolvePlaybook('commerce.cart.enablement', {
        db,
        tenantId: 'tenant-c',
        override: { enabled: true },
      });
      expect(runtime.ok).toBe(false);
      expect(runtime.ok === false && runtime.reason).toBe('disabled');
    });

    it('refuses an override that claims an undeclared plane', async () => {
      definePlaybook({
        key: 'commerce.cart.browser-only',
        title: 'Browser only',
        description: 'Browser only playbook',
        steps: CHECKOUT_STEPS,
        planes: ['browser'],
        editable: { planes: true },
      });

      await expect(
        overrides.create({
          key: 'commerce.cart.browser-only',
          tenantId: 'tenant-a',
          planes: ['server'],
        }),
      ).rejects.toThrow('cannot add plane');
    });
  });

  describe('plane validity', () => {
    it('fails closed with a specific reason on an undeclared plane', async () => {
      definePlaybook({
        key: 'commerce.cart.server-only',
        title: 'Server only',
        description: 'Server only playbook',
        steps: CHECKOUT_STEPS,
        planes: ['server'],
      });

      const rejected = await resolvePlaybook('commerce.cart.server-only', {
        db,
        plane: 'browser',
      });

      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false && rejected.reason).toBe(
        'plane-not-declared',
      );
      expect(rejected.ok === false && rejected.message).toContain('"browser"');

      expect(
        (
          await resolvePlaybook('commerce.cart.server-only', {
            db,
            plane: 'server',
          })
        ).ok,
      ).toBe(true);
    });

    it('defaults an intent-bearing playbook to browser-only until server is declared', () => {
      const browserOnly = definePlaybook({
        key: 'commerce.cart.review',
        title: 'Review the cart',
        description: 'Opens the cart review surface.',
        steps: [{ kind: 'intent', id: 'commerce.cart.review' }],
      });
      expect(browserOnly.planes).toEqual(['browser']);

      const bridged = definePlaybook({
        key: 'commerce.cart.review-bridged',
        title: 'Review the cart from a server agent',
        description: 'Drives the mounted surface over the #2446 bridge.',
        steps: [{ kind: 'intent', id: 'commerce.cart.review' }],
        planes: ['browser', 'server'],
      });
      expect(bridged.planes).toEqual(['browser', 'server']);
    });

    it('fails an intent step closed until an intent registry is supplied', async () => {
      definePlaybook({
        key: 'commerce.cart.intent',
        title: 'Intent playbook',
        description: 'Contains a view intent step',
        steps: [
          {
            kind: 'operation',
            model: '@happyvertical/smrt-commerce:Order',
            action: 'submit',
          },
          { kind: 'intent', id: 'commerce.cart.review' },
        ],
      });

      const noRegistry = await resolvePlaybook('commerce.cart.intent', {
        db,
        plane: 'browser',
      });
      expect(noRegistry.ok).toBe(false);
      expect(noRegistry.ok === false && noRegistry.reason).toBe(
        'intent-registry-unavailable',
      );
      expect(noRegistry.ok === false && noRegistry.stepIndex).toBe(1);

      const unknownIntent = await resolvePlaybook('commerce.cart.intent', {
        db,
        plane: 'browser',
        intents: () => null,
      });
      expect(unknownIntent.ok === false && unknownIntent.reason).toBe(
        'unknown-intent',
      );

      const plan = expectPlan(
        await resolvePlaybook('commerce.cart.intent', {
          db,
          plane: 'browser',
          intents: (id) => ({
            id,
            classification: {
              effect: 'read',
              idempotent: true,
              openWorld: false,
            },
          }),
        }),
      );
      expect(plan.steps[1]?.classification.effect).toBe('read');
      expect(plan.steps[1]?.classificationDeclared).toBe(true);
    });

    it('treats an intent record that declares no planes as browser-only', async () => {
      definePlaybook({
        key: 'commerce.cart.bridged',
        title: 'Bridged intent playbook',
        description: 'Explicitly declares server validity via the #2446 bridge',
        steps: [{ kind: 'intent', id: 'commerce.cart.review' }],
        planes: ['browser', 'server'],
      });

      // Silence from the intent registry must not widen the plane: the intent
      // has to declare server validity too.
      const undeclared = await resolvePlaybook('commerce.cart.bridged', {
        db,
        plane: 'server',
        intents: (id) => ({ id }),
      });
      expect(undeclared.ok).toBe(false);
      expect(undeclared.ok === false && undeclared.reason).toBe(
        'intent-plane-not-declared',
      );

      // The same intent still resolves on the browser plane.
      expect(
        (
          await resolvePlaybook('commerce.cart.bridged', {
            db,
            plane: 'browser',
            intents: (id) => ({ id }),
          })
        ).ok,
      ).toBe(true);

      // An intent that explicitly declares server validity resolves there.
      expect(
        (
          await resolvePlaybook('commerce.cart.bridged', {
            db,
            plane: 'server',
            intents: (id) => ({ id, planes: ['browser', 'server'] as const }),
          })
        ).ok,
      ).toBe(true);
    });
  });

  describe('classification is inherited, never self-declared', () => {
    it('falls back to the destructive default for an unclassified operation', async () => {
      definePlaybook({
        key: 'commerce.cart.classify',
        title: 'Classify',
        description: 'Classification inheritance',
        steps: CHECKOUT_STEPS,
      });

      const undeclared = expectPlan(
        await resolvePlaybook('commerce.cart.classify', { db }),
      );
      expect(undeclared.steps[0]?.classification).toEqual({
        effect: 'destructive',
        idempotent: false,
        openWorld: true,
      });
      expect(undeclared.steps[0]?.classificationDeclared).toBe(false);

      const classifier = (step: PlaybookOperationStep) =>
        step.action === 'submit'
          ? { effect: 'write' as const, idempotent: false, openWorld: false }
          : // Partial declaration: unset fields still resolve fail-closed.
            { effect: 'write' as const };

      const declared = expectPlan(
        await resolvePlaybook('commerce.cart.classify', { db, classifier }),
      );
      expect(declared.steps[0]?.classification).toEqual({
        effect: 'write',
        idempotent: false,
        openWorld: false,
      });
      expect(declared.steps[1]?.classification).toEqual({
        effect: 'write',
        idempotent: false,
        openWorld: true,
      });
      expect(declared.steps[1]?.classificationDeclared).toBe(false);
    });
  });

  describe('caching', () => {
    it('invalidates on save and delete and never serves a stale entry', async () => {
      definePlaybook({
        key: 'commerce.cart.cache',
        title: 'Code title',
        description: 'Cache behaviour',
        steps: CHECKOUT_STEPS,
        editable: { title: true },
      });

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.cache', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('Code title');

      // An app-level write invalidates every tenant's cached entry.
      const appOverride = await overrides.create({
        key: 'commerce.cart.cache',
        tenantId: null,
        title: 'App title',
      });
      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.cache', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('App title');

      await appOverride.delete();
      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.cache', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('Code title');
    });

    it('expires stale entries after the ttl when storage changes without invalidation', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      definePlaybook({
        key: 'commerce.cart.ttl',
        title: 'Code title',
        description: 'TTL behaviour',
        steps: CHECKOUT_STEPS,
        editable: { title: true },
      });

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.ttl', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('Code title');

      await (db as any).upsert('_smrt_playbook_overrides', ['key', 'context'], {
        id: crypto.randomUUID(),
        slug: 'commerce-cart-ttl-app',
        context: '__app__',
        created_at: new Date(),
        updated_at: new Date(),
        key: 'commerce.cart.ttl',
        tenant_id: null,
        title: 'DB title',
        description: null,
        planes: null,
        on_step_failure: null,
        enabled: null,
        metadata: null,
      });

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.ttl', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('Code title');

      vi.advanceTimersByTime(getPlaybookCacheTtlMs() + 1);

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.ttl', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('DB title');
    });
  });

  describe('nullable-tenant upserts', () => {
    it('keeps app-level rows unique via the context column rather than a nullable tenantId', async () => {
      definePlaybook({
        key: 'commerce.cart.upsert',
        title: 'Upsert',
        description: 'Nullable tenant upsert',
        steps: CHECKOUT_STEPS,
        editable: { title: true },
      });

      const appOverride = await overrides.create({
        key: 'commerce.cart.upsert',
        tenantId: null,
        title: 'App title',
      });
      const tenantOverride = await overrides.create({
        key: 'commerce.cart.upsert',
        tenantId: 'tenant-a',
        title: 'Tenant title',
      });

      // The conflict key is (key, context); context carries the tenant scope so
      // no dialect has to reason about NULL equality in a unique index. This is
      // what makes the same upsert correct on PostgreSQL, SQLite, and DuckDB.
      expect(appOverride.context).toBe('__app__');
      expect(tenantOverride.context).toBe('tenant-a');

      // Re-saving the app row updates in place instead of inserting a second
      // NULL-tenant row.
      appOverride.title = 'App title v2';
      await appOverride.save();

      const appRows = await overrides.list({
        where: { key: 'commerce.cart.upsert', tenantId: null },
      });
      expect(appRows).toHaveLength(1);
      expect(appRows[0]?.title).toBe('App title v2');
      expect(appRows[0]?.id).toBe(appOverride.id);
    });

    it('moves an override between scopes without orphaning the previous cache identity', async () => {
      definePlaybook({
        key: 'commerce.cart.move',
        title: 'Code title',
        description: 'Scope move',
        steps: CHECKOUT_STEPS,
        editable: { title: true },
      });

      const override = await overrides.create({
        key: 'commerce.cart.move',
        tenantId: null,
        title: 'App title',
      });

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.move', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('App title');

      override.tenantId = 'tenant-a';
      override.title = 'Tenant title';
      await override.save();

      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.move', {
            db,
            tenantId: 'tenant-a',
          }),
        ).title,
      ).toBe('Tenant title');
      expect(
        expectPlan(
          await resolvePlaybook('commerce.cart.move', {
            db,
            tenantId: 'tenant-b',
          }),
        ).title,
      ).toBe('Code title');
      expect(override.context).toBe('tenant-a');
    });
  });

  describe('resolution returns a plan and nothing executes a step', () => {
    it('exposes no executor and leaves every step untouched', async () => {
      definePlaybook({
        key: 'commerce.cart.plan-only',
        title: 'Plan only',
        description: 'Resolution never executes',
        steps: CHECKOUT_STEPS,
      });

      const plan = expectPlan(
        await resolvePlaybook('commerce.cart.plan-only', { db }),
      );

      expect(plan.steps).toHaveLength(CHECKOUT_STEPS.length);
      for (const [index, planStep] of plan.steps.entries()) {
        expect(planStep.index).toBe(index);
        expect(planStep.step).toEqual(CHECKOUT_STEPS[index]);
      }

      const packageExports = await import('./index.js');
      const exportNames = Object.keys(packageExports);
      expect(
        exportNames.filter((name) =>
          /^(execute|run|invoke|perform)/i.test(name),
        ),
      ).toEqual([]);
    });

    it('rejects an unknown playbook key with a specific reason instead of throwing', async () => {
      const rejected = await resolvePlaybook('commerce.cart.missing', { db });
      expect(rejected.ok).toBe(false);
      expect(rejected.ok === false && rejected.reason).toBe('unknown-playbook');
    });
  });
});
