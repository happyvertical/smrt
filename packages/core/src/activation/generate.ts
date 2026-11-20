import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';
import {
  assertSameNameSubclassChoices,
  modelReplacements,
} from '../manifest/model-replacements.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  findManifestObjectByName,
  isCollectionManifestClass,
  resolveCollectionItemObject,
  resolveCollectionItemTypeName,
} from '../vite-plugin/web-collections.js';

import {
  type ActivationManifest,
  type ActivationModule,
  activationClosure,
  describeModuleCycle,
  isSameNamePair,
  type ModuleEdge,
  moduleEdges,
} from './manifest.js';
import { byCodeUnit, findCycle, topologicalOrder } from './topo.js';

type Objects = SmartObjectManifest['objects'];

/** The manifest with its objects in key order, so nothing downstream follows listing order. */
function sortedManifest(manifest: SmartObjectManifest): SmartObjectManifest {
  const keys = Object.keys(manifest.objects);
  if (keys.every((key, index) => index === 0 || keys[index - 1] <= key))
    return manifest;
  return {
    ...manifest,
    objects: Object.fromEntries(
      keys.sort(byCodeUnit).map((key) => [key, manifest.objects[key]]),
    ) as Objects,
  };
}

const QUALIFIED = /^[^\s:]+:[^\s:]+$/;
const FRAMEWORK_CORE = '@happyvertical/smrt-core';

function parentField(
  id: string,
  object: SmartObjectDefinition,
  field: 'extends' | 'extendsQualified',
): string | undefined {
  const value = (object as unknown as Record<string, unknown>)[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim())
    throw new Error(
      `${id} declares an invalid ${field}: expected a non-blank string, received ${JSON.stringify(value)}`,
    );
  return value;
}

interface ResolvedParent {
  /** Manifest key of the non-framework parent. */
  parent?: string;
  /** The declared parent that names no manifest object (an error for a model). */
  missing?: string;
  declared?: string;
}

/**
 * Resolve every object's parent from the raw declaration, before anything is
 * classified as a collection or framework class, and refuse a declaration that
 * does not say what it names. Only an absent field means "no parent".
 */
function resolveParents(manifest: SmartObjectManifest) {
  const resolved = new Map<string, ResolvedParent>();
  for (const [id, object] of Object.entries(manifest.objects)) {
    const colon = id.lastIndexOf(':');
    if (colon > 0 && object.packageName !== undefined) {
      if (id.slice(0, colon) !== object.packageName)
        throw new Error(
          `Activation manifest key ${id} disagrees with its declared packageName ${object.packageName}`,
        );
    }
    if (object.qualifiedName !== undefined && object.qualifiedName !== id)
      throw new Error(
        `Activation manifest key ${id} disagrees with its declared qualifiedName ${object.qualifiedName}`,
      );
  }
  for (const [id, object] of Object.entries(manifest.objects)) {
    if (isFrameworkBaseClass(object.className, object.packageName)) continue;
    const extendsName = parentField(id, object, 'extends');
    const qualified = parentField(id, object, 'extendsQualified');
    if (qualified !== undefined && !QUALIFIED.test(qualified))
      throw new Error(
        `${id} declares an invalid extendsQualified: ${JSON.stringify(qualified)} is not a package-qualified class name`,
      );
    // A qualified `extends` is held to the same form before anything below
    // reads a package or class out of it (a framework base included).
    if (extendsName?.includes(':') && !QUALIFIED.test(extendsName))
      throw new Error(
        `${id} declares an invalid extends: ${JSON.stringify(extendsName)} is not a package-qualified class name`,
      );
    if (
      extendsName?.includes(':') &&
      qualified !== undefined &&
      extendsName !== qualified
    )
      throw new Error(
        `${id} declares extends ${extendsName} but extendsQualified ${qualified}; the two disagree`,
      );
    const declared = qualified ?? extendsName;
    if (declared === undefined) continue;
    const simple = declared.slice(declared.lastIndexOf(':') + 1);
    if (declared.includes(':')) {
      if (declared === id)
        throw new Error(
          `${id} extends itself (extendsQualified names its own key)`,
        );
      if (isFrameworkBaseClass(simple, declared.split(':')[0])) continue;
      resolved.set(
        id,
        manifest.objects[declared]
          ? { parent: declared, declared }
          : { missing: declared, declared },
      );
      continue;
    }
    const local = `${object.packageName}:${declared}`;
    // An unqualified name that resolves to the class itself means the parent
    // is not in the manifest (the same-named parent was never verified): no edge.
    if (local === id) continue;
    if (manifest.objects[local]) {
      resolved.set(id, { parent: local, declared });
      continue;
    }
    if (isFrameworkBaseClass(declared, FRAMEWORK_CORE)) continue;
    const candidates = Object.entries(manifest.objects).filter(
      ([, entry]) => entry.className === declared,
    );
    if (candidates.length > 1)
      throw new Error(
        `${id} extends ${declared}, which names ${candidates.length} classes in the activation manifest (${candidates.map(([key]) => key).join(', ')}); declare the parent's package so the extends is qualified`,
      );
    if (
      candidates.length === 1 &&
      findManifestObjectByName(manifest, declared, object) === candidates[0][1]
    ) {
      const [key, entry] = candidates[0];
      if (!isFrameworkBaseClass(entry.className, entry.packageName))
        resolved.set(id, { parent: key, declared });
      continue;
    }
    resolved.set(id, { missing: local, declared });
  }
  return resolved;
}

