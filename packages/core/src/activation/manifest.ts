/** AOT activation graph. Importing this module never imports model constructors. */
import { byCodeUnit, findCycle, topologicalOrder } from './topo.js';

export interface ActivationModule {
  /** Portable import specifier; evaluated only by the corresponding loader. */
  specifier: string;
  models: string[];
  /** Non-table collection receivers/metadata that this module may register. */
  collections?: string[];
  dependencies: string[];
  /**
   * Modules whose registrations must run before this one's when both are in
   * the closure (collection receivers bound to one effective item). Optional:
   * a graph without it loads in sorted order.
   */
  after?: string[];
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
      /**
       * Manifest key of the model this one extends, when that is not a
       * framework base. The parent registers before this model. Optional: a
       * graph without it loads in sorted order.
       */
      parent?: string;
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
    for (const earlier of module.after ?? [])
      if (!graph.modules[earlier])
        throw new Error(`Unknown activation module: ${earlier}`);
    module.models.forEach(visitModel);
    module.dependencies.forEach(visitModule);
  };
  const visitModel = (id: string) => {
    if (models.has(id)) return;
    const model = graph.models[id];
    if (!model) throw new Error(`Unknown activation model: ${id}`);
    if (model.parent !== undefined && typeof model.parent !== 'string')
      throw new Error(`Invalid activation parent for ${id}`);
    // Generation always lists a model's parent among its dependencies. A
    // parent outside them is not the class this model extends (a stale or
    // hand-edited graph), so nothing is imported or migrated for it.
    if (
      model.parent !== undefined &&
      graph.models[model.parent] &&
      !model.dependencies.includes(model.parent)
    )
      throw new Error(
        `Invalid activation parent for ${id}: ${model.parent} is not among its dependencies (${model.dependencies.join(', ') || 'none'}), so it is not the class ${id} extends. Regenerate the activation manifest.`,
      );
    models.add(id);
    if (model.parent !== undefined) visitModel(model.parent);
    visitModule(model.module);
    visitModel(model.effective);
    model.dependencies.forEach(visitModel);
    if (model.table) visitTable(model.table);
  };
  for (const id of requested) visitModel(id);
  for (const id of models) assertAcyclicParents(graph, id);
  return {
    models: [...models].sort(byCodeUnit),
    modules: orderModules(graph, modules, models),
    tables: [...tables].sort(byCodeUnit),
  };
}

function assertAcyclicParents(graph: ActivationManifest, start: string) {
  const path: string[] = [];
  const seen = new Set<string>();
  for (
    let next: string | undefined = start;
    next !== undefined;
    next = graph.models[next]?.parent
  ) {
    if (seen.has(next))
      throw new Error(
        `Activation order is impossible: ${[...path.slice(path.indexOf(next)), next].join(' extends ')} is a cycle; a class cannot be its own ancestor`,
      );
    seen.add(next);
    path.push(next);
  }
}

/** A class of the same simple name as its parent: the registry refuses it child-first. */
export function isSameNamePair(child: string, parent: string): boolean {
  return (
    child.slice(child.lastIndexOf(':') + 1) ===
    parent.slice(parent.lastIndexOf(':') + 1)
  );
}

export interface ModuleEdge {
  from: string;
  to: string;
  /** The registry refuses the opposite order (a same-named pair, or competing collection bindings). */
  hard: boolean;
  /** Derived from a model's `parent`, not from a module's `after`. */
  parent?: true;
  because: string;
}

/** Order constraints between the modules in `modules`, derived from the persisted graph. */
export function moduleEdges(
  graph: ActivationManifest,
  modules: ReadonlySet<string>,
  models: Iterable<string>,
): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  for (const id of models) {
    const parent = graph.models[id]?.parent;
    if (parent === undefined) continue;
    const from = graph.models[parent]?.module;
    const to = graph.models[id].module;
    if (from && from !== to && modules.has(from) && modules.has(to))
      edges.push({
        from,
        to,
        hard: isSameNamePair(id, parent),
        parent: true,
        because: `${parent} (in ${from}) is the parent of ${id} (in ${to})`,
      });
  }
  for (const id of modules)
    for (const earlier of graph.modules[id]?.after ?? [])
      if (modules.has(earlier))
        edges.push({
          from: earlier,
          to: id,
          hard: true,
          because: `${earlier} must register its collection bindings before ${id}`,
        });
  return edges;
}

/**
 * Modules in registration order: a module follows every module that hosts a
 * parent of one of its models. A cycle that only plain subclass edges form
 * does not refuse anything at run time, so it falls back to the edges the
 * registry does enforce.
 */
export function orderModules(
  graph: ActivationManifest,
  modules: ReadonlySet<string>,
  models: Iterable<string>,
): string[] {
  const edges = moduleEdges(graph, modules, models);
  const pair = (edge: ModuleEdge) => [edge.from, edge.to] as const;
  let { order, remaining } = topologicalOrder(modules, edges.map(pair));
  if (remaining.length) {
    const hard = edges.filter((edge) => edge.hard);
    ({ order, remaining } = topologicalOrder(modules, hard.map(pair)));
    if (remaining.length) throw new Error(describeModuleCycle(remaining, hard));
  }
  return order;
}

/** The error for a module cycle made of edges the registry enforces. */
export function describeModuleCycle(
  remaining: readonly string[],
  edges: readonly ModuleEdge[],
): string {
  const cycle = findCycle(
    remaining,
    edges.map((edge) => [edge.from, edge.to] as const),
  );
  const forcing = cycle.map((module, index) => {
    const next = cycle[(index + 1) % cycle.length];
    return edges.find((edge) => edge.from === module && edge.to === next)
      ?.because;
  });
  return `Activation order is impossible: modules ${cycle.join(' and ')} each need the other to register first (${forcing.filter(Boolean).join('; ')}). Move one of these classes into a module of its own and regenerate.`;
}
