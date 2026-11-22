/**
 * What core relies on from the SDK's usage events, and what the
 * provider-level callback still does for a tracked call (#5516, plan
 * sections 3.2 and 4; test contract T26). Here a client declaring
 * `usageFeatures.parts` is modelled by the stub (the released SDK is
 * exercised in `ai-sdk-usage-real.test.ts`), and the per-call
 * sink (R5) is not used, so the provider-level callback keeps every observer
 * it had and binds the event to its call by the call's secret.
 */

import type { UsageEvent } from '@happyvertical/ai';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import { parseUsagePart, type UsagePartRef } from '../system/ai-call-ledger';
import { createTrackedAiClient } from '../tracked-ai-client';
import {
  ledgerFixture,
  readOnlyCall,
  resetStub,
  stub,
  stubGetAI,
  tenantSpend,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

beforeEach(() => {
  config.reset();
  resetStub();
  getAIMock.mockReset();
  getAIMock.mockImplementation(stubGetAI);
});
afterEach(async () => {
  config.reset();
  await closeAiRunTestDatabases();
});

describe('the SDK usage event contract core reads', () => {
  it('a legacy producer that builds UsageEvent without part still type-checks and is single mode input', () => {
    const legacy: UsageEvent = {
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message' as UsageEvent['operation'],
      duration: 1,
      timestamp: new Date(),
    };
    const withPart: UsageEvent & { part?: UsagePartRef } = {
      ...legacy,
      part: { call: 'c', index: 0, last: true },
    };
    expect(parseUsagePart((legacy as { part?: unknown }).part)).toBeUndefined();
    expect(parseUsagePart(withPart.part)).toEqual({
      call: 'c',
      index: 0,
      last: true,
    });
  });
});

describe.each(
  aiRunTestEngines,
)('provider-level callback of a tracked call on %s', (engine) => {
  it('events reach the provider with the call tags, never a usage callback option', async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    const sent = stub.sent[0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('onUsage');
    expect(sent).not.toHaveProperty('runContext');
    expect(sent.usageTags).toMatchObject({
      aiCallId: (await readOnlyCall(f.db, f.run.id)).callId,
    });
  });

  it("a host onUsage that throws still lets the call capture its usage, and the host's error propagates", async () => {
    const db = await newAiRunTestDatabase(engine);
    const hostError = new Error('host callback failed');
    const seen: unknown[] = [];
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        onUsage: (event: unknown) => {
          seen.push(event);
          throw hostError;
        },
      } as never,
    });
    const { run, context } = await tracked.openRun({ type: 'turn' });
    let propagated: unknown;
    stub.script.onCall = async (call) => {
      await call
        .emit({
          index: 0,
          last: true,
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        })
        .catch((error) => {
          propagated = error;
        });
      return 'answer';
    };
    await (
      (await tracked.client(
        { promptKey: 'p' },
        { runContext: context },
      )) as unknown as {
        message(input: unknown): Promise<unknown>;
      }
    ).message('hello');
    expect(seen).toHaveLength(1);
    expect(propagated).toBe(hostError);
    expect((await readOnlyCall(db, run.id)).chargedTokens).toBe(7);
  });

  it('one tracked call on a provider that reports usage writes exactly one row and the spend equals the charge', async () => {
    const records: SmrtAiUsageEvent[] = [];
    const f = await ledgerFixture(engine, {
      usage: {
        handlers: [
          { handle: async (e: SmrtAiUsageEvent) => void records.push(e) },
        ],
      },
    });
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    expect(await usageRows(f.db)).toHaveLength(1);
    const spend = await tenantSpend(f.db, 'tenant-a');
    expect(spend.tokens).toBe(call.chargedTokens);
    expect(spend.cost).toBeCloseTo(call.chargedCost ?? 0, 6);
    expect(records).toHaveLength(1);
  });
});