interface OrderEdge {
  from: string;
  to: string;
  kind: 'parent' | 'item' | 'binding';
}

/**
 * One deterministic registration order over every activation object, from the
 * resolved parents and the collection bindings (never from listing order):
 * a parent before its children; an item and its effective replacement before
 * its collection; of two collections bound to one effective item, the one of
 * the more derived item last, because the later binding wins.
 */
function activationPlan(manifest: SmartObjectManifest) {
  const resolved = resolveParents(manifest);
  // The registry refuses an undeclared or impossible same-named subclass at
  // boot; refuse it here first, so no artifact is published that cannot boot.
  assertSameNameSubclassChoices(manifest);
  const replacements = modelReplacements(manifest);
  const keys = new Map(
    Object.entries(manifest.objects).map(([id, object]) => [object, id]),
  );
  const nodes: string[] = [];
  const collections = new Set<string>();
  for (const [id, object] of Object.entries(manifest.objects)) {
    if (isFrameworkBaseClass(object.className, object.packageName)) continue;
    nodes.push(id);
    if (isCollectionManifestClass(manifest, object)) collections.add(id);
  }
  const parentOf = new Map<string, string>();
  for (const id of nodes) {
    const parent = resolved.get(id)?.parent;
    if (parent && !collections.has(id) && !collections.has(parent))
      parentOf.set(id, parent);
  }
  const edges: OrderEdge[] = [];
  for (const [child, parent] of parentOf)
    edges.push({ from: parent, to: child, kind: 'parent' });
  const itemOf = new Map<string, string>();
  const effectiveOf = (item: string) => replacements.get(item) ?? item;
  for (const id of collections) {
    const collection = manifest.objects[id];
    // A qualified item declaration names its manifest key exactly; the public
    // index omits a replaced declaration, so prefer the key over name lookup.
    const declared = collection.collectionOf ?? collection.extendsTypeArg;
    const item = resolveCollectionItemObject(manifest, collection);
    let itemId =
      typeof declared === 'string' && manifest.objects[declared]
        ? declared
        : item
          ? keys.get(item)
          : undefined;
    // A simple item name names a class of the collection's own package. The
    // public index omits that class once it is replaced, so resolve the name
    // against the raw inventory: the collection still binds to its item and,
    // through it, to the effective replacement.
    if (!itemId) {
      const named = resolveCollectionItemTypeName(manifest, collection);
      if (named && manifest.objects[named]) itemId = named;
    }
    if (!itemId || collections.has(itemId)) continue;
    itemOf.set(id, itemId);
    for (const model of new Set([itemId, effectiveOf(itemId)]))
      if (manifest.objects[model])
        edges.push({ from: model, to: id, kind: 'item' });
  }
  const depth = (id: string) => {
    let count = 0;
    for (let next = parentOf.get(id); next; next = parentOf.get(next)) {
      count += 1;
      if (count > nodes.length) break;
    }
    return count;
  };
  const bound = new Map<string, string[]>();
  for (const [collection, item] of itemOf) {
    const group = bound.get(effectiveOf(item)) ?? [];
    group.push(collection);
    bound.set(effectiveOf(item), group);
  }
  for (const group of bound.values()) {
    group.sort(
      (a, b) =>
        depth(itemOf.get(a)!) - depth(itemOf.get(b)!) || byCodeUnit(a, b),
    );
    for (let index = 1; index < group.length; index += 1)
      edges.push({ from: group[index - 1], to: group[index], kind: 'binding' });
  }
  const pairs = edges.map((edge) => [edge.from, edge.to] as const);
  const { order, remaining } = topologicalOrder(nodes, pairs);
  if (remaining.length) {
    const cycle = findCycle(remaining, pairs);
    throw new Error(
      `Activation order is impossible: ${[...cycle, cycle[0]].join(' -> ')} forms a cycle (each must register before the next); a class cannot extend itself through its ancestors`,
    );
  }
  return {
    resolved,
    order,
    index: new Map(order.map((id, position) => [id, position])),
    parentOf,
    collections,
    itemOf,
    edges,
    effectiveOf,
  };
}

