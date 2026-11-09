// Assistant threads in shell.db. Every read and write is scoped to the owner's
// user id, so a thread id from another user is a 404, never a leak.
import type { AIMessage, AIToolCall } from '@happyvertical/ai';
import type { ThreadMessage, ThreadSummary } from '../../assistant/events.ts';
import {
  type AssistantMessage,
  AssistantMessageCollection,
  type AssistantRole,
} from '../../objects/AssistantMessage.ts';
import {
  type AssistantThread,
  AssistantThreadCollection,
} from '../../objects/AssistantThread.ts';
import { getShellDb } from '../host.ts';

/** Messages replayed to the model per turn (older ones stay stored). */
export const HISTORY_MESSAGES = 40;
/** A stored tool result is cut to this before it goes back to the model. */
export const HISTORY_TOOL_CHARS = 6_000;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

async function threadsColl() {
  return AssistantThreadCollection.create({ db: await getShellDb() });
}
async function messagesColl() {
  return AssistantMessageCollection.create({ db: await getShellDb() });
}

export async function createThread(
  ownerId: string,
  title: string,
): Promise<AssistantThread> {
  const now = new Date().toISOString();
  const row = await (await threadsColl()).create({
    ownerId,
    title: title.slice(0, 80),
    createdAt: now,
    updatedAt: now,
  });
  await row.save();
  return row;
}

/** The owner's thread, or null (missing or someone else's). */
export async function getThread(
  ownerId: string,
  id: string,
): Promise<AssistantThread | null> {
  const row = await (await threadsColl()).get(id);
  return row && row.ownerId === ownerId ? row : null;
}

export async function listThreads(ownerId: string): Promise<ThreadSummary[]> {
  const rows = await (await threadsColl()).list({
    where: { ownerId },
    limit: 200,
  });
  return rows
    .map((r) => ({
      id: r.id as string,
      title: r.title,
      updatedAt: iso(r.updatedAt),
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export interface NewMessage {
  role: AssistantRole;
  content: string;
  toolCalls?: AIToolCall[];
  toolCallId?: string;
  meta?: ThreadMessage['tool'];
}

export async function appendMessage(
  thread: AssistantThread,
  message: NewMessage,
): Promise<AssistantMessage> {
  const coll = await messagesColl();
  const last = (
    await coll.list({
      where: { threadId: thread.id as string },
      orderBy: 'seq DESC',
      limit: 1,
    })
  )[0];
  const row = await coll.create({
    threadId: thread.id as string,
    seq: (last?.seq ?? 0) + 1,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls ? JSON.stringify(message.toolCalls) : '',
    toolCallId: message.toolCallId ?? '',
    meta: message.meta ? JSON.stringify(message.meta) : '',
    createdAt: new Date().toISOString(),
  });
  await row.save();
  thread.updatedAt = new Date().toISOString();
  await thread.save();
  return row;
}

async function rows(threadId: string): Promise<AssistantMessage[]> {
  const list = await (await messagesColl()).list({
    where: { threadId },
    limit: 100_000,
  });
  return list.sort((a, b) => a.seq - b.seq);
}

function parse<T>(text: string): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** The thread as the dock shows it (tool calls folded into their chips). */
export async function viewMessages(threadId: string): Promise<ThreadMessage[]> {
  const out: ThreadMessage[] = [];
  for (const m of await rows(threadId)) {
    if (m.role === 'assistant' && !m.content) continue; // tool-call-only step
    const tool = parse<NonNullable<ThreadMessage['tool']>>(m.meta);
    out.push({
      id: m.id as string,
      seq: m.seq,
      role: m.role,
      content: m.role === 'tool' ? '' : m.content,
      ...(m.role === 'tool' && tool ? { tool } : {}),
    });
  }
  return out;
}

/**
 * The conversation to replay: the last {@link HISTORY_MESSAGES} messages, kept
 * valid for a provider. A tool result must follow the assistant message that
 * asked for it (a window cut can strand one), and an assistant tool call with
 * no result (a turn cut short) is dropped to its text.
 */
export async function historyFor(threadId: string): Promise<AIMessage[]> {
  const all = (await rows(threadId)).slice(-HISTORY_MESSAGES);
  const answered = new Set(
    all.filter((m) => m.role === 'tool').map((m) => m.toolCallId),
  );
  const asked = new Set<string>();
  const out: AIMessage[] = [];
  for (const m of all) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const calls = (parse<AIToolCall[]>(m.toolCalls) ?? []).filter((c) =>
        answered.has(c.id),
      );
      for (const c of calls) asked.add(c.id);
      if (!calls.length && !m.content) continue;
      out.push({
        role: 'assistant',
        content: m.content,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else if (asked.has(m.toolCallId)) {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content:
          m.content.length > HISTORY_TOOL_CHARS
            ? `${m.content.slice(0, HISTORY_TOOL_CHARS)} [cut]`
            : m.content,
      });
    }
  }
  // The window may start mid-exchange: begin at the first user message.
  const first = out.findIndex((m) => m.role === 'user');
  return first <= 0 ? out : out.slice(first);
}
