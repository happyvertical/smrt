/**
 * Providers the shell ships with (#3713):
 *
 * - {@link createNavigationProvider}: "go to" rows from the shell nav model.
 * - {@link createModelProviders}: "New <Noun>" commands and cross-model record
 *   search derived from the SMRT manifest, over the generated REST routes.
 *
 * Both are plain `PaletteProvider`s; an app is free to ignore them and
 * register its own.
 */
import { unwrapListResult } from '@happyvertical/smrt-web';
import type {
  ShellNavGroup,
  ShellNavItem,
} from '../workspace/admin-shell/types.js';
import {
  type NavigableManifestEntry,
  navigableManifestEntries,
  pluralizeClassName,
  type SmrtManifestEntryLike,
} from '../workspace/manifest-nav.js';
import type { PaletteItem, PaletteProvider } from './types.js';

type MaybeGetter<T> = T | (() => T);

function read<T>(value: MaybeGetter<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return typeof value === 'function' ? (value as () => T)() : value;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavigationProviderOptions {
  /** Flat nav items (the `AppShell` `nav` prop). A getter follows reactive state. */
  nav?: MaybeGetter<readonly ShellNavItem[]>;
  /** Grouped nav (the `AppShell` `groups` prop). */
  groups?: MaybeGetter<readonly ShellNavGroup[]>;
  /** Provider id (default `navigation`). */
  id?: string;
  /** Group heading (default `Go to`). */
  label?: string;
  /** Sort position among providers (default 10). */
  order?: number;
}

function flattenNav(
  items: readonly ShellNavItem[],
  trail: string | undefined,
  out: PaletteItem[],
  seen: Set<string>,
): void {
  for (const item of items) {
    const id = `nav:${item.id ?? item.href}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({
        id,
        title: item.label,
        subtitle: trail,
        keywords: item.description ? [item.description] : undefined,
        icon: item.icon,
        kind: 'navigation',
        href: item.href,
      });
    }
    if (item.children?.length) {
      flattenNav(item.children, trail ?? item.label, out, seen);
    }
  }
}

/**
 * Rows that open each page of the shell navigation. Pass the *applied* nav
 * (`useShellLayout().applied`) to honour sections a user hid or renamed.
 *
 * @example
 * ```ts
 * createNavigationProvider({
 *   nav: () => layout.applied.nav,
 *   groups: () => layout.applied.groups,
 * });
 * ```
 */
export function createNavigationProvider(
  options: NavigationProviderOptions = {},
): PaletteProvider {
  return {
    id: options.id ?? 'navigation',
    label: options.label ?? 'Go to',
    order: options.order ?? 10,
    items() {
      const out: PaletteItem[] = [];
      const seen = new Set<string>();
      flattenNav(read(options.nav, []), undefined, out, seen);
      for (const group of read(options.groups, [])) {
        flattenNav(group.items, group.heading, out, seen);
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Models (manifest-driven)
// ---------------------------------------------------------------------------

/** The slice of a manifest field the palette reads. */
export interface PaletteManifestFieldLike {
  type?: string;
  sensitive?: boolean;
  transient?: boolean;
  enum?: readonly unknown[];
}

/** A manifest entry with its fields (a subset of `SmartObjectDefinition`). */
export interface PaletteManifestEntryLike extends SmrtManifestEntryLike {
  fields?: Record<string, PaletteManifestFieldLike>;
}

/** A manifest (a subset of `SmartObjectManifest`). */
export interface PaletteManifestLike {
  objects: Record<string, PaletteManifestEntryLike>;
}

/** A model with the metadata the model providers work from. */
export interface PaletteModel {
  entry: PaletteManifestEntryLike;
  /** Qualified name (`@pkg/name:Class`). */
  qualifier: string;
  /** Plural, display-cased label ("Invoices"). */
  label: string;
  /** Singular, display-cased label ("Invoice"). */
  singular: string;
  /** REST collection path segment. */
  collection: string;
  /** Whether the REST `create` route exists. */
  creatable: boolean;
  /** Text fields searched with a `like` filter. */
  searchFields: readonly string[];
  /** Field read as a record's title. */
  titleField: string | null;
}

/** A row from the REST list route. */
export type PaletteRecordRow = Record<string, unknown>;

/** Request handed to {@link ModelProvidersOptions.searchRows}. */
export interface PaletteRecordSearch {
  model: PaletteModel;
  field: string;
  query: string;
  limit: number;
  signal: AbortSignal;
}

export interface ModelProvidersOptions {
  /** The app manifest. */
  manifest: PaletteManifestLike;
  /**
   * Qualified class names the user may reach (the nav helper's allow-list).
   * Omit to include every navigable model; the server still decides what rows
   * come back.
   */
  permittedResources?: readonly string[];
  /** Only these models (class or qualified names) get search. */
  searchModels?: readonly string[];
  /**
   * Text fields to search per model, keyed by class or qualified name.
   * Default: the model's `title`, `name`, `displayName`, `label`, `subject`,
   * `headline`, `number`, `code`, `sku`, `email` or `slug` field, first found.
   */
  searchFields?: Readonly<Record<string, readonly string[]>>;
  /** How many of those fields to search per model (default 1). */
  fieldsPerModel?: number;
  /** Most models searched per query (default 20). */
  maxModels?: number;
  /** Rows taken from each model (default 3). */
  perModelLimit?: number;
  /** Concurrent requests per query (default 4). */
  concurrency?: number;
  /** Base of the generated REST routes (default `/api/v1`). */
  apiBasePath?: string;
  /** Base of the app's pages, used by the default hrefs (default ``). */
  pagesBasePath?: string;
  /**
   * Page for a model's list, new-record form and a record. Return null to
   * leave a row without a destination (it is then omitted). Defaults:
   * `<pages>/<collection>`, `<pages>/<collection>/new`,
   * `<pages>/<collection>/<id>`.
   */
  hrefs?: {
    list?: (model: PaletteModel) => string | null;
    create?: (model: PaletteModel) => string | null;
    record?: (model: PaletteModel, row: PaletteRecordRow) => string | null;
  };
  /** Fetch used by the default `searchRows` (default: global `fetch`). */
  fetch?: typeof fetch;
  /**
   * Replace the default `GET <api>/<collection>?<field>[like]=%q%` request,
   * for example with a server search endpoint. The default's `LIKE` is
   * case-insensitive on SQLite and case-sensitive on PostgreSQL.
   */
  searchRows?: (request: PaletteRecordSearch) => Promise<PaletteRecordRow[]>;
  /** Also offer an "open <list>" row per model (default false; nav covers it). */
  lists?: boolean;
  /** Text of a create row (default `New <singular>`). */
  createTitle?: (model: PaletteModel) => string;
  /** Text of a list row (default the plural label). */
  listTitle?: (model: PaletteModel) => string;
  /** Group heading of the commands provider (default `Create`). */
  commandsLabel?: string;
  /** Group heading of the search provider (default `Records`). */
  recordsLabel?: string;
  /** Sort positions (defaults 20 and 30). */
  commandsOrder?: number;
  recordsOrder?: number;
}

const TITLE_FIELDS = [
  'title',
  'name',
  'displayName',
  'label',
  'subject',
  'headline',
  'number',
  'code',
  'sku',
  'email',
  'slug',
] as const;

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** "SalesInvoice" -> "Sales invoice". */
function humanize(className: string): string {
  const words = className
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  if (!words) return className;
  return words[0].toUpperCase() + words.slice(1).toLowerCase();
}

function isSearchableField(field: PaletteManifestFieldLike | undefined) {
  return (
    field?.type === 'text' &&
    !field.sensitive &&
    !field.transient &&
    !(field.enum && field.enum.length > 0)
  );
}

/**
 * Resolve each navigable model's palette metadata from the manifest. Exported
 * for apps that build their own rows from the same model list.
 */
export function paletteModelsFromManifest(
  options: Pick<
    ModelProvidersOptions,
    'manifest' | 'permittedResources' | 'searchFields' | 'fieldsPerModel'
  >,
): PaletteModel[] {
  const perModel = Math.max(1, options.fieldsPerModel ?? 1);
  const models = navigableManifestEntries<PaletteManifestEntryLike>(
    options.manifest,
    { permittedResources: options.permittedResources },
  ).map(
    ({
      entry,
      qualifier,
      creatable,
    }: NavigableManifestEntry<PaletteManifestEntryLike>): PaletteModel => {
      const fields = entry.fields ?? {};
      const override =
        options.searchFields?.[qualifier] ??
        options.searchFields?.[entry.className];
      const candidates = (override ?? TITLE_FIELDS).filter((name) =>
        override ? true : isSearchableField(fields[name]),
      );
      const titleField =
        TITLE_FIELDS.find((name) => isSearchableField(fields[name])) ??
        override?.[0] ??
        null;
      return {
        entry,
        qualifier,
        label:
          entry.decoratorConfig?.ui?.label ??
          pluralizeClassName(humanize(entry.className)),
        singular: humanize(entry.className),
        collection: entry.collection ?? kebab(entry.className),
        creatable,
        searchFields: candidates.slice(0, perModel),
        titleField,
      };
    },
  );
  return models.sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.qualifier.localeCompare(b.qualifier),
  );
}

async function defaultSearchRows(
  request: PaletteRecordSearch,
  options: { fetch?: typeof fetch; apiBasePath: string },
): Promise<PaletteRecordRow[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error('No fetch available for palette search.');
  // `%` is a wildcard in LIKE; a typed one would only widen the match.
  const term = request.query.replaceAll('%', '');
  const params = new URLSearchParams();
  params.set(`${request.field}[like]`, `%${term}%`);
  params.set('limit', String(request.limit));
  const response = await doFetch(
    `${options.apiBasePath}/${request.model.collection}?${params}`,
    {
      signal: request.signal,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    },
  );
  // A model the user may not read (403) or a route the app does not mount
  // (404) is a model without results, not a failed search.
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return [];
  }
  if (!response.ok) {
    throw new Error(
      `Search of ${request.model.collection} failed (${response.status}).`,
    );
  }
  const body: unknown = await response.json();
  // The generated list routes answer `{ items, count, limit, offset }`; a
  // bare array is accepted too. Any other shape is a model without results.
  try {
    return unwrapListResult(body, request.model.collection).filter(
      (row): row is PaletteRecordRow =>
        row !== null && typeof row === 'object' && !Array.isArray(row),
    );
  } catch {
    return [];
  }
}

/** Run `task` over `inputs` with at most `limit` in flight; keeps input order. */
async function mapPool<I, O>(
  inputs: readonly I[],
  limit: number,
  task: (input: I) => Promise<O>,
): Promise<PromiseSettledResult<O>[]> {
  const results = new Array<PromiseSettledResult<O>>(inputs.length);
  let next = 0;
  const worker = async () => {
    while (next < inputs.length) {
      const index = next;
      next += 1;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await task(inputs[index]),
        };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, worker),
  );
  return results;
}

function rowTitle(model: PaletteModel, row: PaletteRecordRow): string {
  const fields = [model.titleField, ...TITLE_FIELDS];
  for (const name of fields) {
    if (!name) continue;
    const value = row[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return typeof row.id === 'string' ? row.id : model.singular;
}

/**
 * The model-driven providers: a `Create` commands provider ("New invoice")
 * and a `Records` provider that searches the models' text fields through the
 * generated REST routes. Models and their eligibility come from the same
 * filters as the manifest-derived navigation.
 *
 * @example
 * ```ts
 * const palette = createCommandPalette({
 *   providers: [
 *     createNavigationProvider({ nav }),
 *     ...createModelProviders({ manifest, pagesBasePath: '/app' }),
 *   ],
 *   navigate: goto,
 * });
 * ```
 */
export function createModelProviders(
  options: ModelProvidersOptions,
): PaletteProvider[] {
  const models = paletteModelsFromManifest(options);
  const pagesBase = options.pagesBasePath ?? '';
  const apiBase = options.apiBasePath ?? '/api/v1';
  const listHref = (model: PaletteModel) =>
    options.hrefs?.list
      ? options.hrefs.list(model)
      : `${pagesBase}/${model.collection}`;
  const createHref = (model: PaletteModel) =>
    options.hrefs?.create
      ? options.hrefs.create(model)
      : `${pagesBase}/${model.collection}/new`;
  const recordHref = (model: PaletteModel, row: PaletteRecordRow) =>
    options.hrefs?.record
      ? options.hrefs.record(model, row)
      : typeof row.id === 'string' || typeof row.id === 'number'
        ? `${pagesBase}/${model.collection}/${encodeURIComponent(String(row.id))}`
        : null;

  const commands: PaletteProvider = {
    id: 'models.commands',
    label: options.commandsLabel ?? 'Create',
    order: options.commandsOrder ?? 20,
    items() {
      const items: PaletteItem[] = [];
      for (const model of models) {
        if (model.creatable) {
          const href = createHref(model);
          if (href) {
            items.push({
              id: `create:${model.qualifier}`,
              title:
                options.createTitle?.(model) ??
                `New ${model.singular.toLowerCase()}`,
              subtitle: model.label,
              keywords: ['create', 'add', model.singular],
              icon: 'add',
              kind: 'create',
              href,
            });
          }
        }
        if (options.lists) {
          const href = listHref(model);
          if (href) {
            items.push({
              id: `list:${model.qualifier}`,
              title: options.listTitle?.(model) ?? model.label,
              keywords: [model.singular],
              kind: 'navigation',
              href,
            });
          }
        }
      }
      return items;
    },
  };

  const allow = options.searchModels ? new Set(options.searchModels) : null;
  const targets = models
    .filter((model) => model.searchFields.length > 0)
    .filter(
      (model) =>
        !allow ||
        allow.has(model.qualifier) ||
        allow.has(model.entry.className),
    )
    .slice(0, options.maxModels ?? 20);

  const records: PaletteProvider = {
    id: 'models.records',
    label: options.recordsLabel ?? 'Records',
    order: options.recordsOrder ?? 30,
    minQueryLength: 2,
    async search(query, { signal, limit }) {
      if (targets.length === 0) return [];
      const perModel = Math.max(1, options.perModelLimit ?? 3);
      const jobs = targets.flatMap((model) =>
        model.searchFields.map((field) => ({ model, field })),
      );
      const run = options.searchRows
        ? options.searchRows
        : (request: PaletteRecordSearch) =>
            defaultSearchRows(request, {
              fetch: options.fetch,
              apiBasePath: apiBase,
            });
      const settled = await mapPool(
        jobs,
        Math.max(1, options.concurrency ?? 4),
        ({ model, field }) =>
          run({ model, field, query, limit: perModel, signal }),
      );
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (settled.every((outcome) => outcome.status === 'rejected')) {
        const first = settled[0] as PromiseRejectedResult;
        throw first.reason instanceof Error
          ? first.reason
          : new Error('Record search failed.');
      }

      // One list per model (a model with several search fields merges, by id),
      // then interleaved so a chatty model cannot crowd out the rest.
      const perModelItems = new Map<PaletteModel, PaletteItem[]>();
      jobs.forEach(({ model }, index) => {
        const outcome = settled[index];
        if (outcome.status !== 'fulfilled') return;
        const list = perModelItems.get(model) ?? [];
        for (const row of outcome.value) {
          const id = row.id;
          if (typeof id !== 'string' && typeof id !== 'number') continue;
          const key = `${model.qualifier}:${id}`;
          if (list.some((item) => item.id === key)) continue;
          const href = recordHref(model, row);
          if (!href) continue;
          list.push({
            id: key,
            title: rowTitle(model, row),
            subtitle: model.singular,
            kind: 'record',
            href,
          });
        }
        perModelItems.set(model, list);
      });
      const lists = [...perModelItems.values()].map((list) =>
        list.slice(0, perModel),
      );
      const merged: PaletteItem[] = [];
      for (let round = 0; merged.length < limit; round += 1) {
        let added = false;
        for (const list of lists) {
          if (round < list.length && merged.length < limit) {
            merged.push(list[round]);
            added = true;
          }
        }
        if (!added) break;
      }
      return merged;
    },
  };

  return [commands, records];
}