/** Build from the complete, generated manifest, never from the live registry. */
export function buildActivationManifest(
  input: SmartObjectManifest,
  modules: Record<string, ActivationModule>,
): ActivationManifest {
  const manifest = sortedManifest(input);
  const plan = activationPlan(manifest);
  const graph: ActivationManifest = {
    version: 1,
    modules: Object.fromEntries(
      Object.entries(modules)
        .sort(([a], [b]) => byCodeUnit(a, b))
        .map(([id, module]) => [
          id,
          {
            ...module,
            models: [...module.models].sort(byCodeUnit),
            ...(module.collections
              ? { collections: [...module.collections].sort(byCodeUnit) }
              : {}),
            dependencies: [...module.dependencies].sort(byCodeUnit),
            ...(module.after?.length
              ? { after: [...module.after].sort(byCodeUnit) }
              : {}),
          },
        ]),
    ),
    models: {},
    tables: {},
  };
  const replacements = modelReplacements(manifest);
  for (const [module, entry] of Object.entries(graph.modules)) {
    entry.models = entry.models.filter((id) => {
      const object = manifest.objects[id];
      return (
        !object ||
        (!isCollectionManifestClass(manifest, object) &&
          !isFrameworkBaseClass(object.className, object.packageName))
      );
    });
    for (const id of entry.models) {
      const object = manifest.objects[id];
      if (!object) throw new Error(`Unknown activation model: ${id}`);
      if (graph.models[id])
        throw new Error(`Duplicate activation owner: ${id}`);
      if (isCollectionManifestClass(manifest, object)) continue;
      const table = object.schema?.tableName;
      const dependencies: string[] = [];
      const resolution = plan.resolved.get(id);
      if (resolution?.missing)
        throw new Error(
          `${id} extends ${resolution.declared}, which is not in the activation manifest; include ${resolution.missing}'s package manifest (or correct the extends declaration) and regenerate`,
        );
      const parent = plan.parentOf.get(id);
      if (parent) dependencies.push(parent);
      // Logical references (including cross-package refs) need constructors even
      // when the schema deliberately omits a physical FK constraint.
      for (const field of Object.values(object.fields)) {
        if (field.type !== 'foreignKey' && field.type !== 'crossPackageRef')
          continue;
        if (!field.related) continue;
        let target = field.related.includes(':')
          ? field.related
          : `${object.packageName}:${field.related}`;
        if (
          !manifest.objects[target] &&
          target.lastIndexOf('.') > target.lastIndexOf(':')
        )
          target = target.slice(0, target.lastIndexOf('.'));
        if (!manifest.objects[target] && !field.related.includes(':')) {
          const simple = target.split(':').at(-1)!;
          const candidates = Object.entries(manifest.objects).filter(
            ([, entry]) => entry.className === simple,
          );
          // Legacy inherited fields may retain their declaring package's
          // unqualified target (Image inherits Asset.parentId). Reuse the
          // manifest resolver only when its fallback has one possible identity.
          if (
            candidates.length === 1 &&
            findManifestObjectByName(manifest, simple, object) ===
              candidates[0][1]
          )
            target = candidates[0][0];
        }
        if (manifest.objects[target]) dependencies.push(target);
        else if (
          field.type === 'foreignKey' ||
          field.type === 'crossPackageRef'
        )
          throw new Error(
            `Unresolved activation reference: ${id} -> ${target}`,
          );
      }
      graph.models[id] = {
        module,
        effective: replacements.get(id) ?? id,
        table,
        ...(parent ? { parent } : {}),
        dependencies: [...new Set(dependencies)].sort(),
      };
      if (table) {
        graph.tables[table] ??= {
          owners: [],
          dependencies: [],
        };
        const owner = graph.tables[table];
        owner.owners.push(id);
        for (const column of Object.values(object.schema?.columns ?? {})) {
          const target = column.foreignKey?.table;
          if (target && target !== table) owner.dependencies.push(target);
        }
      }
    }
  }
  for (const table of Object.values(graph.tables)) {
    table.owners.sort();
    table.dependencies = [...new Set(table.dependencies)].sort();
  }
  recordCollectionOrder(graph, plan);
  // Validate the entire graph now, so an unknown edge cannot become a partial
  // import/migration at runtime. Also validates all replacement targets and
  // that the registry's parent-first rule has an order (modules registering
  // as units can still be asked for a cycle).
  activationClosure(graph, Object.keys(graph.models));
  return graph;
}

