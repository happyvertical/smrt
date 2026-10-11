import type { Recipe } from '../recipes/types.ts';
import type { AppSettings } from '../settings/app-settings.ts';
import { CURRENCY_CODES } from '../settings/currencies.ts';
import {
  type ColorSchemeSetting,
  normalizeHex,
  THEME_PRESETS,
  type ThemeSetting,
} from '../theme/theme.ts';

/** Settings as the model states them: tax in percent. All optional. */
export interface SettingsPatch {
  currency?: string;
  /** Percent, 0 to 100. */
  taxRate?: number;
  paymentTerms?: string;
}

/**
 * A look as the model states it: a preset, or a brand colour (hex), and
 * optionally light or dark. Tokens only; there is no way to ask for CSS.
 */
export interface ThemePatch {
  preset?: string;
  /** `#rrggbb`. */
  primary?: string;
  colorScheme?: ColorSchemeSetting;
}

/** Longest payment terms the assistant will write. */
export const MAX_TERMS_LENGTH = 40;

/** Longest reply the schema allows; bounds a model that starts to loop. */
export const MAX_REPLY_LENGTH = 200;

/** Shown when the model's answer cannot be read; never the raw output. */
export const FALLBACK_REPLY = 'Sorry, say that again?';

/**
 * What the model returns each turn: a reply, recipe ids to add or remove, an
 * optional cookbook to offer (never applied without a click) and optional
 * settings to change.
 */
export interface AssistantChange {
  reply: string;
  add: string[];
  remove: string[];
  cookbook: string | null;
  settings: SettingsPatch;
  theme: ThemePatch;
  /**
   * Command calls a trusted host server asked for (`parseChange` with
   * `commands: true`); the controller validates each one. Absent otherwise.
   */
  commands?: { name: string; input: unknown }[];
}

/** Most command calls one reply may carry. */
export const MAX_COMMANDS = 8;

/** The slice of the cookbook store that holds the app theme. */
export interface ThemeStore {
  read(): ThemeSetting | undefined;
  write(theme: ThemeSetting | undefined): void;
}

/** The slice of the cookbook store that holds the app settings. */
export interface SettingsStore {
  read(): AppSettings;
  write(settings: AppSettings): void;
}

/** The slice of the recipe store the assistant drives (the Planner cards use the same). */
export interface RecipeStore {
  readonly ids: readonly string[];
  add(...ids: string[]): void;
  remove(...ids: string[]): void;
}

/** The result of applying a change, after `requires` and `requiresAny` ran. */
export interface AppliedChange {
  /** Newly on, including recipes pulled in because another needs them. */
  added: string[];
  /** Newly off. */
  removed: string[];
  /** Asked to remove, but another added recipe needs them. */
  kept: string[];
}

/**
 * The JSON Schema for one turn. `add` and `remove` are enums of recipe ids,
 * so grammar-constrained decoding cannot produce an id that does not exist.
 */
