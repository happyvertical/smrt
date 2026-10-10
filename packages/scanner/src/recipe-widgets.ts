/**
 * Validation of the recipe `widget` surface kind (#3727, phase 2).
 *
 * Kept apart from `recipes.ts` so the surface reader there only dispatches to
 * it. Everything here is a literal copy of a smrt-svelte overview rule (the
 * scanner cannot import smrt-svelte): the option field types, key / type / page
 * id patterns and the span range. `recipe-widgets.test.ts` in smrt-svelte
 * checks the copies against the source.
 */
import type {
  RecipeWidgetData,
  RecipeWidgetOption,
  RecipeWidgetOptionType,
} from '@happyvertical/smrt-types';

/** smrt-svelte `WidgetOptionType`, in its order. */
export const RECIPE_WIDGET_OPTION_TYPES = [
  'text',
  'markdown',
  'identifier',
  'model',
  'integer',
  'number',
  'boolean',
  'enum',
] as const satisfies readonly RecipeWidgetOptionType[];

/** Keys a `widget` surface accepts, in emitted order. */
export const RECIPE_WIDGET_KEYS = [
  'kind',
  'type',
  'export',
  'label',
  'description',
  'icon',
  'version',
  'migrate',
  'options',
  'data',
  'allowedIn',
  'defaultSpan',
  'minSpan',
  'maxSpan',
] as const;

/** smrt-svelte `WIDGET_TYPE_PATTERN`. */
export const WIDGET_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** smrt-svelte `OVERVIEW_PAGE_ID_PATTERN`. */
export const OVERVIEW_PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
/** smrt-svelte schema `KEY_PATTERN`. */
export const OPTION_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** smrt-svelte `IDENTIFIER_PATTERN`. */
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** smrt-svelte `MODEL_PATTERN`, with the package part required for data needs. */
export const MODEL_PATTERN =
  /^(?:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*:)?[A-Za-z][A-Za-z0-9_]{0,63}$/;
