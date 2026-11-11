/** Adapts the existing generated REST fetchers to the screens' transport-neutral source. */
import {
  createDefinitionFetchers,
  type SmrtCrudFetchers,
  SmrtWebRequestError,
  throwIfSmrtWebError,
  unwrapItemResult,
  unwrapListResult,
} from '@happyvertical/smrt-web';
import type {
  RecipeScreensSource,
  ScreenCollectionDefinition,
  ScreenReferenceSources,
} from './types.js';

export function createRecipeScreensSource(
  definition: ScreenCollectionDefinition,
  fetchers: Pick<SmrtCrudFetchers, 'list'> & Partial<SmrtCrudFetchers>,
): RecipeScreensSource {
  const name = definition.name ?? definition.objectRef;
  const allowed = (action: string) =>
    definition.actions?.includes(action) === true;
  const source: RecipeScreensSource = {
    list: async () => unwrapListResult(await fetchers.list(), name),
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
        return unwrapItemResult(
          await fetchers.get?.(encodeURIComponent(id)),
          `get(${name})`,
        );
      } catch (error) {
        if (error instanceof SmrtWebRequestError && error.status === 404)
          return undefined;
        throw error;
      }
    };
  }
  if (fetchers.create && allowed('create'))
    source.create = async (values) =>
      unwrapItemResult(await fetchers.create?.(values), `create(${name})`);
  if (fetchers.update && allowed('update'))
    source.update = async (id, values) =>
      unwrapItemResult(
        await fetchers.update?.(encodeURIComponent(id), values),
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

/** Build once for an app's exposed definitions, then pass the map to RecipeScreens.references. */
export function createRecipeScreenReferences(
  definitions: Readonly<Record<string, ScreenCollectionDefinition>>,
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
