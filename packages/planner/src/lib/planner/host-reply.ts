import {
  appliedCoaching,
  appliedSpokenCoaching,
} from '../assistant/coaching.ts';
import { honestReply } from '../assistant/transport.ts';
import {
  applySampleContext,
  parseSampleContext,
} from '../data/sample-context.ts';
import { recipes } from '../recipes/index.ts';
import type {
  BatchResult,
  CommandName,
  PlannerController,
  PlanSnapshot,
} from './commands/index.ts';

export interface PlannerHostReplyResult {
  ok: boolean;
  snapshot: PlanSnapshot;
  result?: BatchResult;
  content: string;
  spokenContent?: string;
  sampleContextApplied: boolean;
  error?: { code: string; message: string };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Validate a hosted reply and execute it on the real mounted plan, without a chat thread. */
export function applyPlannerHostReply(options: {
  controller: PlannerController;
  allowedCommands: readonly CommandName[];
  id: string;
  expectedRevision: number;
  reply: unknown;
}): PlannerHostReplyResult {
  const { controller, allowedCommands, id, expectedRevision, reply } = options;
  const before = controller.snapshot();
  const fail = (code: string, message: string): PlannerHostReplyResult => ({
    ok: false,
    snapshot: controller.snapshot(),
    content: message,
    sampleContextApplied: false,
    error: { code, message },
  });
  if (before.revision !== expectedRevision)
    return fail(
      'conflict',
      'The app changed while the reply was being prepared. Read the current plan and try again.',
    );
  if (
    !object(reply) ||
    Object.keys(reply).some(
      (key) => !['reply', 'commands', 'sampleContext'].includes(key),
    ) ||
    typeof reply.reply !== 'string' ||
    reply.reply.length > 4000 ||
    (reply.commands !== undefined && !Array.isArray(reply.commands))
  )
    return fail(
      'invalid_input',
      'The hosted reply is not a supported command reply.',
    );
  const commands = (reply.commands ?? []) as unknown[];
  if (
    commands.length > 16 ||
    commands.some(
      (command) =>
        !object(command) ||
        Object.keys(command).some((key) => !['name', 'input'].includes(key)) ||
        typeof command.name !== 'string' ||
        !allowedCommands.includes(command.name as CommandName),
    )
  )
    return fail(
      'forbidden',
      'The reply contains a command this host does not allow.',
    );
  const sample =
    reply.sampleContext === undefined
      ? undefined
      : parseSampleContext(reply.sampleContext);
  if (reply.sampleContext !== undefined && !sample)
    return fail(
      'invalid_input',
      'The reply contains invalid fictional sample context.',
    );
  if (!commands.length)
    return {
      ok: true,
      snapshot: before,
      content: honestReply(reply.reply, '', false),
      sampleContextApplied: false,
    };
  const result = controller.batch({ id, expectedRevision, commands });
  if (!result.ok)
    return { ...fail(result.error.code, result.error.message), result };
  const changed = result.results.some((item) => item.receipt.changed);
  const sampleContextApplied =
    !!sample && changed && !result.replayed && applySampleContext(sample);
  const summary = result.results
    .map((item) => item.receipt.summary)
    .filter(Boolean)
    .join(' ');
  const content = [
    honestReply(reply.reply, summary, false),
    appliedCoaching(before, result.snapshot, result.results, recipes),
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ok: true,
    snapshot: result.snapshot,
    result,
    content,
    ...(changed && !result.replayed
      ? {
          spokenContent: appliedSpokenCoaching(
            before,
            result.snapshot,
            result.results,
          ),
        }
      : {}),
    sampleContextApplied,
  };
}