const QUALIFIED_MODEL_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*:[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MODEL_MAX_LENGTH = 160;
const ICON_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const SPAN_MIN = 1;
export const SPAN_MAX = 4;
export const TEXT_MAX = 200;
export const MARKDOWN_MAX = 10_000;

const OPTION_KEYS = new Set([
  'key',
  'type',
  'label',
  'help',
  'required',
  'default',
  'min',
  'max',
  'maxLength',
  'choices',
]);

type Fail = (message: string) => void;
type ReadRef = (
  value: unknown,
  at: string,
  field: string,
) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function readOption(
  raw: unknown,
  at: string,
  fail: Fail,
): RecipeWidgetOption | undefined {
  if (!isRecord(raw)) {
    fail(`${at} must be an object literal`);
    return undefined;
  }
  let ok = true;
  const bad = (message: string) => {
    fail(`${at}${message}`);
    ok = false;
  };
  for (const key of Object.keys(raw)) {
    if (!OPTION_KEYS.has(key)) bad(` does not accept \`${key}\``);
  }
  const { key, type } = raw;
  if (typeof key !== 'string' || !OPTION_KEY_PATTERN.test(key)) {
    bad('.key must be a camelCase name of at most 32 letters and digits');
  }
  if (
    typeof type !== 'string' ||
    !(RECIPE_WIDGET_OPTION_TYPES as readonly string[]).includes(type)
  ) {
    bad(
      `.type must be one of ${RECIPE_WIDGET_OPTION_TYPES.join(', ')} (got \`${String(type)}\`)`,
    );
    return undefined;
  }
  if (!nonEmpty(raw.label)) bad('.label must be a non-empty string');
  if (raw.help !== undefined && !nonEmpty(raw.help)) {
    bad('.help must be a non-empty string');
  }
  if (raw.required !== undefined && typeof raw.required !== 'boolean') {
    bad('.required must be a boolean');
  }
  const numeric = type === 'integer' || type === 'number';
  for (const bound of ['min', 'max'] as const) {
    const value = raw[bound];
    if (value === undefined) continue;
    if (!numeric) {
      bad(`.${bound} applies only to integer and number options`);
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      bad(`.${bound} must be a finite number`);
    }
  }
  if (
    typeof raw.min === 'number' &&
    typeof raw.max === 'number' &&
    raw.min > raw.max
  ) {
    bad('.min cannot exceed .max');
  }
  const textual = type === 'text' || type === 'markdown';
  if (raw.maxLength !== undefined) {
    if (!textual) {
      bad('.maxLength applies only to text and markdown options');
    } else if (
      typeof raw.maxLength !== 'number' ||
      !Number.isSafeInteger(raw.maxLength) ||
      raw.maxLength < 1
    ) {
      bad('.maxLength must be a positive integer');
    }
  }

  let choiceValues: string[] | undefined;
  if (type === 'enum') {
    const choices = raw.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      bad('.choices must be a non-empty list of { value, label }');
    } else {
      choiceValues = [];
      choices.forEach((choice, index) => {
        const where = `.choices[${index}]`;
        if (
          !isRecord(choice) ||
          Object.keys(choice).some((k) => k !== 'value' && k !== 'label')
        ) {
          bad(`${where} must be { value, label } and nothing else`);
        } else if (!nonEmpty(choice.value) || !nonEmpty(choice.label)) {
          bad(`${where} needs a non-empty value and label`);
        } else if (choiceValues?.includes(choice.value)) {
          bad(`${where} repeats the value \`${choice.value}\``);
        } else {
          choiceValues?.push(choice.value);
        }
      });
    }
  } else if (raw.choices !== undefined) {
    bad('.choices applies only to enum options');
  }

  const value = raw.default;
  if (value !== undefined) {
    const mismatch = (what: string) => bad(`.default must be ${what}`);
    switch (type) {
      case 'text':
      case 'markdown': {
        const max =
          typeof raw.maxLength === 'number'
            ? raw.maxLength
            : type === 'markdown'
              ? MARKDOWN_MAX
              : TEXT_MAX;
        if (typeof value !== 'string') mismatch('a string');
        else if (value.length > max) mismatch(`at most ${max} characters`);
        break;
      }
      case 'identifier':
        if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
          mismatch('an identifier (letters, digits, `_`, `.`, `-`)');
        }
        break;
      case 'model':
        if (
          typeof value !== 'string' ||
          value.length > MODEL_MAX_LENGTH ||
          !MODEL_PATTERN.test(value)
        ) {
          mismatch('a model name (`Class`, `pkg:Class` or `@scope/pkg:Class`)');
        }
        break;
      case 'enum':
        if (
          typeof value !== 'string' ||
          (choiceValues && !choiceValues.includes(value))
        ) {
          mismatch('one of the choices');
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') mismatch('a boolean');
        break;
      default:
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          mismatch('a finite number');
        } else if (type === 'integer' && !Number.isSafeInteger(value)) {
          mismatch('a safe integer');
        } else if (
          (typeof raw.min === 'number' && value < raw.min) ||
          (typeof raw.max === 'number' && value > raw.max)
        ) {
          mismatch('within min and max');
        }
    }
  }
  if (!ok) return undefined;

  const out: Record<string, unknown> = {};
  for (const name of [
    'key',
    'type',
    'label',
    'help',
    'required',
    'default',
    'min',
    'max',
    'maxLength',
    'choices',
  ]) {
    if (raw[name] !== undefined) out[name] = raw[name];
  }
  if (type === 'enum') {
    out.choices = (raw.choices as Array<Record<string, string>>).map(
      (choice) => ({ value: choice.value, label: choice.label }),
    );
  }
  return out as unknown as RecipeWidgetOption;
}

function readOptions(
  raw: unknown,
  at: string,
  fail: Fail,
): RecipeWidgetOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`${at}.options must be a non-empty list of option objects`);
    return undefined;
  }
  const out: RecipeWidgetOption[] = [];
  const keys = new Set<string>();
  let ok = true;
  raw.forEach((entry, index) => {
    const option = readOption(entry, `${at}.options[${index}]`, fail);
    if (!option) {
      ok = false;
      return;
    }
    if (keys.has(option.key)) {
      fail(`${at}.options[${index}].key \`${option.key}\` is already declared`);
      ok = false;
      return;
    }
    keys.add(option.key);
    out.push(option);
  });
  return ok ? out : undefined;
}

function readData(
  raw: unknown,
  at: string,
  fail: Fail,
  readRef: ReadRef,
): RecipeWidgetData | undefined {
  if (!isRecord(raw)) {
    fail(`${at}.data must be an object literal`);
    return undefined;
  }
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (key !== 'load' && key !== 'models') {
      fail(`${at}.data does not accept \`${key}\``);
      ok = false;
    }
  }
  const out: RecipeWidgetData = {};
  if (raw.load !== undefined) {
    const ref = readRef(raw.load, `${at}.data`, 'load');
    if (ref === undefined) ok = false;
    else out.load = ref as RecipeWidgetData['load'];
  }
  if (raw.models !== undefined) {
    const models = raw.models;
    if (!Array.isArray(models) || models.length === 0) {
      fail(`${at}.data.models must be a non-empty list of qualified models`);
      ok = false;
    } else {
      const seen = new Set<string>();
      for (const [index, model] of models.entries()) {
        if (
          typeof model !== 'string' ||
          model.length > MODEL_MAX_LENGTH ||
          !QUALIFIED_MODEL_PATTERN.test(model)
        ) {
          fail(
            `${at}.data.models[${index}] must be a qualified class name like \`@scope/pkg:Class\``,
          );
          ok = false;
        } else if (seen.has(model)) {
          fail(`${at}.data.models[${index}] repeats \`${model}\``);
          ok = false;
        } else {
          seen.add(model);
        }
      }
      out.models = [...seen];
    }
  }
  if (ok && !out.load && !out.models) {
    fail(`${at}.data needs \`load\` or \`models\``);
    ok = false;
  }
  return ok ? out : undefined;
}

