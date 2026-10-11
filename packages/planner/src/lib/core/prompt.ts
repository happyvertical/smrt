import {
  buildMatchIndex,
  type MatchIndex,
  matchText,
} from '../assistant/match.ts';
import { buildSystemPrompt } from '../assistant/prompt.ts';
import {
  HOST_HISTORY_CHARS,
  HOST_HISTORY_TURNS,
  HOST_MESSAGE_CHARS,
} from '../inference/host.ts';
import { commandTools } from '../planner/commands/schemas.ts';
import type { PlanSnapshot } from '../planner/commands/types.ts';
import type { ColorSchemeSetting, ThemeSetting } from '../theme/theme.ts';
import { defaultCatalog, type PromptCatalog } from './catalog.ts';

/** One earlier turn of the conversation. */
export interface HostTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface HostPromptInput {
  /** The visitor's text (clipped to the contract's 2000 characters). */
  message: string;
  /** The plan as the planner reports it. */
  snapshot: PlanSnapshot;
  /** Recent turns, oldest first. Anything but user or assistant is ignored. */
  history?: readonly { role: string; content: string }[];
  /** The recipes and cookbooks the model may use; the planner's library by default. */
  catalog?: PromptCatalog;
}

/** A chat call's input: `system` apart, so it fits OpenAI- and Anthropic-style APIs. */
export interface HostPrompt {
  /** The system prompt. OpenAI-style: send it as a leading `system` message. Anthropic-style: the `system` parameter. */
  system: string;
  /** The conversation, oldest first; the last entry is the visitor's message. */
  messages: HostTurn[];
}

const indexes = new WeakMap<PromptCatalog, MatchIndex>();

function indexOf(catalog: PromptCatalog): MatchIndex {
  let index = indexes.get(catalog);
  if (!index) {
    index = buildMatchIndex(catalog.recipes, catalog.cookbooks, {
      theme: true,
    });
    indexes.set(catalog, index);
  }
  return index;
}

/** The snapshot's theme as the setting the prompt describes. */
function themeOf(snapshot: PlanSnapshot): ThemeSetting | undefined {
  const { preset, primary, colorScheme } = snapshot.theme;
  const theme: ThemeSetting = {};
  if (preset) theme.preset = preset;
  if (primary) theme.custom = { primary };
  if (colorScheme && colorScheme !== 'system') {
    theme.colorScheme = colorScheme as ColorSchemeSetting;
  }
  return Object.keys(theme).length ? theme : undefined;
}

/** `rename_item(id, label)`: required inputs bare, optional ones with `?`. */
function signature(tool: (typeof commandTools)[number]): string {
  const schema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(schema.properties ?? {}).map((key) =>
    required.has(key) ? key : `${key}?`,
  );
  return `${tool.name}(${keys.join(', ')})`;
}

/**
 * What only a host server adds to the browser prompt: the `commands` field and
 * the menu ids it needs. Everything above it is the browser assistant's prompt.
 */
function commandSection(snapshot: PlanSnapshot): string[] {
  const out = [
    '',
    '"commands": optional, at most 8 {"name", "input"} run in order, only for what add/remove/settings/theme cannot do. Commands:',
    ...commandTools.map((tool) => `- ${signature(tool)}: ${tool.description}`),
  ];
  const menu = snapshot.sections
    .filter((section) => !section.hidden)
    .map((section) => {
      const items = section.items
        .filter((item) => !item.hidden)
        .map((item) => `${item.id} (${item.label})`);
      return `- ${section.id} (${section.label})${items.length ? `: ${items.join(', ')}` : ''}`;
    });
  if (menu.length) {
    out.push('', 'Menu ids for rename/hide/show/focus:', ...menu);
  }
  if (snapshot.undo.length) {
    out.push('', `Undo ids available: ${snapshot.undo.join(', ')}.`);
  }
  return out;
}

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, max) : text;

/**
 * The chat call for one host-mode turn. The system prompt is the browser
 * assistant's own (`buildSystemPrompt`: same wording, worked examples, focused
 * recipe lines for what the message matches, settings and theme from the
 * snapshot), plus the host-only `commands` section. The messages are the recent
 * history and then the visitor's message.
 *
 * Ask the model for JSON matching `buildReplySchema()` and read the answer with
 * `parseHostReply`.
 */
export function buildHostPrompt(input: HostPromptInput): HostPrompt {
  const catalog = input.catalog ?? defaultCatalog;
  const { snapshot } = input;
  const message = clip(input.message, HOST_MESSAGE_CHARS);
  const system = [
    buildSystemPrompt(
      catalog.recipes,
      snapshot.recipes.map((recipe) => recipe.id),
      catalog.cookbooks,
      {
        currency: snapshot.settings.currency,
        taxRate: Number((snapshot.settings.taxRate / 100).toFixed(6)),
        paymentTerms: snapshot.settings.paymentTerms,
      },
      matchText(indexOf(catalog), message),
      { current: themeOf(snapshot) },
    ),
    ...commandSection(snapshot),
  ].join('\n');
  const history = (input.history ?? [])
    .filter(
      (turn): turn is HostTurn =>
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string',
    )
    .slice(-HOST_HISTORY_TURNS)
    .map((turn) => ({
      role: turn.role,
      content: clip(turn.content, HOST_HISTORY_CHARS),
    }));
  return { system, messages: [...history, { role: 'user', content: message }] };
}
