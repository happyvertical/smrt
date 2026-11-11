import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';
import { moduleRunnerTransformSync, transformSync } from 'oxc-transform';
import { modelReplacements } from '../manifest/model-replacements.js';
import { isFrameworkBaseClass } from '../registry/framework-base-classes.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  findManifestObjectByName,
  isCollectionManifestClass,
  resolveCollectionItemObject,
} from '../vite-plugin/web-collections.js';

import {
  type ActivationManifest,
  type ActivationModule,
  activationClosure,
} from './manifest.js';

/** Build from the complete, generated manifest, never from the live registry. */
export function buildActivationManifest(
  manifest: SmartObjectManifest,
  modules: Record<string, ActivationModule>,
): ActivationManifest {
  const graph: ActivationManifest = {
    version: 1,
    modules: Object.fromEntries(
      Object.entries(modules).map(([id, module]) => [
        id,
        {
          ...module,
          models: [...module.models],
          dependencies: [...module.dependencies],
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
      const parent = object.extendsQualified ?? object.extends;
      const dependencies: string[] = [];
      if (
        parent &&
        !isFrameworkBaseClass(
          parent.split(':').at(-1),
          parent.includes(':')
            ? parent.split(':')[0]
            : '@happyvertical/smrt-core',
        )
      ) {
        let resolved = parent.includes(':')
          ? parent
          : `${object.packageName}:${parent}`;
        if (!parent.includes(':') && !manifest.objects[resolved]) {
          const candidates = Object.entries(manifest.objects).filter(
            ([, entry]) => entry.className === parent,
          );
          if (
            candidates.length === 1 &&
            findManifestObjectByName(manifest, parent, object) ===
              candidates[0][1]
          )
            resolved = candidates[0][0];
        }
        if (
          !isFrameworkBaseClass(
            resolved.split(':').at(-1),
            resolved.split(':')[0],
          )
        )
          dependencies.push(resolved);
      }
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
  // Validate the entire graph now, so an unknown edge cannot become a partial
  // import/migration at runtime. Also validates all replacement targets.
  activationClosure(graph, Object.keys(graph.models));
  return graph;
}

/**
 * Generate portable, deferred registration from a complete build manifest.
 * Static import/export edges are parsed, never evaluated. Package barrels are
 * conservative activation units: all their declared modules are included.
 */
export function generateActivationRegistration(
  manifest: SmartObjectManifest,
  options: {
    projectRoot: string;
    outputDir: string;
    collectionMetadata?: readonly string[];
  },
): { manifest: ActivationManifest; source: string } {
  const modules: Record<string, ActivationModule> = {};
  const entries = new Map<string, string[]>();
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
  for (const [id, module] of Object.entries(modules)) {
    const dependencies = new Set<string>();
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
      for (const owner of sourceOwners.get(file) ?? []) dependencies.add(owner);
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
  const objectKeys = new Map(
    Object.entries(manifest.objects).map(([id, object]) => [object, id]),
  );
  for (const [id, object] of Object.entries(manifest.objects)) {
    if (!isCollectionManifestClass(manifest, object)) continue;
    const item = resolveCollectionItemObject(manifest, object);
    const itemId = item ? objectKeys.get(item) : undefined;
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
  const loaders = [...entries].map(([module, ids]) => {
    const registrations = ids.map((id) => {
      const object = manifest.objects[id];
      const name = object.exportName ?? object.className;
      if (isCollectionManifestClass(manifest, object)) {
        const item = resolveCollectionItemObject(manifest, object);
        const itemId = item ? objectKeys.get(item) : undefined;
        const effective = itemId ? graph.models[itemId]?.effective : undefined;
        return `${options.collectionMetadata?.includes(id) ? `ObjectRegistry.registerPackageManifest({ ...declarations, packageName: ${JSON.stringify(object.packageName)}, objects: { [${JSON.stringify(id)}]: declarations.objects[${JSON.stringify(id)}] } });` : ''}
if (Reflect.get(provider, String(${JSON.stringify(name)}))) {
  ObjectRegistry.registerCollection(${JSON.stringify(id)}, Reflect.get(provider, String(${JSON.stringify(name)})));
  ${effective ? `ObjectRegistry.registerCollection(${JSON.stringify(effective)}, Reflect.get(provider, String(${JSON.stringify(name)})));` : ''}
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
  ${registrations.join('\n')}
}`;
  });
  return {
    manifest: graph,
    source: `// Generated SMRT activation: declarations and deferred imports only.\nimport { ObjectRegistry } from '@happyvertical/smrt-core';\nexport const activationManifest = JSON.parse(${JSON.stringify(JSON.stringify(graph))});\nconst declarations = JSON.parse(${JSON.stringify(JSON.stringify(portable))});\nexport const activationLoaders = {\n${loaders.join(',\n')}\n};\n`,
  };
}
