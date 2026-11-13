/** AOT activation graph. Importing this module never imports model constructors. */
export interface ActivationModule {
  /** Portable import specifier; evaluated only by the corresponding loader. */
  specifier: string;
  models: string[];
  /** Non-table collection receivers/metadata that this module may register. */
  collections?: string[];
  dependencies: string[];
}

export interface ActivationManifest {
  version: 1;
  modules: Record<string, ActivationModule>;
  models: Record<
    string,
    {
      module: string;
      effective: string;
      table?: string;
      dependencies: string[];
    }
  >;
  tables: Record<string, { owners: string[]; dependencies: string[] }>;
}

/** Module side effects, effective replacements and ALL table owners form one closure. */
export function activationClosure(
  graph: ActivationManifest,
  requested: Iterable<string>,
) {
  if (graph.version !== 1)
    throw new Error('Unsupported SMRT activation manifest');
  const models = new Set<string>();
  const modules = new Set<string>();
  const tables = new Set<string>();
  const visitTable = (name: string) => {
    if (tables.has(name)) return;
    const table = graph.tables[name];
    if (!table) throw new Error(`Unknown activation table: ${name}`);
    tables.add(name);
    table.owners.forEach(visitModel);
    table.dependencies.forEach(visitTable);
  };
  const visitModule = (id: string) => {
    if (modules.has(id)) return;
    const module = graph.modules[id];
    if (!module) throw new Error(`Unknown activation module: ${id}`);
    modules.add(id);
    module.models.forEach(visitModel);
    module.dependencies.forEach(visitModule);
  };
  const visitModel = (id: string) => {
    if (models.has(id)) return;
    const model = graph.models[id];
    if (!model) throw new Error(`Unknown activation model: ${id}`);
    models.add(id);
    visitModule(model.module);
    visitModel(model.effective);
    model.dependencies.forEach(visitModel);
    if (model.table) visitTable(model.table);
  };
  for (const id of requested) visitModel(id);
  return {
    models: [...models].sort(),
    modules: [...modules].sort(),
    tables: [...tables].sort(),
  };
}
