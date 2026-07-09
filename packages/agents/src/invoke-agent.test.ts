/**
 * invoke-agent — agent orchestration via principal delegation (#1892).
 *
 * Real in-memory SQLite with real RBAC (users / roles / permissions); no AI
 * boundary at this layer. Proves the delegation guarantees:
 *   - a worker runs under the ORIGINATING user's live permissions, not its own;
 *   - a worker cannot widen the principal when invoking a further worker;
 *   - delegation depth is bounded;
 *   - actions audit as on-behalf-of the originating user, preserved along the chain;
 *   - a worker's completion is emitted as a correlated dispatch and surfaced back;
 *   - the async DispatchBus transport delivers to a worker that runs as the principal.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchBus } from '@happyvertical/smrt-core';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  registerPermissionDefinitions,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DelegationDepthExceededError,
  type DelegationEnvelope,
  deriveDelegationEnvelope,
  MAX_DELEGATION_DEPTH,
  rootDelegationEnvelope,
} from './delegation.js';
import {
  executeAsPrincipal,
  type PrincipalAuditEntry,
} from './execute-as-principal.js';
import {
  createDispatchInvokeTransport,
  createInvokeAgentTool,
  executeDelegatedInvocation,
  type InvokeAgentTransport,
  processAgentInvocations,
  surfaceAgentCompletions,
  type WorkerRunner,
} from './invoke-agent.js';

const ORIGINATOR = 'originator-9';

/** A worker that probes the originating user's authority under its principal. */
const probeWorker: WorkerRunner = async ({ run }) => {
  const readOk = (await run.assertOperation('widgets', 'read')).allowed;
  let createDenied = false;
  try {
    await run.assertOperation('widgets', 'create');
  } catch {
    createDenied = true;
  }
  return { actorUserId: run.context.userId, readOk, createDenied };
};

/** A worker that does nothing (for tests that only assert the delegation shape). */
const noopWorker: WorkerRunner = async () => ({ done: true });

