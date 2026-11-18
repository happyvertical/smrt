/**
 * Which constructor options configure services, and how row data is kept out
 * of them.
 *
 * A model is constructed from one options bag that carries both service
 * configuration (`db`, `ai`, ...) and field values. Data that did not come
 * from the framework — a create input, a request body, a stored row — must
 * never be read as service configuration, whatever its keys are called. This
 * module names the service keys once and provides the two operations built on
 * that list: building an item's constructor options with the framework's
 * services always winning, and deciding whether a request-body key may reach
 * a model.
 *
 * Import-free at runtime so generators, emitted-code templates and the
 * browser entry can all read the same list.
 */

import type { SmrtClassOptions } from './class';

/**
 * A decision for every `SmrtClassOptions` key.
 *
 * - `'service'`: configures a service of the instance (database, AI client,
 *   filesystem, signals, ...). Never taken from data.
 * - `'internal'`: an underscore-prefixed flag that steers framework
 *   initialization. Programmatic callers may pass it; request-facing paths
 *   drop every `_`-prefixed key.
 *
 * `satisfies Record<keyof SmrtClassOptions, ...>` makes a new option without an
 * entry here a type error, so the list below cannot fall behind the interface.
 */
const SMRT_CLASS_OPTION_KINDS = {
  _className: 'internal',
  db: 'service',
  persistence: 'service',
  fs: 'service',
  ai: 'service',
  decisions: 'service',
  inference: 'service',
  usage: 'service',
  logging: 'service',
  metrics: 'service',
  pubsub: 'service',
  sanitization: 'service',
  signals: 'service',
  _reuseInitializedDb: 'internal',
  _deferRuntimeInitialization: 'internal',
} as const satisfies Record<keyof SmrtClassOptions, 'service' | 'internal'>;

/** A `SmrtClassOptions` key that configures a service. */
export type SmrtServiceOptionKey = {
  [K in keyof typeof SMRT_CLASS_OPTION_KINDS]: (typeof SMRT_CLASS_OPTION_KINDS)[K] extends 'service'
    ? K
    : never;
}[keyof typeof SMRT_CLASS_OPTION_KINDS];

/**
 * The option keys that configure services rather than describe a row:
 * `db`, `persistence`, `fs`, `ai`, `decisions`, `inference`, `usage`,
 * `logging`, `metrics`, `pubsub`, `sanitization`, `signals`.
 *
 * On every path where a collection builds a model — `create`, `createMany`,
 * STI creation and row hydration — these come from the collection and are
 * never read from the data. Generated and request-facing write paths drop
 * them from request bodies (see {@link isServiceOptionInput}).
 *
 * Derived from `SmrtClassOptions`; see `SMRT_CLASS_OPTION_KINDS`.
 */
export const SMRT_SERVICE_OPTION_KEYS: readonly SmrtServiceOptionKey[] =
  Object.freeze(
    (
      Object.keys(SMRT_CLASS_OPTION_KINDS) as Array<
        keyof typeof SMRT_CLASS_OPTION_KINDS
      >
    ).filter(
      (key): key is SmrtServiceOptionKey =>
        SMRT_CLASS_OPTION_KINDS[key] === 'service',
    ),
  );

const SERVICE_OPTION_KEY_SET: ReadonlySet<string> = new Set(
  SMRT_SERVICE_OPTION_KEYS,
);

/** Whether `key` is one of {@link SMRT_SERVICE_OPTION_KEYS}. */
export function isServiceOptionKey(key: string): key is SmrtServiceOptionKey {
  return SERVICE_OPTION_KEY_SET.has(key);
}

/**
 * Whether a request-body key must be dropped before it reaches a model.
 *
 * True for a service option key the model does not declare as a field, and
 * always for `options`: that instance property holds the service options, so
 * assigning it on a loaded instance would replace them. A model that declares
 * a real field named like a service option (a `metrics` column, say) keeps
 * that key: its value is row data and is routed away from the service option
 * of the same name by {@link buildItemOptions}.
 *
 * @param key - A key of a create or update request body
 * @param isDeclaredField - Whether the target model declares `key` as a field
 */
