// The cloud profile (#5191), by id: rows of one tenant that hold an owner's
// drafts and assistant conversations cannot be read, listed or reached by
// another tenant, even when the other tenant knows the id. (Definitions,
// history, approvals and changes waiting are in cloud-isolation.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { AppDraftVersionCollection } from '../objects/AppDraftVersion.ts';
import { AssistantMessageCollection } from '../objects/AssistantMessage.ts';
import { AssistantThreadCollection } from '../objects/AssistantThread.ts';
import {
  appendMessage,
  createThread,
  getThread,
  historyFor,
  listThreads,
  viewMessages,
} from './assistant/threads.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { runAs } from './owner.ts';

let h: CloudHarness;
beforeAll(async () => {
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
});

describe('drafts, by id', () => {
  it("another tenant cannot get, list or touch an owner's draft or its versions", async () => {
    const draftId = await runAs(h.a, async () => {
      const drafts = await AppDraftCollection.create({ db: h.db });
      const row = await drafts.create({ name: 'ann-draft', createdBy: h.a.id });
      await row.save();
      const versions = await AppDraftVersionCollection.create({ db: h.db });
      const v = await versions.create({
        draftId: row.id as string,
        version: 0,
        definition: '{"secret":"ann"}',
      });
      await v.save();
      return row.id as string;
    });
    const asB = <T>(fn: () => Promise<T>) => runAs(h.b, fn);
    const drafts = () => AppDraftCollection.create({ db: h.db });
    const versions = () => AppDraftVersionCollection.create({ db: h.db });
    expect(await asB(async () => (await drafts()).get(draftId))).toBeNull();
    expect(await asB(async () => (await drafts()).list({}))).toEqual([]);
    expect(
      await asB(async () =>
        (await versions()).list({ where: { draftId }, limit: 10 }),
      ),
    ).toEqual([]);
    // Ann still sees both.
    expect(
      await runAs(h.a, async () => (await drafts()).get(draftId)),
    ).not.toBeNull();
    expect(
      await runAs(h.a, async () =>
        (await versions()).list({ where: { draftId }, limit: 10 }),
      ),
    ).toHaveLength(1);
  });
});

describe('assistant conversations, by id', () => {
  it("another tenant cannot read an owner's thread, messages or history", async () => {
    const threadId = await runAs(h.a, async () => {
      const thread = await createThread(h.a.id, 'ann plans');
      await appendMessage(thread, {
        role: 'user',
        content: 'ann-secret-plan',
      } as never);
      return thread.id as string;
    });
    expect(await runAs(h.a, () => getThread(h.a.id, threadId))).not.toBeNull();
    // Even a request that names Ann's user id (a forged owner id) and her
    // thread id gets nothing in Bob's tenant.
    for (const asUser of [h.b.id, h.a.id]) {
      expect(await runAs(h.b, () => getThread(asUser, threadId))).toBeNull();
      expect(await runAs(h.b, () => listThreads(asUser))).toEqual([]);
    }
    expect(await runAs(h.b, () => viewMessages(threadId))).toEqual([]);
    expect(await runAs(h.b, () => historyFor(threadId))).toEqual([]);
    const raw = (c: typeof AssistantThreadCollection) =>
      runAs(h.b, async () => (await c.create({ db: h.db })).list({}));
    expect(await raw(AssistantThreadCollection)).toEqual([]);
    expect(
      await runAs(h.b, async () =>
        (await AssistantMessageCollection.create({ db: h.db })).list({}),
      ),
    ).toEqual([]);
    expect(await runAs(h.a, () => viewMessages(threadId))).toHaveLength(1);
  });
});
