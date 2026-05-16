/**
 * Tests for the server-side dock availability gate composer
 * (happyvertical/smrt#1226 Phase 4c).
 *
 * Covers:
 *  - tools without `gates` are unconditionally included (back-compat)
 *  - single passing / failing gate
 *  - AND semantics across multiple gates
 *  - sync and async evaluators
 *  - unknown-prefix error message (loud-fail)
 *  - context pass-through
 *  - edge cases (empty arrays / maps)
 *  - label / badge passthrough into AvailableTool
 */

import { describe, expect, it, vi } from 'vitest';
import { composeDockAvailability } from '../compose-availability.js';
import type {
  GatedToolSummary,
  GateEvaluationContext,
  GateEvaluator,
} from '../types.js';

const alwaysTrue: GateEvaluator = () => true;
const alwaysFalse: GateEvaluator = () => false;
const asyncTrue: GateEvaluator = async () => true;
const asyncFalse: GateEvaluator = async () => false;

describe('composeDockAvailability', () => {
  it('includes tools without a `gates` field unconditionally', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'chat', label: 'Chat' }],
      context: {},
      evaluators: {},
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('chat');
  });

  it('includes tools with an empty `gates` array unconditionally', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'chat', label: 'Chat', gates: [] }],
      context: {},
      evaluators: {},
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('chat');
  });

  it('includes a tool whose single gate evaluates to true', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'video', label: 'Video', gates: ['feature:video-tools'] }],
      context: {},
      evaluators: { feature: alwaysTrue },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('video');
  });

  it('excludes a tool whose single gate evaluates to false', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'video', label: 'Video', gates: ['feature:video-tools'] }],
      context: {},
      evaluators: { feature: alwaysFalse },
    });
    expect(result).toEqual([]);
  });

  it('requires ALL gates to pass (AND semantics)', async () => {
    const result = await composeDockAvailability({
      tools: [
        {
          id: 'restricted',
          label: 'Restricted',
          gates: ['permission:foo', 'feature:bar'],
        },
      ],
      context: {},
      evaluators: { permission: alwaysTrue, feature: alwaysFalse },
    });
    expect(result).toEqual([]);
  });

  it('includes a tool only when EVERY gate passes', async () => {
    const result = await composeDockAvailability({
      tools: [
        {
          id: 'allowed',
          label: 'Allowed',
          gates: ['permission:foo', 'feature:bar'],
        },
      ],
      context: {},
      evaluators: { permission: alwaysTrue, feature: asyncTrue },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('allowed');
  });

  it('accepts sync evaluators that return a plain boolean', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 't', label: 'T', gates: ['x:y'] }],
      context: {},
      evaluators: { x: (_id, _ctx) => true },
    });
    expect(result).toHaveLength(1);
  });

  it('accepts async evaluators that return a Promise<boolean>', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 't', label: 'T', gates: ['x:y'] }],
      context: {},
      evaluators: { x: async () => true },
    });
    expect(result).toHaveLength(1);
  });

  it('throws with a clear message when a gate prefix has no evaluator', async () => {
    await expect(
      composeDockAvailability({
        tools: [
          { id: 'video', label: 'Video', gates: ['feature:video-tools'] },
        ],
        context: {},
        evaluators: { permission: alwaysTrue },
      }),
    ).rejects.toThrow(
      /No evaluator registered for gate prefix "feature".*tool "video".*gate "feature:video-tools".*Available prefixes: permission/,
    );
  });

  it('reports `(none)` for available prefixes when the evaluators map is empty', async () => {
    await expect(
      composeDockAvailability({
        tools: [
          { id: 'video', label: 'Video', gates: ['feature:video-tools'] },
        ],
        context: {},
        evaluators: {},
      }),
    ).rejects.toThrow(/Available prefixes: \(none\)/);
  });

  it('passes the supplied `context` through to each evaluator', async () => {
    const ctx: GateEvaluationContext = { userId: 'u-1', tenantId: 't-1' };
    const permission = vi.fn(() => true);
    const feature = vi.fn(() => true);

    await composeDockAvailability({
      tools: [
        {
          id: 'tool',
          label: 'Tool',
          gates: ['permission:articles.publish', 'feature:video-tools'],
        },
      ],
      context: ctx,
      evaluators: { permission, feature },
    });

    expect(permission).toHaveBeenCalledWith('permission:articles.publish', ctx);
    expect(feature).toHaveBeenCalledWith('feature:video-tools', ctx);
  });

  it('returns an empty array for an empty `tools` input', async () => {
    const result = await composeDockAvailability({
      tools: [],
      context: {},
      evaluators: {},
    });
    expect(result).toEqual([]);
  });

  it('handles an empty `evaluators` map fine when no tools have gates', async () => {
    const result = await composeDockAvailability({
      tools: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      context: {},
      evaluators: {},
    });
    expect(result.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('passes through `label` and `badge` from the tool def to AvailableTool', async () => {
    const tools: GatedToolSummary[] = [
      { id: 'inbox', label: 'Inbox', badge: 3 },
      { id: 'tasks', label: 'Tasks', badge: 'new' },
      { id: 'plain', label: 'Plain' }, // no badge → omitted in output
    ];

    const result = await composeDockAvailability({
      tools,
      context: {},
      evaluators: {},
    });

    expect(result).toEqual([
      { id: 'inbox', label: 'Inbox', badge: 3 },
      { id: 'tasks', label: 'Tasks', badge: 'new' },
      { id: 'plain', label: 'Plain' },
    ]);
  });

  it('omits a missing `label` from the AvailableTool result (lets the dock fall back)', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'no-label' } as GatedToolSummary],
      context: {},
      evaluators: {},
    });
    // No `label` key at all — `defineToolsDock.applyAvailability` falls
    // back to the registered ToolDef metadata.
    expect(result[0]).toEqual({ id: 'no-label' });
    expect(result[0]).not.toHaveProperty('label');
    expect(result[0]).not.toHaveProperty('badge');
  });

  it('omits `badge` when the tool def has no badge (no implicit clear)', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'chat', label: 'Chat', gates: [] }],
      context: {},
      evaluators: {},
    });
    // The dock treats `badge: null` as an explicit clear of the
    // registered default badge. Absence must remain absence.
    expect(result[0]).toEqual({ id: 'chat', label: 'Chat' });
    expect(result[0]).not.toHaveProperty('badge');
  });

  it('preserves explicit `badge: null` when the caller does set it', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 'reset', label: 'Reset', badge: null }],
      context: {},
      evaluators: {},
    });
    expect(result[0]).toEqual({ id: 'reset', label: 'Reset', badge: null });
  });

  it('filters a mixed input correctly (gated + ungated, pass + fail)', async () => {
    const result = await composeDockAvailability({
      tools: [
        { id: 'always', label: 'Always' },
        { id: 'allowed', label: 'Allowed', gates: ['permission:foo'] },
        { id: 'denied', label: 'Denied', gates: ['permission:bar'] },
        { id: 'flagged', label: 'Flagged', gates: ['feature:on'] },
      ],
      context: { userId: 'u-1' },
      evaluators: {
        permission: async (id) => id === 'permission:foo',
        feature: asyncTrue,
      },
    });

    expect(result.map((t) => t.id)).toEqual(['always', 'allowed', 'flagged']);
  });

  it('still throws on unknown prefix even when other gates on the same tool would have passed', async () => {
    await expect(
      composeDockAvailability({
        tools: [
          {
            id: 'mixed',
            label: 'Mixed',
            gates: ['permission:ok', 'mystery:??'],
          },
        ],
        context: {},
        evaluators: { permission: alwaysTrue },
      }),
    ).rejects.toThrow(/gate "mystery:\?\?"/);
  });

  it('treats async evaluator rejections as errors (does not swallow)', async () => {
    await expect(
      composeDockAvailability({
        tools: [{ id: 't', label: 'T', gates: ['boom:bar'] }],
        context: {},
        evaluators: {
          boom: async () => {
            throw new Error('evaluator exploded');
          },
        },
      }),
    ).rejects.toThrow('evaluator exploded');
  });

  it('respects falsy results from async evaluators (excludes the tool)', async () => {
    const result = await composeDockAvailability({
      tools: [{ id: 't', label: 'T', gates: ['x:y'] }],
      context: {},
      evaluators: { x: asyncFalse },
    });
    expect(result).toEqual([]);
  });

  // Regression: a gate prefix that names an inherited `Object.prototype`
  // property (e.g. `constructor`, `toString`, `hasOwnProperty`, `valueOf`,
  // `__proto__`) MUST NOT bypass the unknown-prefix fail-loud path. Prior
  // to the fix, `evaluators[prefix]` resolved to a built-in function and
  // got invoked, returning a truthy value and silently passing the gate.
  it('throws on prototype-key gate prefixes (constructor, toString, hasOwnProperty, valueOf, __proto__)', async () => {
    const evaluators = { permission: () => true };
    for (const prefix of [
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      '__proto__',
    ]) {
      await expect(
        composeDockAvailability({
          tools: [{ id: 'x', label: 'X', gates: [`${prefix}:any`] }],
          context: {},
          evaluators,
        }),
      ).rejects.toThrow(/No evaluator registered for gate prefix/);
    }
  });

  it('throws when an evaluator entry is not a function', async () => {
    await expect(
      composeDockAvailability({
        tools: [{ id: 'x', label: 'X', gates: ['permission:any'] }],
        context: {},
        evaluators: {
          // Intentional non-function evaluator — should fail loud.
          permission: 'not-a-function',
        } as unknown as Parameters<
          typeof composeDockAvailability
        >[0]['evaluators'],
      }),
    ).rejects.toThrow(/No evaluator registered/);
  });

  // Regression for the TCtx generic parameterization (issue 1242 fix #5).
  // Verifies the typed-context flow compiles end-to-end: the evaluator
  // receives a typed `ctx` (string fields, not `unknown`) without a cast.
  it('preserves the caller-supplied context type through to evaluators (TCtx generic)', async () => {
    interface MyContext extends GateEvaluationContext {
      userId: string;
      tenantId: string;
    }

    let observedUserId: string | undefined;
    let observedTenantId: string | undefined;

    const result = await composeDockAvailability<MyContext>({
      tools: [{ id: 't', label: 'T', gates: ['permission:articles.publish'] }],
      context: { userId: 'u-1', tenantId: 't-1' },
      evaluators: {
        permission: (gateId, ctx) => {
          // No cast required — ctx.userId and ctx.tenantId are typed string.
          observedUserId = ctx.userId;
          observedTenantId = ctx.tenantId;
          const [, slug] = gateId.split(':', 2);
          return slug === 'articles.publish';
        },
      },
    });

    expect(result).toHaveLength(1);
    expect(observedUserId).toBe('u-1');
    expect(observedTenantId).toBe('t-1');
  });
});