/**
 * Validate the widget-specific part of a `widget` surface (everything but
 * `kind`, `export` and `label`, which the generic surface reader owns). Returns
 * the validated fields (without the generic ones), or `undefined` after
 * reporting every problem through `fail`.
 */
export function readWidgetSurface(
  entry: Record<string, unknown>,
  at: string,
  fail: Fail,
  readRef: ReadRef,
): Record<string, unknown> | undefined {
  let ok = true;
  const bad = (message: string) => {
    fail(`${at}${message}`);
    ok = false;
  };
  const out: Record<string, unknown> = {};

  const { type } = entry;
  if (typeof type !== 'string' || !WIDGET_TYPE_PATTERN.test(type)) {
    bad('.type must be a lowercase kebab id of at most 32 characters');
  } else {
    out.type = type;
  }
  if (entry.description !== undefined) {
    if (nonEmpty(entry.description)) out.description = entry.description;
    else bad('.description must be a non-empty string');
  }
  if (entry.icon !== undefined) {
    if (typeof entry.icon === 'string' && ICON_PATTERN.test(entry.icon)) {
      out.icon = entry.icon;
    } else {
      bad('.icon must be an icon name');
    }
  }

  let version = 1;
  if (entry.version !== undefined) {
    if (
      typeof entry.version === 'number' &&
      Number.isSafeInteger(entry.version) &&
      entry.version >= 1
    ) {
      version = entry.version;
      out.version = entry.version;
    } else {
      bad('.version must be a positive integer');
    }
  }
  if (entry.migrate !== undefined) {
    const ref = readRef(entry.migrate, at, 'migrate');
    if (ref === undefined) ok = false;
    else if (version < 2) {
      bad('.migrate needs a `version` above 1');
    } else out.migrate = ref;
  }

  if (entry.options !== undefined) {
    const options = readOptions(entry.options, at, fail);
    if (options) out.options = options;
    else ok = false;
  }
  if (entry.data !== undefined) {
    const data = readData(entry.data, at, fail, readRef);
    if (data) out.data = data;
    else ok = false;
  }

  if (entry.allowedIn !== undefined) {
    const placements = entry.allowedIn;
    if (!Array.isArray(placements) || placements.length === 0) {
      bad('.allowedIn must be a non-empty list of overview ids');
    } else {
      const seen = new Set<string>();
      placements.forEach((id, index) => {
        if (typeof id !== 'string' || !OVERVIEW_PAGE_ID_PATTERN.test(id)) {
          bad(
            `.allowedIn[${index}] must be an overview id like \`events.home\``,
          );
        } else if (seen.has(id)) {
          bad(`.allowedIn[${index}] repeats \`${id}\``);
        } else {
          seen.add(id);
        }
      });
      out.allowedIn = [...seen];
    }
  }

  const spans: Record<'minSpan' | 'defaultSpan' | 'maxSpan', number> = {
    minSpan: SPAN_MIN,
    defaultSpan: SPAN_MIN,
    maxSpan: SPAN_MAX,
  };
  for (const name of ['defaultSpan', 'minSpan', 'maxSpan'] as const) {
    const value = entry[name];
    if (value === undefined) continue;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < SPAN_MIN ||
      value > SPAN_MAX
    ) {
      bad(`.${name} must be an integer from ${SPAN_MIN} to ${SPAN_MAX}`);
    } else {
      out[name] = value;
      spans[name] = value;
    }
  }
  if (
    ok &&
    (spans.minSpan > spans.maxSpan ||
      (entry.defaultSpan !== undefined &&
        (spans.defaultSpan < spans.minSpan ||
          spans.defaultSpan > spans.maxSpan)))
  ) {
    bad('.minSpan <= .defaultSpan <= .maxSpan must hold');
  }
  return ok ? out : undefined;
}