export function isServiceOptionInput(
  key: string,
  isDeclaredField: (key: string) => boolean,
): boolean {
  if (key === 'options') return true;
  return SERVICE_OPTION_KEY_SET.has(key) && !isDeclaredField(key);
}

/**
 * Constructor-option key under which row values travel when their field name
 * is also a service option key.
 *
 * A symbol, so it cannot arrive from JSON (a request body, MCP arguments, a
 * stored `_meta_data` blob). Its presence also marks options built by
 * {@link buildItemOptions}: on such an instance a service-named option is
 * service configuration only, and `SmrtObject` reads the field of that name
 * from here.
 *
 * @internal
 */
export const SMRT_ROW_VALUES = Symbol.for('@happyvertical/smrt-core:rowValues');

const NO_ROW_VALUES: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * Build the constructor options for a model a collection creates or hydrates.
 *
 * - `flags` go first: defaults such as `_skipLoad` that the data may override,
 *   as it always could.
 * - `data` is the create input or the stored row. Every key keeps its meaning
 *   (field values, `id`, `_meta_type`, `_insertOnly`, ...) except the service
 *   option keys, which are taken out.
 * - `services` go last and always win: every service the collection binds
 *   (its database, AI client and decision provider always; `fs`, `signals`
 *   and any other service option key when the collection was given one).
 *   An option the collection does not bind is left unset, so the model
 *   resolves it from configuration as before.
 *
 * The removed entries are kept under {@link SMRT_ROW_VALUES} so a model that
 * declares a field with one of those names still receives its value as row
 * data. A removed entry for a name the model does not declare is never read.
 *
 * @returns The options object, and the service keys `data` gave a value for
 */
export function buildItemOptions(
  data: Record<string, unknown>,
  flags: Record<string, unknown>,
  services: Pick<SmrtClassOptions, 'ai' | 'db' | 'decisions'> &
    Partial<Pick<SmrtClassOptions, SmrtServiceOptionKey>>,
): { options: Record<string, unknown>; dataServiceKeys: string[] } {
  // Spread first, then delete: keeps symbol-keyed entries callers pass on
  // purpose and never turns an own `__proto__` entry into a prototype write.
  const options: Record<string | symbol, unknown> = { ...flags, ...data };
  let rowValues: Record<string, unknown> | undefined;
  const dataServiceKeys: string[] = [];
  for (const key of SMRT_SERVICE_OPTION_KEYS) {
    if (!Object.hasOwn(options, key)) continue;
    rowValues ??= {};
    rowValues[key] = options[key];
    // An explicit `undefined` asks for nothing, so it is not reported.
    if (options[key] !== undefined) dataServiceKeys.push(key);
    delete options[key];
  }
  options.ai = services.ai;
  options.decisions = services.decisions;
  options.db = services.db;
  for (const key of SMRT_SERVICE_OPTION_KEYS) {
    if (key === 'ai' || key === 'decisions' || key === 'db') continue;
    if (Object.hasOwn(services, key) && services[key] !== undefined) {
      options[key] = services[key];
    }
  }
  options[SMRT_ROW_VALUES] = rowValues ?? NO_ROW_VALUES;
  return { options, dataServiceKeys };
}

/**
 * The row values {@link buildItemOptions} set aside, or `undefined` when the
 * options were not built by a collection (direct `new Model({...})`).
 *
 * @internal
 */
export function getRowValues(
  options: object,
): Readonly<Record<string, unknown>> | undefined {
  const values = (options as Record<symbol, unknown>)[SMRT_ROW_VALUES];
  return values && typeof values === 'object'
    ? (values as Readonly<Record<string, unknown>>)
    : undefined;
}
