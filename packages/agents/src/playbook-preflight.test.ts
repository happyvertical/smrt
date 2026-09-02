/**
 * Server-plane playbook preflight (issue #2590) — real in-memory SQLite, real
 * permission catalog, real `executeAsPrincipal`.
 *
 * The load-bearing claim under test is that preflight is **advisory**: it
 * predicts, and execution enforces independently. So the important tests here
 * are the ones where a prediction and the subsequent enforcement disagree.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearPlaybookCache,
  clearPlaybookPreflightCache,
  definePlaybook,
  PlaybookRegistry,
} from '@happyvertical/smrt-playbooks';
import {
  MembershipCollection,
  OperationPermissionError,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  registerPermissionDefinitions,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeAsPrincipal,
  type PrincipalRun,
  PrincipalToolNotAllowedError,
} from './execute-as-principal.js';
import {
  createPlaybookPreflightTool,
  filterPlaybooksByPreflight,
  PLAYBOOK_PREFLIGHT_TOOL_SLUG,
  playbookStepToolSlug,
} from './playbook-preflight.js';

const WIDGET_MODEL = '@happyvertical/smrt-widgets:Widget';

const WIDGET_STEPS = [
  { kind: 'operation' as const, model: WIDGET_MODEL, action: 'read' },
  { kind: 'operation' as const, model: WIDGET_MODEL, action: 'create' },
];

/**
 * The host's mapping from a step's qualified model to the collection slug the
 * permission catalog and the persona allow-list key on. Supplied explicitly
 * here because this test's `widgets` catalog entries are registered without a
 * decorated class behind them; the defaults are covered on their own below.
 */
const WIDGET_SEAMS = {
  collection: () => 'widgets',
  toolSlug: (step: { action: string }) => `widgets.${step.action}`,
};

