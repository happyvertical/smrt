import {
  screenRecordLabel,
  screenReferenceId,
  screenReferenceTarget,
} from './references.js';
import type {
  ScreenCollectionDefinition,
  ScreenField,
  ScreenRecord,
  ScreenReferenceSources,
} from './types.js';

/** Load each visible target once per data snapshot. A changed source/context discards old answers. */
export function useScreenReferenceLabels(
  context: () => {
    definition: ScreenCollectionDefinition;
    fields: readonly ScreenField[];
    rows: readonly ScreenRecord[];
    references: ScreenReferenceSources;
  },
) {
  let names = $state<Record<string, string>>({});
  $effect(() => {
    const { definition, fields, rows, references } = context();
    let disposed = false;
    names = {};
    const requests = new Map<string, { field: ScreenField; id: string }>();
    for (const field of fields) {
      if (field.kind !== 'reference') continue;
      for (const row of rows) {
        const id = screenReferenceId(row[field.name]);
        if (id) requests.set(JSON.stringify([field.name, id]), { field, id });
      }
    }
    // Coalesce repeated IDs across fields targeting the same source as well as across rows.
    const bySource = new Map<
      object,
      Map<string, Promise<string | undefined>>
    >();
    for (const [key, { field, id }] of requests) {
      const target = screenReferenceTarget(definition, field, references);
      if (!target?.source.get) continue;
      let cache = bySource.get(target);
      if (!cache) {
        cache = new Map();
        bySource.set(target, cache);
      }
      let request = cache.get(id);
      if (!request) {
        request = Promise.resolve()
          .then(() => target.source.get?.(id))
          .then((record) =>
            record ? screenRecordLabel(target.definition, record) : undefined,
          )
          .catch(() => undefined);
        cache.set(id, request);
      }
      void request.then((name) => {
        if (!disposed && name) names = { ...names, [key]: name };
      });
    }
    return () => {
      disposed = true;
    };
  });
  return {
    label: (field: ScreenField, id: string) =>
      names[JSON.stringify([field.name, id])],
  };
}