/**
 * Persist the cross-module order a module's loader cannot see from parents
 * alone: competing collection bindings (the registry keeps the later one) and
 * a collection after its item. Binding order is enforced; item order is kept
 * only where it leaves the module graph acyclic, since nothing refuses the
 * opposite order. A cycle among the enforced edges fails generation.
 */
function recordCollectionOrder(
  graph: ActivationManifest,
  plan: ReturnType<typeof activationPlan>,
) {
  const moduleOf = new Map<string, string>();
  for (const [id, module] of Object.entries(graph.modules))
    for (const key of [...module.models, ...(module.collections ?? [])])
      moduleOf.set(key, id);
  const all = new Set(Object.keys(graph.modules));
  const hard = moduleEdges(graph, all, Object.keys(graph.models)).filter(
    (edge) => edge.hard,
  );
  const soft: ModuleEdge[] = [];
  for (const edge of plan.edges) {
    if (edge.kind === 'parent') continue;
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (!from || !to || from === to) continue;
    (edge.kind === 'binding' ? hard : soft).push({
      from,
      to,
      hard: edge.kind === 'binding',
      because: `${edge.from} (in ${from}) is registered before ${edge.to} (in ${to})`,
    });
  }
  const pairs = (edges: readonly ModuleEdge[]) =>
    edges.map((edge) => [edge.from, edge.to] as const);
  const { remaining } = topologicalOrder(all, pairs(hard));
  if (remaining.length) throw new Error(describeModuleCycle(remaining, hard));
  const kept = [...hard];
  for (const edge of soft.sort(
    (a, b) => byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to),
  ))
    if (!topologicalOrder(all, pairs([...kept, edge])).remaining.length)
      kept.push(edge);
  const after = new Map<string, Set<string>>();
  for (const edge of kept) {
    // Parent edges are carried by `models[].parent`; keep only the rest.
    if (edge.parent) continue;
    const set = after.get(edge.to) ?? new Set(graph.modules[edge.to].after);
    set.add(edge.from);
    after.set(edge.to, set);
  }
  for (const [id, set] of after)
    graph.modules[id].after = [...set].sort(byCodeUnit);
}

/**
 * Generate portable, deferred registration from a complete build manifest.
 * Static import/export edges are parsed, never evaluated. Package barrels are
 * conservative activation units: all their declared modules are included.
 */