describe('playbook preflight tool (#2590)', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let unregister: (() => void) | undefined;
  let userId: string;
  let tenantId: string;
  let roleId: string;
  let permissions: PermissionCollection;
  let rolePermissions: RolePermissionCollection;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-playbook-preflight-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };

    unregister = registerPermissionDefinitions([
      { slug: 'widgets.read' },
      { slug: 'widgets.create' },
    ]);

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'preflight@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Preflight Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Widget Reader' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantId = tenant.id as string;
    roleId = role.id as string;

    await grant('widgets.read');
    await grant('widgets.create');

    PlaybookRegistry.clear();
    clearPlaybookCache();
    clearPlaybookPreflightCache();
    definePlaybook({
      key: 'widgets.restock',
      title: 'Restock widgets',
      description: 'Reads the shelf, then creates the replacements.',
      steps: WIDGET_STEPS,
    });
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
    PlaybookRegistry.clear();
    clearPlaybookCache();
    clearPlaybookPreflightCache();
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  async function grant(slug: string): Promise<void> {
    const permission = await permissions.create({ slug, name: slug });
    await permission.save();
    await rolePermissions.addPermission(roleId, permission.id as string);
  }

  async function revoke(slug: string): Promise<void> {
    const found = await permissions.list({ where: { slug } });
    for (const permission of found) {
      await rolePermissions.removePermission(roleId, permission.id as string);
    }
  }

  function asPrincipal<T>(
    allowedTools: string[],
    body: (run: PrincipalRun) => Promise<T>,
  ): Promise<T> {
    return executeAsPrincipal(
      {
        db,
        principal: { runAsUserId: userId, tenantId, allowedTools },
        audit: () => {},
      },
      body,
    );
  }

  const ALL_TOOLS = [
    PLAYBOOK_PREFLIGHT_TOOL_SLUG,
    'widgets.read',
    'widgets.create',
  ];

  it('derives the gating tool slug from the step it describes', () => {
    // An unregistered model falls back to its class name; a registered one uses
    // the collection slug the REST surface and the permission catalog share.
    expect(
      playbookStepToolSlug({
        kind: 'operation',
        model: WIDGET_MODEL,
        action: 'create',
      }),
    ).toBe('widget.create');
  });

  it('reports every step as allowed when both gates pass', async () => {
    const tool = createPlaybookPreflightTool({ db, tenantId, ...WIDGET_SEAMS });
    const report = await asPrincipal(ALL_TOOLS, (run) =>
      tool.execute({ run, args: { key: 'widgets.restock' }, db }),
    );

    expect(report.available).toBe(true);
    expect(report.advisory).toBe(true);
    expect(report.verdict).toBe('allow');
    expect(report.steps).toHaveLength(2);
  });

  it('denies a step outside the persona tool allow-list without executing it', async () => {
    const tool = createPlaybookPreflightTool({ db, tenantId, ...WIDGET_SEAMS });
    const report = await asPrincipal(
      [PLAYBOOK_PREFLIGHT_TOOL_SLUG, 'widgets.read'],
      (run) => tool.execute({ run, args: { key: 'widgets.restock' }, db }),
    );

    if (!report.available) throw new Error('expected an available report');
    expect(report.steps[0]?.verdict).toBe('allow');
    expect(report.steps[1]).toMatchObject({
      verdict: 'deny',
      reason: 'tool-not-allowed',
    });
    expect(report.verdict).toBe('deny');
  });

  it('denies a step the catalog permission refuses', async () => {
    await revoke('widgets.create');

    const tool = createPlaybookPreflightTool({ db, tenantId, ...WIDGET_SEAMS });
    const report = await asPrincipal(ALL_TOOLS, (run) =>
      tool.execute({ run, args: { key: 'widgets.restock' }, db }),
    );

    if (!report.available) throw new Error('expected an available report');
    expect(report.steps[1]).toMatchObject({
      verdict: 'deny',
      reason: 'permission-denied',
    });
  });

  it('gates the preflight tool itself on the persona allow-list', async () => {
    const tool = createPlaybookPreflightTool({ db, tenantId, ...WIDGET_SEAMS });
    await expect(
      asPrincipal(['widgets.read'], (run) =>
        tool.execute({ run, args: { key: 'widgets.restock' }, db }),
      ),
    ).rejects.toThrow(PrincipalToolNotAllowedError);
  });

  it('answers an unknown key exactly as it answers an unauthorized one', async () => {
    definePlaybook({
      key: 'widgets.browser-only',
      title: 'Browser-only playbook',
      description: 'Not valid on the server plane.',
      steps: WIDGET_STEPS,
      planes: ['browser'],
    });

    const tool = createPlaybookPreflightTool({ db, tenantId, ...WIDGET_SEAMS });
    const [unknownKey, unauthorized] = await asPrincipal(
      ALL_TOOLS,
      async (run) => [
        await tool.execute({ run, args: { key: 'widgets.nope' }, db }),
        await tool.execute({ run, args: { key: 'widgets.browser-only' }, db }),
      ],
    );

    expect(JSON.stringify(unknownKey)).toBe(JSON.stringify(unauthorized));
  });

  describe('advisory only — execution enforces independently', () => {
    it('denies at execution a step preflight predicted as allowed, after a revocation', async () => {
      const tool = createPlaybookPreflightTool({
        db,
        tenantId,
        ...WIDGET_SEAMS,
      });

      const predicted = await asPrincipal(ALL_TOOLS, (run) =>
        tool.execute({ run, args: { key: 'widgets.restock' }, db }),
      );
      if (!predicted.available) throw new Error('expected an available report');
      expect(predicted.verdict).toBe('allow');

      // The permission is revoked between the prediction and the execution.
      await revoke('widgets.create');

      // The prediction is still cached and still says allow...
      const cached = await asPrincipal(ALL_TOOLS, (run) =>
        tool.execute({ run, args: { key: 'widgets.restock' }, db }),
      );
      if (!cached.available) throw new Error('expected an available report');
      expect(cached.verdict).toBe('allow');

      // ...and execution denies anyway. A stale allow costs a correctly-denied
      // step, never a bypass: this is the whole reason the cache is free.
      await asPrincipal(ALL_TOOLS, async (run) => {
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
      });
    });

    it('re-enforces the tool ceiling at execution even after an allowing preflight', async () => {
      const tool = createPlaybookPreflightTool({
        db,
        tenantId,
        ...WIDGET_SEAMS,
      });
      const predicted = await asPrincipal(ALL_TOOLS, (run) =>
        tool.execute({ run, args: { key: 'widgets.restock' }, db }),
      );
      expect(predicted.verdict).toBe('allow');

      // A later run with a narrower persona is bound by its own allow-list.
      // The earlier prediction grants it nothing.
      await asPrincipal([PLAYBOOK_PREFLIGHT_TOOL_SLUG], async (run) => {
        expect(() => run.assertToolAllowed('widgets.create')).toThrow(
          PrincipalToolNotAllowedError,
        );
      });
    });
  });

  describe('listing filter is not load-bearing for authorization', () => {
    it('still denies at execution a playbook the filter let through', async () => {
      const tool = createPlaybookPreflightTool({
        db,
        tenantId,
        ...WIDGET_SEAMS,
      });

      const visible = await asPrincipal(ALL_TOOLS, (run) =>
        filterPlaybooksByPreflight(run, ['widgets.restock'], {
          db,
          tenantId,
          ...WIDGET_SEAMS,
        }),
      );
      expect(visible).toEqual(['widgets.restock']);

      await revoke('widgets.create');
      clearPlaybookPreflightCache();

      await asPrincipal(ALL_TOOLS, async (run) => {
        // Presence in the listing is not permission: the step is denied.
        await expect(run.assertOperation('widgets', 'create')).rejects.toThrow(
          OperationPermissionError,
        );
        // And the filter itself now hides it, which changes nothing about the
        // enforcement above.
        const report = await tool.execute({
          run,
          args: { key: 'widgets.restock' },
          db,
        });
        if (!report.available) throw new Error('expected an available report');
        expect(report.verdict).toBe('deny');
      });
    });

    it('hides a playbook whose steps are outside the persona ceiling', async () => {
      const visible = await asPrincipal(
        [PLAYBOOK_PREFLIGHT_TOOL_SLUG, 'widgets.read'],
        (run) =>
          filterPlaybooksByPreflight(run, ['widgets.restock'], {
            db,
            tenantId,
            ...WIDGET_SEAMS,
          }),
      );
      expect(visible).toEqual([]);
    });

    it('hides an unresolvable key without saying why', async () => {
      const visible = await asPrincipal(ALL_TOOLS, (run) =>
        filterPlaybooksByPreflight(run, ['widgets.nope'], {
          db,
          tenantId,
          ...WIDGET_SEAMS,
        }),
      );
      expect(visible).toEqual([]);
    });
  });
});
