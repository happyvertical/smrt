// Opt-in check against a REAL provider (costs a few cents). Run with
//   REAL_AI=1 SMRT_AI_PROVIDER=openai|anthropic <key in the environment> \
//   npx vitest run src/lib/server/assistant/real-provider.manual.test.ts
// It builds Chore and adds two records in one thread, then asks a brand-new
// thread to add two example chores: the second turn sends the app's generated
// tools (chore_*) to the provider, which rejected the request when a tool
// schema carried a top-level anyOf.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getHost } from '../host.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import { createAiModelFactory } from './model.ts';
import { drive } from './test-helpers.ts';

const real = process.env.REAL_AI === '1';
let h: ShellHarness;
beforeAll(async () => {
  if (real) h = await openShell();
});
afterAll(async () => {
  if (real) await h.close();
});

describe.skipIf(!real)('a real provider with an app model present', () => {
  it('builds Chore and adds records, then a new thread adds more', async () => {
    const model = await createAiModelFactory()({ principal: h.owner });
    const first = await drive({
      principal: h.owner,
      model,
      text: 'Track chores: a title, a due date, done or not, and points. Then add two chores: Dishes (2 points) and Laundry (3 points).',
    });
    expect(first.stop).toBe('complete');
    const host = await getHost();
    expect(host.describe().models.Chore).toBeTruthy();
    const before = (await host.list('Chore')).length;
    expect(before).toBeGreaterThanOrEqual(2);
    const second = await drive({
      principal: h.owner,
      model,
      text: 'Add two example chores.',
    });
    expect(second.stop).toBe('complete');
    expect((await host.list('Chore')).length).toBeGreaterThanOrEqual(
      before + 2,
    );
  }, 240_000);
});