export function generateActivationRegistration(
  input: SmartObjectManifest,
  options: {
    projectRoot: string;
    outputDir: string;
    collectionMetadata?: readonly string[];
    /** Emit deferred data modules beside the registration; publish `files` too. */
    splitDeclarations?: boolean;
  },
): {
  manifest: ActivationManifest;
  source: string;
  files: Record<string, string>;
} {
  const manifest = sortedManifest(input);
  // Resolve and order first: a malformed or impossible manifest fails before
  // any module is resolved, imported or emitted.
  const plan = activationPlan(manifest);
  let modules: Record<string, ActivationModule> = {};
  const importedOwners = new Map<string, Set<string>>();
  let entries = new Map<string, string[]>();
  const packageModules = new Map<string, Set<string>>();
  const modulePaths = new Map<string, string>();
  const sourceOwners = new Map<string, Set<string>>();
  const packagePath = resolve(options.projectRoot, 'package.json');
  const hostPackageName = existsSync(packagePath)
    ? (JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string }).name
    : manifest.packageName;
  for (const [id, object] of Object.entries(manifest.objects)) {
    if (isFrameworkBaseClass(object.className, object.packageName)) continue;
    const local = object.packageName === hostPackageName;
    const sourcePath =
      local && object.filePath
        ? resolve(options.projectRoot, object.filePath)
        : undefined;
    let specifier = object.importPath ?? object.packageName;
    if (sourcePath) {
      // Author a normal emitted-JavaScript specifier. TypeScript and Vite
      // resolve .js back to the local .ts source without a TS-extension flag.
      const path = relative(options.outputDir, sourcePath)
        .replaceAll('\\', '/')
        .replace(/\.ts$/, '.js');
      specifier = path.startsWith('.') ? path : `./${path}`;
    }
    if (!specifier || (local && !sourcePath))
      throw new Error(`Missing activation import provenance: ${id}`);
    const module = specifier;
    const list = entries.get(module) ?? [];
    list.push(id);
    entries.set(module, list);
    modules[module] ??= {
      specifier,
      models: [],
      collections: [],
      dependencies: [],
    };
    if (isCollectionManifestClass(manifest, object))
      modules[module].collections!.push(id);
    else modules[module].models.push(id);
    const owned = packageModules.get(object.packageName!) ?? new Set();
    owned.add(module);
    packageModules.set(object.packageName!, owned);
    const resolved = resolveSource(
      specifier,
      resolve(options.outputDir, 'register.js'),
    );
    if (
      !local &&
      'providerPackageName' in object &&
      typeof object.providerPackageName === 'string'
    ) {
      const providerEntry = resolveImport(
        object.providerPackageName,
        pathToFileURL(resolve(options.projectRoot, 'package.json')).href,
      );
      if (resolveSource(specifier, fileURLToPath(providerEntry)) !== resolved) {
        throw new Error(
          `Lazy activation requires the same host/provider package context for ${id}; expose a host-resolvable module from ${object.providerPackageName}`,
        );
      }
    }
    modulePaths.set(module, resolved);
    const owners = sourceOwners.get(resolved) ?? new Set();
    owners.add(module);
    sourceOwners.set(resolved, owners);
  }
  const importCache = new Map<string, string[]>();
  function resolveSource(specifier: string, importer: string): string {
    let file: string;
    if (specifier.startsWith('$lib/'))
      file = resolve(options.projectRoot, 'src/lib', specifier.slice(5));
    else {
      const url = resolveImport(specifier, pathToFileURL(importer).href);
      if (!url.startsWith('file:'))
        throw new Error(`Unsupported activation module: ${specifier}`);
      file = fileURLToPath(url);
    }
    const candidates = [
      file,
      file.replace(/\.js$/, '.ts'),
      `${file}.ts`,
      `${file}.js`,
      resolve(file, 'index.ts'),
      resolve(file, 'index.js'),
    ];
    const found = candidates.find(
      (candidate) => existsSync(candidate) && extname(candidate),
    );
    if (!found)
      throw new Error(
        `Cannot resolve activation import ${specifier} from ${importer}`,
      );
    return realpathSync(found);
  }
  function staticImports(file: string): string[] {
    const cached = importCache.get(file);
    if (cached) return cached;
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      if (file.endsWith('.json') || file.endsWith('.node')) return [];
      throw new Error(
        `Activation requires a server model module, received ${file}`,
      );
    }
    // Core's public root also exports the Vite plugin. Resolve native build
    // tooling only while generating activation, never while booting an app.
    const { moduleRunnerTransformSync, transformSync } = createRequire(
      import.meta.url,
    )('oxc-transform') as typeof import('oxc-transform');
    const transformed = transformSync(file, readFileSync(file, 'utf8'), {
      decorator: { legacy: true, emitDecoratorMetadata: true },
    });
    if (transformed.errors.length)
      throw new Error(
        `Cannot parse activation module ${file}: ${transformed.errors[0].message}`,
      );
    const parsed = moduleRunnerTransformSync(
      file.replace(/\.[cm]?tsx?$/, '.js'),
      transformed.code,
    );
    if (parsed.errors.length)
      throw new Error(`Cannot parse activation imports: ${file}`);
    if (file.endsWith('.cjs'))
      throw new Error(`Activation requires ESM model modules: ${file}`);
    importCache.set(file, parsed.deps);
    return parsed.deps;
  }
  const byModule = <T>(map: Map<string, T>) =>
    new Map([...map].sort(([a], [b]) => byCodeUnit(a, b)));
  entries = byModule(entries);
  modules = Object.fromEntries(
    Object.entries(modules).sort(([a], [b]) => byCodeUnit(a, b)),
  );
  for (const [id, module] of Object.entries(modules)) {
    const dependencies = new Set<string>();
    const imported = new Set<string>();
    importedOwners.set(id, imported);
    // A provider can register its whole manifest as a root side effect. Include
    // its complete declared model/module inventory, not just named exports.
    for (const group of packageModules.values()) {
      if (group.has(id) && !id.startsWith('.'))
        for (const peer of group) dependencies.add(peer);
    }
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const owner of sourceOwners.get(file) ?? []) {
        dependencies.add(owner);
        imported.add(owner);
      }
      for (const specifier of staticImports(file)) {
        if (
          specifier === '@happyvertical/smrt-core' ||
          specifier.startsWith('@happyvertical/smrt-core/')
        )
          continue;
        const pkg = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        const group = packageModules.get(pkg);
        if (group) {
          for (const peer of group) dependencies.add(peer);
          // The entry file this specifier names is evaluated by the import.
          try {
            for (const owner of sourceOwners.get(
              resolveSource(specifier, file),
            ) ?? [])
              imported.add(owner);
          } catch {
            // An unresolvable entry is reported where the module is resolved.
          }
          // Each peer's own scan supplies its transitive module edges.
          continue;
        }
        if (
          !specifier.startsWith('.') &&
          !specifier.startsWith('$lib/') &&
          !isAbsolute(specifier)
        )
          continue;
        visit(resolveSource(specifier, file));
      }
    };
    visit(modulePaths.get(id)!);
    // Route serializers are deferred too, but their model dependencies must
    // already be in the activation closure when a ready route calls them.
    for (const model of entries.get(id) ?? []) {
      const api = manifest.objects[model].decoratorConfig?.api;
      if (!api || typeof api !== 'object') continue;
      for (const serializer of [
        api.serializers?.item,
        api.serializers?.listItem,
      ]) {
        if (serializer)
          visit(
            resolveSource(
              serializer.importPath,
              resolve(options.outputDir, 'register.js'),
            ),
          );
      }
    }
    dependencies.delete(id);
    module.dependencies = [...dependencies].sort();
    module.models.sort();
  }
  const moduleByObject = new Map(
    [...entries].flatMap(([module, ids]) =>
      ids.map((id) => [id, module] as const),
    ),
  );
  // Importing a module evaluates every module it imports, and a decorated
  // class registers when its file is evaluated. So a module that imports
  // the host of a same-named child must load after the module that hosts that
  // child's parent; when it hosts the parent itself, no order can help.
  for (const [importer, owners] of importedOwners) {
    const earlier = new Set<string>();
    for (const owner of owners) {
      if (owner === importer) continue;
      for (const child of entries.get(owner) ?? []) {
        const parent = plan.parentOf.get(child);
        if (!parent || !isSameNamePair(child, parent)) continue;
        const home = moduleByObject.get(parent);
        if (!home || home === owner) continue;
        if (home === importer)
          throw new Error(
            `Activation order is impossible: module ${importer} imports ${owner}, which hosts ${child}, but ${importer} also hosts its parent ${parent}; ${child} would register before ${parent}. Stop importing ${owner} from ${importer}, or move ${parent} into a module of its own.`,
          );
        earlier.add(home);
      }
    }
    if (earlier.size)
      modules[importer].after = [
        ...new Set([...(modules[importer].after ?? []), ...earlier]),
      ].sort(byCodeUnit);
  }
  for (const [id, object] of Object.entries(manifest.objects)) {
    if (!isCollectionManifestClass(manifest, object)) continue;
    const itemId = plan.itemOf.get(id);
    const itemModule = itemId ? moduleByObject.get(itemId) : undefined;
    const collectionModule = moduleByObject.get(id);
    if (itemModule && collectionModule && itemModule !== collectionModule) {
      modules[itemModule].dependencies = [
        ...new Set([...modules[itemModule].dependencies, collectionModule]),
      ].sort();
    }
  }
  const graph = buildActivationManifest(manifest, modules);
  const portable = {
    ...manifest,
    // Runtime registration consumes object metadata; the host loads its recipe
    // catalog separately. Never duplicate that documentation per activation unit.
    recipes: undefined,
    // Per-module copies never carry the build's stamp: startup reads it from the
    // build schema module the registration imports first (#4929).
    schemaFingerprint: undefined,
    objects: Object.fromEntries(
      Object.entries(manifest.objects).map(([id, object]) => [
        id,
        { ...object, filePath: undefined },
      ]),
    ),
  };
  // Keep this output valid JavaScript and strict TypeScript. Export keys are
  // manifest data: String() keeps Reflect.get dynamic under TS 6's literal-key
  // overload, so optional exports and models with specialized constructor
  // options are checked at the existing runtime registration boundary.
  const files: Record<string, string> = {};
  const loaders = [...entries].map(([module, unordered]) => {
    // Registration order follows the plan, never the manifest's listing order.
    const ids = [...unordered].sort(
      (a, b) => (plan.index.get(a) ?? 0) - (plan.index.get(b) ?? 0),
    );
    const data = JSON.stringify({
      ...portable,
      objects: Object.fromEntries(ids.map((id) => [id, portable.objects[id]])),
    });
    const parse = `JSON.parse(${JSON.stringify(data)})`;
    let declaration = `const declarations = ${parse};`;
    if (options.splitDeclarations) {
      const stem = `.smrt/activation/${createHash('sha256').update(module).digest('hex')}`;
      files[`${stem}.js`] = `export default ${parse};\n`;
      files[`${stem}.d.ts`] =
        'declare const declarations: import("@happyvertical/smrt-core").SmartObjectManifest;\nexport default declarations;\n';
      declaration = `const { default: declarations } = await import(${JSON.stringify(`./${stem}.js`)});`;
    }
    const registrations = ids.map((id) => {
      const object = manifest.objects[id];
      const name = object.exportName ?? object.className;
      if (isCollectionManifestClass(manifest, object)) {
        const itemId = plan.itemOf.get(id);
        const effective = itemId ? graph.models[itemId]?.effective : undefined;
        // Bind the item's own key as well as its effective replacement's: a
        // collection that registers before the replacement does is otherwise
        // reachable only once the replacement exists, and a lookup by the
        // item's key in between would install a default collection.
        const bindings = [
          ...new Set(
            [itemId !== effective ? itemId : undefined, effective].filter(
              (key): key is string => !!key && !!graph.models[key],
            ),
          ),
        ];
        return `${options.collectionMetadata?.includes(id) ? `ObjectRegistry.registerPackageManifest({ ...declarations, packageName: ${JSON.stringify(object.packageName)}, objects: { [${JSON.stringify(id)}]: declarations.objects[${JSON.stringify(id)}] } });` : ''}
if (Reflect.get(provider, String(${JSON.stringify(name)}))) {
  ObjectRegistry.registerCollection(${JSON.stringify(id)}, Reflect.get(provider, String(${JSON.stringify(name)})));
  ${bindings.map((key) => `ObjectRegistry.registerCollection(${JSON.stringify(key)}, Reflect.get(provider, String(${JSON.stringify(name)})));`).join('\n  ')}
}`;
      }
      return `{
  const constructor = Reflect.get(provider, String(${JSON.stringify(name)}));
  if (typeof constructor !== 'function') throw new Error(${JSON.stringify(`Activation export missing: ${id}`)});
  ObjectRegistry.register(constructor, { name: ${JSON.stringify(object.className)}, packageName: ${JSON.stringify(object.packageName)}, _manifest: { ...declarations, packageName: ${JSON.stringify(object.packageName)}, objects: { [${JSON.stringify(id)}]: declarations.objects[${JSON.stringify(id)}] } }, _manifestKey: ${JSON.stringify(id)} });
  ${object.collectionExportName ? `if (Reflect.get(provider, String(${JSON.stringify(object.collectionExportName)}))) ObjectRegistry.registerCollection(${JSON.stringify(id)}, Reflect.get(provider, String(${JSON.stringify(object.collectionExportName)})));` : ''}
}`;
    });
    return `${JSON.stringify(module)}: async () => {
  const provider = await import(${JSON.stringify(module)});
  ${declaration}
  ${registrations.join('\n')}
}`;
  });
  return {
    manifest: graph,
    files,
    source: `// Generated SMRT activation: declarations and deferred imports only.\nimport { ObjectRegistry } from '@happyvertical/smrt-core';\nexport const activationManifest = JSON.parse(${JSON.stringify(JSON.stringify(graph))});\nexport const activationLoaders = {\n${loaders.join(',\n')}\n};\n`,
  };
}
