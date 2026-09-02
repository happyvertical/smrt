/**
 * Preflight contract tests (issue #2590).
 *
 * Everything here runs against the real resolver and a real in-memory SQLite
 * database — the point of preflight is that it agrees with the layers it
 * predicts, so nothing about resolution is mocked.
 */

import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPlaybookCache } from './cache.js';
import { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
import { definePlaybook, PlaybookRegistry } from './playbook-registry.js';
import {
  createBrowserStepEvaluator,
  createServerStepEvaluator,
  PLAYBOOK_PREFLIGHT_UNAVAILABLE,
  preflightPlaybook,
  worstVerdict,
} from './preflight.js';
import { clearPlaybookPreflightCache } from './preflight-cache.js';
import type {
  BrowserPreflightLayerSource,
  PlaybookPreflightAvailableReport,
  PlaybookPreflightReport,
  PreflightLayer,
  PreflightLayerReport,
} from './preflight-types.js';

const CHECKOUT_STEPS = [
  {
    kind: 'operation' as const,
    model: '@happyvertical/smrt-commerce:Order',
    action: 'submit',
  },
  {
    kind: 'operation' as const,
    model: '@happyvertical/smrt-commerce:Payment',
    action: 'capture',
  },
];

function staticLayers(
  overrides: Partial<BrowserPreflightLayerSource> = {},
): BrowserPreflightLayerSource {
  return {
    appAuthConfigured: false,
    isActionExposed: () => true,
    isRoutePublic: () => true,
    requiredFieldPermissions: () => [],
    ...overrides,
  };
}

function expectAvailable(
  report: PlaybookPreflightReport,
): PlaybookPreflightAvailableReport {
  if (!report.available) {
    throw new Error('expected an available preflight report');
  }
  return report;
}

function layerOf(
  report: PlaybookPreflightAvailableReport,
  index: number,
  layer: PreflightLayer,
): PreflightLayerReport {
  const found = report.steps[index]?.layers.find(
    (candidate) => candidate.layer === layer,
  );
  if (!found) {
    throw new Error(`step ${index} reported no "${layer}" layer`);
  }
  return found;
}

describe('playbook preflight (#2590)', () => {
  let db: DatabaseInterface;
  let overrides: PlaybookOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    PlaybookRegistry.clear();
    clearPlaybookCache();
    clearPlaybookPreflightCache();
    clearCache();
    setConfig({ packages: { playbooks: { playbooks: {} } } });

    db = await getTestDatabase({ classes: ['PlaybookOverride'] });
    overrides = await PlaybookOverrideCollection.create({ db });

    definePlaybook({
      key: 'commerce.cart.checkout',
      title: 'Check out this cart',
      description: 'Submits the order and captures payment.',
      steps: CHECKOUT_STEPS,
    });
  });

  afterEach(async () => {
    clearPlaybookCache();
    clearPlaybookPreflightCache();
    PlaybookRegistry.clear();
    clearCache();
    resetTenancy();
    vi.useRealTimers();
    const closable = db as unknown as { close?: () => Promise<void> };
    if (typeof closable.close === 'function') {
      await closable.close();
    }
  });

  describe('verdict algebra', () => {
    it('combines fail-closed: deny beats unknown beats allow', () => {
      expect(worstVerdict('allow', 'unknown')).toBe('unknown');
      expect(worstVerdict('unknown', 'deny')).toBe('deny');
      expect(worstVerdict('deny', 'allow')).toBe('deny');
      expect(worstVerdict('allow', 'allow')).toBe('allow');
    });
  });

  describe('server plane', () => {
    it('reports a per-step verdict from isToolAllowed and the operation predicate', async () => {
      const report = expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.checkout',
          plane: 'server',
          principal: 'user-1|tenant-1',
          resolve: { db, tenantId: null },
          evaluate: createServerStepEvaluator({
            isToolAllowed: (step) => step.action === 'submit',
            checkOperationPermission: () => 'allow',
          }),
        }),
      );

      expect(report.steps).toHaveLength(2);
      expect(report.steps[0]?.verdict).toBe('allow');
      expect(report.steps[1]?.verdict).toBe('deny');
      expect(report.steps[1]?.reason).toBe('tool-not-allowed');
      expect(report.verdict).toBe('deny');
      expect(report.summary).toEqual({ allow: 1, deny: 1, unknown: 0 });
    });

    it('denies a step the operation-permission predicate refuses', async () => {
      const report = expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.checkout',
          plane: 'server',
          principal: 'user-1|tenant-1',
          resolve: { db, tenantId: null },
          evaluate: createServerStepEvaluator({
            isToolAllowed: () => true,
            checkOperationPermission: (step) =>
              step.action === 'capture' ? 'deny' : 'allow',
          }),
        }),
      );

      expect(layerOf(report, 1, 'operation-permission')).toMatchObject({
        verdict: 'deny',
        reason: 'permission-denied',
      });
      expect(report.steps[1]?.reason).toBe('permission-denied');
    });

    it('evaluates every step rather than short-circuiting on the first denial', async () => {
      const checked: string[] = [];
      const report = expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.checkout',
          plane: 'server',
          principal: 'user-1|tenant-1',
          resolve: { db, tenantId: null },
          evaluate: createServerStepEvaluator({
            isToolAllowed: () => false,
            checkOperationPermission: (step) => {
              checked.push(step.action);
              return 'allow';
            },
          }),
        }),
      );

      // Preflight exists to say WHICH step of five would die, so it must not
      // stop at the first one.
      expect(checked).toEqual(['submit', 'capture']);
      expect(report.steps.map((step) => step.verdict)).toEqual([
        'deny',
        'deny',
      ]);
    });

    it('denies a browser-only intent step with reason "plane"', async () => {
      // Resolution already refuses a browser-only intent on the server plane
      // ('intent-plane-not-declared'), so this layer is the second of two gates
      // rather than the only one — the same defense-in-depth shape as
      // `assertToolAllowed()` gating both a tool's offer and its execution. It
      // is therefore evaluated directly: an unreachable gate is still a gate,
      // and a later intent-registry change must not be able to widen it
      // silently.
      const evaluate = createServerStepEvaluator({
        isToolAllowed: () => true,
        checkOperationPermission: () => 'allow',
        intentPlanes: () => ['browser'],
      });

      const evaluation = await evaluate({
        index: 0,
        step: { kind: 'intent', id: 'cart.review' },
        classification: {
          effect: 'destructive',
          idempotent: false,
          openWorld: true,
        },
        classificationDeclared: false,
      });

      expect(evaluation.layers).toEqual([
        { layer: 'plane', verdict: 'deny', reason: 'plane' },
      ]);
    });

    it('denies an intent step whose planes the registry does not answer for', async () => {
      const evaluate = createServerStepEvaluator({
        isToolAllowed: () => true,
        checkOperationPermission: () => 'allow',
      });

      const evaluation = await evaluate({
        index: 0,
        step: { kind: 'intent', id: 'cart.review' },
        classification: {
          effect: 'destructive',
          idempotent: false,
          openWorld: true,
        },
        classificationDeclared: false,
      });

      // Silence never widens a plane.
      expect(evaluation.layers[0]).toMatchObject({
        verdict: 'deny',
        reason: 'plane',
      });
    });

    it('reports a server-declared intent as unknown — the #2446 bridge is not statically knowable', async () => {
      definePlaybook({
        key: 'commerce.cart.bridged',
        title: 'Bridged review',
        description: 'Drives a mounted surface over the command/ack bridge.',
        steps: [{ kind: 'intent', id: 'cart.review' }],
        planes: ['browser', 'server'],
      });

      const report = expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.bridged',
          plane: 'server',
          principal: 'user-1|tenant-1',
          resolve: {
            db,
            tenantId: null,
            intents: () => ({
              id: 'cart.review',
              planes: ['browser', 'server'],
            }),
          },
          evaluate: createServerStepEvaluator({
            isToolAllowed: () => true,
            checkOperationPermission: () => 'allow',
            intentPlanes: () => ['browser', 'server'],
          }),
        }),
      );

      expect(report.steps[0]).toMatchObject({
        verdict: 'unknown',
        reason: 'intent-bridge-not-evaluated',
      });
    });
  });

  describe('browser plane — static layers only', () => {
    beforeEach(() => {
      definePlaybook({
        key: 'commerce.cart.browser',
        title: 'Check out this cart',
        description: 'Submits the order and captures payment.',
        steps: CHECKOUT_STEPS,
        planes: ['browser'],
      });
    });

    async function browserReport(
      layers: Partial<BrowserPreflightLayerSource>,
      permissions?: Iterable<string> | null,
    ): Promise<PlaybookPreflightAvailableReport> {
      clearPlaybookPreflightCache();
      return expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.browser',
          plane: 'browser',
          principal: 'browser-caller',
          resolve: { db, tenantId: null },
          evaluate: createBrowserStepEvaluator({
            layers: staticLayers(layers),
            permissions: permissions ?? null,
          }),
        }),
      );
    }

    it('reports all four layers per operation step', async () => {
      const report = await browserReport({});
      expect(report.steps[0]?.layers.map((entry) => entry.layer)).toEqual([
        'action-exposure',
        'public-access',
        'field-permissions',
        'app-auth',
      ]);
    });

    it('denies an action the decorator does not expose', async () => {
      const report = await browserReport({
        isActionExposed: (_model, action) => action !== 'capture',
      });

      expect(report.steps[1]).toMatchObject({
        verdict: 'deny',
        reason: 'action-not-exposed',
      });
      expect(report.verdict).toBe('deny');
    });

    it('denies a non-public route when no app auth middleware is wired (fail-closed 401)', async () => {
      const report = await browserReport({
        isRoutePublic: () => false,
        appAuthConfigured: false,
      });

      expect(layerOf(report, 0, 'public-access')).toMatchObject({
        verdict: 'deny',
        reason: 'not-public',
      });
    });

    it('reports the app-auth layer as unknown whenever a middleware is wired', async () => {
      const report = await browserReport({
        isRoutePublic: () => false,
        appAuthConfigured: true,
      });

      expect(layerOf(report, 0, 'public-access')).toMatchObject({
        verdict: 'unknown',
        reason: 'auth-required',
      });
      expect(layerOf(report, 0, 'app-auth')).toMatchObject({
        verdict: 'unknown',
        reason: 'app-auth-not-evaluated',
      });
      // Unknown never rounds down to allow.
      expect(report.verdict).toBe('unknown');
    });

    it('reports missing field permissions as redaction, not denial', async () => {
      const report = await browserReport(
        { requiredFieldPermissions: () => ['orders.total.read'] },
        ['orders.other.read'],
      );

      expect(layerOf(report, 0, 'field-permissions')).toMatchObject({
        verdict: 'allow',
        reason: 'fields-redacted',
        missingPermissions: ['orders.total.read'],
      });
      expect(report.steps[0]?.verdict).toBe('allow');
    });

    it('reports the field layer as unknown when the caller set is unpublished', async () => {
      const report = await browserReport(
        { requiredFieldPermissions: () => ['orders.total.read'] },
        null,
      );

      expect(layerOf(report, 0, 'field-permissions')).toMatchObject({
        verdict: 'unknown',
        reason: 'field-permissions-unknown',
      });
    });

    it('reports an intent step as unknown — it never crosses the REST boundary', async () => {
      definePlaybook({
        key: 'commerce.cart.intent',
        title: 'Review the cart',
        description: 'Opens the cart review surface.',
        steps: [{ kind: 'intent', id: 'cart.review' }],
        planes: ['browser'],
      });

      const report = expectAvailable(
        await preflightPlaybook({
          key: 'commerce.cart.intent',
          plane: 'browser',
          principal: 'browser-caller',
          resolve: {
            db,
            tenantId: null,
            intents: () => ({ id: 'cart.review', planes: ['browser'] }),
          },
          evaluate: createBrowserStepEvaluator({ layers: staticLayers() }),
        }),
      );

      expect(report.steps[0]).toMatchObject({
        kind: 'intent',
        verdict: 'unknown',
        reason: 'intent-not-mounted',
      });
    });
  });

  describe('not an oracle', () => {
    async function report(key: string): Promise<PlaybookPreflightReport> {
      clearPlaybookPreflightCache();
      return preflightPlaybook({
        key,
        plane: 'server',
        principal: 'user-1|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: createServerStepEvaluator({
          isToolAllowed: () => true,
          checkOperationPermission: () => 'allow',
        }),
      });
    }

    it('answers an unknown key and an unauthorized key byte-identically', async () => {
      definePlaybook({
        key: 'commerce.cart.disabled',
        title: 'Disabled playbook',
        description: 'Registered, but disabled for this scope.',
        steps: CHECKOUT_STEPS,
        editable: { enabled: true },
      });
      const override = await overrides.create({
        key: 'commerce.cart.disabled',
        tenantId: null,
        enabled: false,
      });
      await override.save();

      const unknownKey = await report('commerce.cart.does-not-exist');
      const unauthorized = await report('commerce.cart.disabled');

      expect(unknownKey.available).toBe(false);
      expect(unauthorized.available).toBe(false);
      // Byte-identical: no key echo, no reason code, no message, nothing that
      // separates "there is no such playbook" from "not for you".
      expect(JSON.stringify(unknownKey)).toBe(JSON.stringify(unauthorized));
      expect(unknownKey).toBe(PLAYBOOK_PREFLIGHT_UNAVAILABLE);
      expect(unauthorized).toBe(PLAYBOOK_PREFLIGHT_UNAVAILABLE);
    });

    it('answers a plane the playbook does not declare with the same uniform response', async () => {
      definePlaybook({
        key: 'commerce.cart.browser-only',
        title: 'Browser-only playbook',
        description: 'Declares the browser plane only.',
        steps: CHECKOUT_STEPS,
        planes: ['browser'],
      });

      expect(await report('commerce.cart.browser-only')).toBe(
        PLAYBOOK_PREFLIGHT_UNAVAILABLE,
      );
    });

    it('pays the same override-layer read on the unknown-key path (timing class)', async () => {
      const querySpy = vi.spyOn(
        db as unknown as { query: (...args: unknown[]) => unknown },
        'query',
      );

      await report('commerce.cart.does-not-exist');
      const unknownKeyQueries = querySpy.mock.calls.length;
      querySpy.mockClear();

      await report('commerce.cart.checkout');
      const resolvableQueries = querySpy.mock.calls.length;
      querySpy.mockRestore();

      // Both paths do a real override-layer round-trip: an unknown key is not
      // distinguishable by being answered without touching the database.
      expect(unknownKeyQueries).toBeGreaterThan(0);
      expect(resolvableQueries).toBeGreaterThan(0);
    });
  });

  describe('caching', () => {
    it('serves a repeat preflight for the same (principal, key, plane) from cache', async () => {
      let evaluations = 0;
      const request = {
        key: 'commerce.cart.checkout',
        plane: 'server' as const,
        principal: 'user-1|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: createServerStepEvaluator({
          isToolAllowed: () => true,
          checkOperationPermission: () => {
            evaluations += 1;
            return 'allow' as const;
          },
        }),
      };

      await preflightPlaybook(request);
      expect(evaluations).toBe(2);
      await preflightPlaybook(request);
      expect(evaluations).toBe(2);
    });

    it('partitions the cache by principal, so one caller never reads another verdict', async () => {
      const evaluate = (allowed: boolean) =>
        createServerStepEvaluator({
          isToolAllowed: () => allowed,
          checkOperationPermission: () => 'allow' as const,
        });

      const first = await preflightPlaybook({
        key: 'commerce.cart.checkout',
        plane: 'server',
        principal: 'user-1|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: evaluate(true),
      });
      const second = await preflightPlaybook({
        key: 'commerce.cart.checkout',
        plane: 'server',
        principal: 'user-2|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: evaluate(false),
      });

      expect(first.verdict).toBe('allow');
      expect(second.verdict).toBe('deny');
    });

    it('drops a cached result once an override write bumps the generation', async () => {
      definePlaybook({
        key: 'commerce.cart.toggling',
        title: 'Toggling playbook',
        description: 'Enabled until an override disables it.',
        steps: CHECKOUT_STEPS,
        editable: { enabled: true },
      });

      const request = {
        key: 'commerce.cart.toggling',
        plane: 'server' as const,
        principal: 'user-1|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: createServerStepEvaluator({
          isToolAllowed: () => true,
          checkOperationPermission: () => 'allow' as const,
        }),
      };

      expect((await preflightPlaybook(request)).available).toBe(true);

      const override = await overrides.create({
        key: 'commerce.cart.toggling',
        tenantId: null,
        enabled: false,
      });
      await override.save();

      // No preflight-specific invalidation ceremony: the playbook cache's own
      // generation counter is the whole mechanism.
      expect(await preflightPlaybook(request)).toBe(
        PLAYBOOK_PREFLIGHT_UNAVAILABLE,
      );
    });

    it('is advisory: a cached allow does not survive as authority', async () => {
      // The cache holds a prediction. The report says so on its face, and the
      // execution-side proof that it is not authority lives in
      // @happyvertical/smrt-agents' revocation test.
      const report = await preflightPlaybook({
        key: 'commerce.cart.checkout',
        plane: 'server',
        principal: 'user-1|tenant-1',
        resolve: { db, tenantId: null },
        evaluate: createServerStepEvaluator({
          isToolAllowed: () => true,
          checkOperationPermission: () => 'allow',
        }),
      });

      expect(report.advisory).toBe(true);
    });
  });
});
