/** Adapts the existing generated REST fetchers to the screens' transport-neutral source. */
import {
  createDefinitionFetchers,
  type SmrtCrudFetchers,
  type SmrtWebCollectionDefinition,
  SmrtWebRequestError,
  throwIfSmrtWebError,
  unwrapItemResult,
  unwrapListResult,
} from '@happyvertical/smrt-web';
import type {
  RecipeScreensSource,
  ScreenCollectionDefinition,
  ScreenRecord,
  ScreenReferenceSources,
} from './types.js';

/** REST metadata is optional for adapters, separate from transport-neutral screens. */
type RestDefinition = ScreenCollectionDefinition & {
  endpoint?: SmrtWebCollectionDefinition['endpoint'];
  actions?: Readonly<SmrtWebCollectionDefinition['actions']>;
};

export function createRecipeScreensSource(
  definition: RestDefinition,
  fetchers: Pick<SmrtCrudFetchers, 'list'> & Partial<SmrtCrudFetchers>,
  options: {
    allPages?: boolean;
    filter?: { field: string; value: string };
  } = {},
): RecipeScreensSource {
  const name = definition.name ?? definition.objectRef;
  const allowed = (action: string) =>
    definition.actions?.includes(action) === true;
  const inScope = (row: ScreenRecord) =>
    !options.filter ||
    String(row[options.filter.field] ?? '') === options.filter.value;
  const writeValues = (values: Record<string, unknown>) =>
    options.filter
      ? { ...values, [options.filter.field]: options.filter.value }
      : values;
  const source: RecipeScreensSource = {
    list: async () => {
      if (!options.allPages)
        return unwrapListResult(await fetchers.list(), name).filter(inScope);
      const rows: ScreenRecord[] = [];
      // A keyed menu entry can have matching rows beyond the first REST page.
      for (let page = 0; page < 40; page++) {
        const items = unwrapListResult(
          await fetchers.list({ limit: 500, offset: page * 500 }),
          name,
        );
        rows.push(...items.filter(inScope));
        if (items.length < 500) break;
      }
      return rows;
    },
  };
  const label = definition.displayLabelField;
  if (label && Object.hasOwn(definition.fields, label) && allowed('list')) {
    source.search = async ({ query, offset, limit }) => {
      // Ask for one extra row to detect the next page without relying on a transport-specific count.
      const rows = unwrapListResult(
        await fetchers.list({
          limit: limit + 1,
          offset,
          orderBy: `${label} ASC, ${definition.idField ?? 'id'} ASC`,
          ...(query.trim()
            ? { where: { [label]: { op: 'like', value: `%${query.trim()}%` } } }
            : {}),
        }),
        name,
      );
      return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
    };
  }
  if (fetchers.get && allowed('get')) {
    source.get = async (id) => {
      try {
        const row = unwrapItemResult(
          await fetchers.get?.(encodeURIComponent(id)),
          `get(${name})`,
        );
        return row && inScope(row) ? row : undefined;
      } catch (error) {
        if (error instanceof SmrtWebRequestError && error.status === 404)
          return undefined;
        throw error;
      }
    };
  }
  if (fetchers.create && allowed('create'))
    source.create = async (values) =>
      unwrapItemResult(
        await fetchers.create?.(writeValues(values)),
        `create(${name})`,
      );
  if (fetchers.update && allowed('update'))
    source.update = async (id, values) =>
      unwrapItemResult(
        await fetchers.update?.(encodeURIComponent(id), writeValues(values)),
        `update(${name})`,
      );
  if (fetchers.delete && allowed('delete'))
    source.delete = async (id) => {
      throwIfSmrtWebError(
        await fetchers.delete?.(encodeURIComponent(id)),
        `delete(${name})`,
      );
    };
  return source;
}

/** Resolve a cookbook menu entry over generated REST metadata, including keyed row filters. */
export function createRecipeScreenEntry(
  definitions: Readonly<Record<string, RestDefinition>>,
  entry: { model: string; filter?: { field: string; value: string } | null },
  options: { fetch?: typeof fetch; basePath?: string } = {},
): {
  definition: RestDefinition;
  source: RecipeScreensSource;
} | null {
  const definition = Object.values(definitions).find(
    (candidate) => candidate.objectRef === entry.model,
  );
  if (!definition?.endpoint) return null;
  return {
    definition,
    source: createRecipeScreensSource(
      definition,
      createDefinitionFetchers(
        {
          name: definition.name ?? definition.className,
          endpoint: definition.endpoint,
        },
        options.basePath ?? '/api',
        options.fetch,
      ),
      { allPages: true, ...(entry.filter ? { filter: entry.filter } : {}) },
    ),
  };
}

/** Build once for an app's exposed definitions, then pass the map to RecipeScreens.references. */
export function createRecipeScreenReferences(
  definitions: Readonly<Record<string, RestDefinition>>,
  options: {
    basePath?: string;
    fetch?: typeof fetch;
    hrefFor?: (
      definition: ScreenCollectionDefinition,
      id: string,
    ) => string | undefined;
  } = {},
): ScreenReferenceSources {
  return Object.fromEntries(
    Object.entries(definitions).flatMap(([name, definition]) => {
      if (!definition.endpoint || !definition.actions?.includes('list'))
        return [];
      const source = createRecipeScreensSource(
        definition,
        createDefinitionFetchers(
          { name, endpoint: definition.endpoint },
          options.basePath ?? '/api',
          options.fetch,
        ),
      );
      return [
        [
          name,
          {
            definition,
            source,
            ...(options.hrefFor
              ? { href: (id: string) => options.hrefFor?.(definition, id) }
              : {}),
          },
        ],
      ];
    }),
  );
}