describe('invoke-agent orchestration', () => {
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
      `smrt-invoke-agent-${Date.now()}-${Math.random()}.db`,
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

    const user = await users.create({ email: 'principal@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Principal Org' });
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

    // The originating user may READ widgets but NOT CREATE them.
    await grant('widgets.read');
  });

  afterEach(() => {
    unregister?.();
    unregister = undefined;
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

  function rootEnvelope(): DelegationEnvelope {
    return rootDelegationEnvelope({
      runAsUserId: userId,
      tenantId,
      onBehalfOfUserId: ORIGINATOR,
      allowedTools: ['agents.invoke'],
    });
  }

  it('runs the worker under the ORIGINATING user permissions, not its own', async () => {
    const worker = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-w',
    });
    const completion = await executeDelegatedInvocation({
      db,
      envelope: worker,
      agentClass: '@happyvertical/smrt-agents:Worker',
      task: {},
      worker: probeWorker,
      audit: () => {},
    });

    expect(completion.ok).toBe(true);
    // The worker executed as the originating user's principal: it could do what
    // that user is permitted (read) and was denied what they are not (create).
    expect(completion.result).toMatchObject({
      actorUserId: userId,
      readOk: true,
      createDenied: true,
    });
  });

  it('a worker cannot WIDEN the principal when invoking a further worker', async () => {
    // The worker's own envelope (depth 1), bound to the originating principal.
    const workerEnvelope = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-w',
      allowedTools: ['agents.invoke'],
    });

    let capturedEnvelope: DelegationEnvelope | undefined;
    const recordingTransport: InvokeAgentTransport = {
      async deliver(delivery) {
        capturedEnvelope = delivery.envelope;
        return {
          status: 'enqueued',
          correlationId: delivery.envelope.correlationId,
          agentClass: delivery.agentClass,
          depth: delivery.envelope.depth,
        };
      },
    };

    // Run the tool AS the worker's principal, then attempt to widen via args.
    await executeAsPrincipal(
      {
        db,
        principal: {
          runAsUserId: userId,
          tenantId,
          allowedTools: ['agents.invoke'],
        },
        onBehalfOfUserId: ORIGINATOR,
        audit: () => {},
      },
      async (run) => {
        const tool = createInvokeAgentTool({
          db,
          parentEnvelope: workerEnvelope,
          worker: noopWorker,
          transport: recordingTransport,
        });
        // Malicious args try to run the sub-worker as a broader principal.
        await tool.execute({
          run,
          args: {
            agentClass: '@happyvertical/smrt-agents:Sub',
            task: { note: 'x' },
            runAsUserId: 'admin-user',
            tenantId: 'other-tenant',
            onBehalfOfUserId: 'someone-else',
          },
          db,
        });
      },
    );

    // The principal in the delivered envelope is the ORIGINATING one — the
    // widening arguments were ignored (principal comes from the run context).
    expect(capturedEnvelope?.runAsUserId).toBe(userId);
    expect(capturedEnvelope?.tenantId).toBe(tenantId);
    expect(capturedEnvelope?.onBehalfOfUserId).toBe(ORIGINATOR);
    // And the chain deepened by exactly one (worker depth 1 → sub depth 2).
    expect(capturedEnvelope?.depth).toBe(2);
  });

  it('bounds delegation depth at the invoke-agent tool', async () => {
    const deepEnvelope: DelegationEnvelope = {
      ...rootEnvelope(),
      depth: MAX_DELEGATION_DEPTH,
    };
    const recordingTransport: InvokeAgentTransport = {
      async deliver(delivery) {
        return {
          status: 'enqueued',
          correlationId: delivery.envelope.correlationId,
          agentClass: delivery.agentClass,
          depth: delivery.envelope.depth,
        };
      },
    };

    await executeAsPrincipal(
      {
        db,
        principal: {
          runAsUserId: userId,
          tenantId,
          allowedTools: ['agents.invoke'],
        },
        onBehalfOfUserId: ORIGINATOR,
        audit: () => {},
      },
      async (run) => {
        const tool = createInvokeAgentTool({
          db,
          parentEnvelope: deepEnvelope,
          worker: noopWorker,
          transport: recordingTransport,
        });
        await expect(
          tool.execute({
            run,
            args: { agentClass: '@happyvertical/smrt-agents:Sub' },
            db,
          }),
        ).rejects.toThrow(DelegationDepthExceededError);
      },
    );
  });

  it('derives the worker tool ceiling from trusted state, ignoring model args', async () => {
    let capturedEnvelope: DelegationEnvelope | undefined;
    const recordingTransport: InvokeAgentTransport = {
      async deliver(delivery) {
        capturedEnvelope = delivery.envelope;
        return {
          status: 'enqueued',
          correlationId: delivery.envelope.correlationId,
          agentClass: delivery.agentClass,
          depth: delivery.envelope.depth,
        };
      },
    };

    await executeAsPrincipal(
      {
        db,
        principal: {
          runAsUserId: userId,
          tenantId,
          allowedTools: ['agents.invoke'],
        },
        onBehalfOfUserId: ORIGINATOR,
        audit: () => {},
      },
      async (run) => {
        // With a trusted resolver, the worker ceiling is the resolver's — the
        // model-supplied `allowedTools` arg is ignored entirely.
        const withResolver = createInvokeAgentTool({
          db,
          parentEnvelope: rootEnvelope(),
          worker: noopWorker,
          transport: recordingTransport,
          resolveWorkerAllowedTools: () => ['trusted.tool'],
        });
        await withResolver.execute({
          run,
          args: {
            agentClass: '@happyvertical/smrt-agents:Sub',
            allowedTools: ['evil.tool'],
          },
          db,
        });
        expect(capturedEnvelope?.allowedTools).toEqual(['trusted.tool']);

        // Without a resolver, the worker gets NO tools (fail-closed) — the model
        // arg is never trusted as the ceiling.
        const noResolver = createInvokeAgentTool({
          db,
          parentEnvelope: rootEnvelope(),
          worker: noopWorker,
          transport: recordingTransport,
        });
        await noResolver.execute({
          run,
          args: {
            agentClass: '@happyvertical/smrt-agents:Sub',
            allowedTools: ['evil.tool'],
          },
          db,
        });
        expect(capturedEnvelope?.allowedTools).toBeUndefined();
      },
    );
  });

  it('audits every action on-behalf-of the originating user, preserved along the chain', async () => {
    const entries: PrincipalAuditEntry[] = [];
    const audit = (entry: PrincipalAuditEntry) => {
      entries.push(entry);
    };

    const worker = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-w',
    });
    const sub = deriveDelegationEnvelope(worker, { correlationId: 'corr-sub' });

    await executeDelegatedInvocation({
      db,
      envelope: worker,
      agentClass: '@happyvertical/smrt-agents:Worker',
      task: {},
      worker: noopWorker,
      audit,
    });
    await executeDelegatedInvocation({
      db,
      envelope: sub,
      agentClass: '@happyvertical/smrt-agents:Sub',
      task: {},
      worker: noopWorker,
      audit,
    });

    expect(entries).toHaveLength(2);
    // Both hops act AS the same principal ON BEHALF OF the same originating user.
    for (const entry of entries) {
      expect(entry.action).toBe('agent.invoke');
      expect(entry.actorUserId).toBe(userId);
      expect(entry.onBehalfOfUserId).toBe(ORIGINATOR);
      expect(entry.tenantId).toBe(tenantId);
    }
    expect(entries[1].agentClass).toBe('@happyvertical/smrt-agents:Sub');
  });

  it("emits a correlated completion dispatch and surfaces the worker's result", async () => {
    const bus = await createDispatchBus({ db });
    const worker = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-complete',
    });

    const completion = await executeDelegatedInvocation({
      db,
      envelope: worker,
      agentClass: '@happyvertical/smrt-agents:Worker',
      task: {},
      worker: async () => ({ summary: 'all done' }),
      dispatchBus: bus,
      audit: () => {},
    });
    expect(completion.ok).toBe(true);

    const surfaced = await surfaceAgentCompletions(bus, 'corr-complete');
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toMatchObject({
      correlationId: 'corr-complete',
      agentClass: '@happyvertical/smrt-agents:Worker',
      onBehalfOfUserId: ORIGINATOR,
      ok: true,
    });
    expect(surfaced[0].result).toMatchObject({ summary: 'all done' });
  });

  it('async DispatchBus transport delivers to a worker that runs as the principal', async () => {
    const bus = await createDispatchBus({ db });
    const transport = createDispatchInvokeTransport(bus);
    const worker = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-async',
    });

    // The orchestrator "enqueues" the invocation via the DispatchBus signal.
    const enqueued = await transport.deliver({
      envelope: worker,
      agentClass: '@happyvertical/smrt-agents:Worker',
      task: { unit: 1 },
      worker: noopWorker, // ignored by the async transport
      dispatchBus: bus,
    });
    expect(enqueued.status).toBe('enqueued');
    expect(enqueued.correlationId).toBe('corr-async');

    // The worker side processes the signal and runs under the principal.
    let ranAsUserId: string | undefined;
    let sawTask: unknown;
    const processingWorker: WorkerRunner = async ({ run, task }) => {
      ranAsUserId = run.context.userId ?? undefined;
      sawTask = task;
      return { processed: true };
    };
    const processed = await processAgentInvocations({
      dispatchBus: bus,
      subscriber: 'WorkerAgent',
      worker: processingWorker,
      db,
      audit: () => {},
    });

    expect(processed).toBe(1);
    expect(ranAsUserId).toBe(userId);
    expect(sawTask).toMatchObject({ unit: 1 });

    const surfaced = await surfaceAgentCompletions(bus, 'corr-async');
    expect(surfaced.some((c) => c.ok)).toBe(true);
  });

  it('targets async invocations so a processor never claims another worker class', async () => {
    const bus = await createDispatchBus({ db });
    const transport = createDispatchInvokeTransport(bus);
    const envelope = deriveDelegationEnvelope(rootEnvelope(), {
      correlationId: 'corr-target',
    });

    // Enqueue an invocation targeted at worker class A.
    await transport.deliver({
      envelope,
      agentClass: '@happyvertical/smrt-agents:WorkerA',
      task: {},
      worker: noopWorker,
      dispatchBus: bus,
    });

    // A processor for a DIFFERENT class (B) must not claim class-A's invocation.
    const claimedByB = await processAgentInvocations({
      dispatchBus: bus,
      subscriber: 'WorkerB',
      agentClass: '@happyvertical/smrt-agents:WorkerB',
      worker: noopWorker,
      db,
      audit: () => {},
    });
    expect(claimedByB).toBe(0);

    // The class-A processor claims it.
    const claimedByA = await processAgentInvocations({
      dispatchBus: bus,
      subscriber: 'WorkerA',
      agentClass: '@happyvertical/smrt-agents:WorkerA',
      worker: noopWorker,
      db,
      audit: () => {},
    });
    expect(claimedByA).toBe(1);
  });
});
