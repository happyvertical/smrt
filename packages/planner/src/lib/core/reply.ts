import {
  type AssistantChange,
  buildResponseSchema,
  FALLBACK_REPLY,
  MAX_COMMANDS,
  parseChange,
  stripThinking,
} from '../assistant/change.ts';
import {
  checkSchema,
  commandSchemas,
  commandTools,
} from '../planner/commands/schemas.ts';
import { defaultCatalog, type PromptCatalog } from './catalog.ts';

/**
 * The body a host answers the planner with (wire version 1, see
 * `docs/inference-host.md`): the action JSON the browser assistant reads from a
 * model. Only `reply` is required; empty parts are left out.
 */
export interface HostReply {
  /** The sentence shown to the visitor. */
  reply: string;
  /** Recipe ids to switch on. */
  add?: string[];
  /** Recipe ids to switch off. */
  remove?: string[];
  /** A library cookbook to offer. */
  cookbook?: string;
  /** Settings to change; `taxRate` in percent. */
  settings?: { currency?: string; taxRate?: number; paymentTerms?: string };
  /** Theme tokens: a preset or `#rrggbb`, and light or dark. */
  theme?: { preset?: string; primary?: string; colorScheme?: string };
  /** Up to 8 planner commands, run in order by the planner. */
  commands?: { name: string; input: unknown }[];
}

/**
 * The JSON Schema of one model turn in host mode: `reply`, `add`, `remove`,
 * `cookbook`, `settings`, `theme` and `commands`. Recipe and cookbook ids are
 * enums, so constrained decoding cannot invent one. Pass it as the response
 * format of an OpenAI-style call; `commands[].input` is checked afterwards
 * against `commandSchemas` by `parseHostReply`.
 */
export function buildReplySchema(
  catalog: PromptCatalog = defaultCatalog,
): Record<string, unknown> {
  const schema = buildResponseSchema(
    catalog.recipes,
    catalog.cookbooks,
    true,
    true,
  );
  (schema.properties as Record<string, unknown>).commands = {
    type: 'array',
    maxItems: MAX_COMMANDS,
    items: {
      type: 'object',
      properties: {
        name: { enum: commandTools.map((tool) => tool.name) },
        input: { type: 'object' },
      },
      required: ['name', 'input'],
      additionalProperties: false,
    },
  };
  return schema;
}

/** The reply schema for the planner's own library. */
export const replySchema: Record<string, unknown> = buildReplySchema();

export interface ParsedHostReply {
  /** False when the model's text was not a JSON object (the reply is a fallback or its prose). */
  ok: boolean;
  /** Safe to send back to the planner as the response body. */
  reply: HostReply;
  /** What was dropped or repaired, for the server's log. Never shown to the visitor. */
  issues: string[];
}

const nonEmpty = (value: object) => Object.keys(value).length > 0;

function toHostReply(change: AssistantChange): HostReply {
  return {
    reply: change.reply,
    ...(change.add.length ? { add: change.add } : {}),
    ...(change.remove.length ? { remove: change.remove } : {}),
    ...(change.cookbook ? { cookbook: change.cookbook } : {}),
    ...(nonEmpty(change.settings) ? { settings: change.settings } : {}),
    ...(nonEmpty(change.theme) ? { theme: change.theme } : {}),
    ...(change.commands?.length ? { commands: change.commands } : {}),
  };
}

/**
 * Read a model's text into a reply the planner accepts, with the same rules the
 * browser assistant applies: thinking tags are dropped, unknown recipe and
 * cookbook ids are removed, settings and theme are cut to valid values, and
 * malformed JSON still yields its `reply` text (never raw model output).
 * Commands are checked here against their input schemas; an unknown or invalid
 * one is dropped and listed in `issues`. The planner validates again.
 */
export function parseHostReply(
  text: string,
  catalog: PromptCatalog = defaultCatalog,
): ParsedHostReply {
  const issues: string[] = [];
  const change = parseChange(text, catalog.recipes, catalog.cookbooks, {
    commands: true,
  });
  let ok = true;
  try {
    const value = JSON.parse(stripThinking(text));
    ok = typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    ok = false;
  }
  if (!ok) issues.push('the reply was not a JSON object');
  if (!change.reply) {
    change.reply = FALLBACK_REPLY;
    issues.push('the reply had no "reply" sentence');
  }
  if (change.commands) {
    const valid: { name: string; input: unknown }[] = [];
    for (const call of change.commands) {
      const schema = Object.hasOwn(commandSchemas, call.name)
        ? commandSchemas[call.name as keyof typeof commandSchemas]
        : undefined;
      if (!schema) {
        issues.push(`dropped unknown command "${call.name}"`);
        continue;
      }
      const problem = checkSchema(schema, call.input);
      if (problem) {
        issues.push(`dropped ${call.name}: ${problem}`);
        continue;
      }
      valid.push(call);
    }
    change.commands = valid;
  }
  return { ok, reply: toHostReply(change), issues };
}