export function buildResponseSchema(
  recipes: readonly Pick<Recipe, 'id'>[],
  cookbooks: readonly { id: string }[] = [],
  withSettings = false,
  withTheme = false,
): Record<string, unknown> {
  const ids = recipes.map((recipe) => recipe.id);
  const list = { type: 'array', items: { enum: ids }, maxItems: ids.length };
  const properties: Record<string, unknown> = {
    reply: { type: 'string', maxLength: MAX_REPLY_LENGTH },
    add: list,
    remove: list,
  };
  if (cookbooks.length) {
    properties.cookbook = { enum: [...cookbooks.map((c) => c.id), null] };
  }
  if (withSettings) {
    properties.settings = {
      type: 'object',
      properties: {
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        taxRate: { type: 'number', minimum: 0, maximum: 100 },
        paymentTerms: { type: 'string', maxLength: MAX_TERMS_LENGTH },
      },
      additionalProperties: false,
    };
  }
  if (withTheme) {
    properties.theme = {
      type: 'object',
      properties: {
        preset: { enum: [...THEME_PRESETS] },
        primary: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        colorScheme: { enum: ['light', 'dark'] },
      },
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties,
    required: ['reply', 'add', 'remove'],
    additionalProperties: false,
  };
}

/** Keep only valid settings: circulating currency, tax 0-100, short terms. */
export function parseSettings(value: unknown): SettingsPatch {
  const out: SettingsPatch = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const object = value as Record<string, unknown>;
  if (typeof object.currency === 'string') {
    const code = object.currency.trim().toUpperCase();
    if (CURRENCY_CODES.has(code)) out.currency = code;
  }
  const tax = object.taxRate;
  if (
    typeof tax === 'number' &&
    Number.isFinite(tax) &&
    tax >= 0 &&
    tax <= 100
  ) {
    out.taxRate = tax;
  }
  if (typeof object.paymentTerms === 'string') {
    const terms = [...object.paymentTerms]
      .map((ch) =>
        ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch,
      )
      .join('')
      .trim();
    if (terms && terms.length <= MAX_TERMS_LENGTH) out.paymentTerms = terms;
  }
  return out;
}

/** Keep only a known preset, a hex colour and light or dark. */
export function parseThemePatch(value: unknown): ThemePatch {
  const out: ThemePatch = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const object = value as Record<string, unknown>;
  if (
    typeof object.preset === 'string' &&
    THEME_PRESETS.includes(object.preset)
  ) {
    out.preset = object.preset;
  }
  const primary = normalizeHex(object.primary);
  if (primary) out.primary = primary;
  if (
    object.colorScheme === 'light' ||
    object.colorScheme === 'dark' ||
    object.colorScheme === 'system'
  ) {
    out.colorScheme = object.colorScheme;
  }
  return out;
}

/** Remove Qwen3-style thinking, including a block cut off before it closed. */
export function stripThinking(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

/** Pull a `reply` string out of JSON that does not parse (e.g. cut short). */
function lenientReply(raw: string): string | null {
  const match = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (!match) return null;
  let text = match[1];
  // A cut-off escape at the very end would make JSON.parse throw.
  text = text.replace(/\\$/, '');
  try {
    text = JSON.parse(`"${text}"`) as string;
  } catch {
    text = text.replace(/\\n/g, ' ').replace(/\\"/g, '"');
  }
  return text.trim() || null;
}

/**
 * Read a model reply. Thinking tags are dropped. Malformed JSON still yields
 * its `reply` text when one can be found, otherwise a short fallback: raw model
 * output is never shown. Prose with no JSON in it is kept as the reply.
 * Unknown ids are dropped, an id that is both added and removed is ignored,
 * and repeats collapse.
 */
export function parseChange(
  input: string,
  recipes: readonly Pick<Recipe, 'id'>[],
  cookbooks: readonly { id: string }[] = [],
  options: { commands?: boolean } = {},
): AssistantChange {
  const known = new Set(recipes.map((recipe) => recipe.id));
  const raw = stripThinking(input);
  const plain = (reply: string): AssistantChange => ({
    reply,
    add: [],
    remove: [],
    cookbook: null,
    settings: {},
    theme: {},
  });
  const looksLikeJson = /^[\s`]*[{[]/.test(raw) || /"reply"\s*:/.test(raw);
  const unreadable = () =>
    plain(looksLikeJson ? (lenientReply(raw) ?? FALLBACK_REPLY) : raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return unreadable();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return unreadable();
  }
  const object = value as Record<string, unknown>;
  const pick = (field: unknown): string[] =>
    Array.isArray(field)
      ? [
          ...new Set(
            field.filter(
              (id): id is string => typeof id === 'string' && known.has(id),
            ),
          ),
        ]
      : [];
  const add = pick(object.add);
  const remove = pick(object.remove);
  const both = new Set(add.filter((id) => remove.includes(id)));
  const commands = options.commands ? pickCommands(object.commands) : [];
  return {
    reply: typeof object.reply === 'string' ? object.reply.trim() : '',
    add: add.filter((id) => !both.has(id)),
    remove: remove.filter((id) => !both.has(id)),
    cookbook:
      typeof object.cookbook === 'string' &&
      cookbooks.some((c) => c.id === object.cookbook)
        ? object.cookbook
        : null,
    settings: parseSettings(object.settings),
    theme: parseThemePatch(object.theme),
    ...(commands.length ? { commands } : {}),
  };
}

/** `{ name, input }` entries; the controller rejects unknown names and bad input. */
function pickCommands(value: unknown): { name: string; input: unknown }[] {
  if (!Array.isArray(value)) return [];
  const out: { name: string; input: unknown }[] = [];
  for (const entry of value) {
    if (out.length >= MAX_COMMANDS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { name, input } = entry as { name?: unknown; input?: unknown };
    if (typeof name !== 'string') continue;
    out.push({ name, input: input ?? {} });
  }
  return out;
}

/** A sentence for the chat saying what changed, by recipe label. */
export function describeChange(
  applied: AppliedChange,
  recipes: readonly Pick<Recipe, 'id' | 'label'>[],
): string {
  const label = (id: string) =>
    recipes.find((recipe) => recipe.id === id)?.label ?? id;
  const names = (ids: string[]) => ids.map(label).join(', ');
  const parts: string[] = [];
  if (applied.added.length) parts.push(`Added ${names(applied.added)}.`);
  if (applied.removed.length) parts.push(`Removed ${names(applied.removed)}.`);
  if (applied.kept.length) {
    parts.push(`Kept ${names(applied.kept)} (needed).`);
  }
  return parts.join(' ');
}
