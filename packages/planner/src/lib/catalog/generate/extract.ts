import type { Recipe } from '../../recipes/types.ts';
import type {
  CatalogField,
  CatalogFieldUI,
  CatalogFieldWidget,
  CatalogMethod,
  CatalogModel,
  CatalogOperation,
  CatalogPackage,
  CatalogRoute,
} from '../types.ts';
import { PACKAGE_PREFIX } from './exclusions.ts';
import { extractBrowser, extractRecipeMetadata } from './recipe-metadata.ts';

/** The subset of a s-m-r-t `manifest.json` the catalog reads. */
export interface RawManifest {
  packageName: string;
  smrtDependencies?: string[];
  objects: Record<string, RawObject>;
  /** Recipes the package declares (`SmrtRecipe`, smrt#3590/#3604). */
  recipes?: unknown;
  /** Whether the package builds for a browser (smrt#3709). */
  browser?: unknown;
}

interface RawParameter {
  name: string;
  type: string;
  optional?: boolean;
}

interface RawMethod {
  name: string;
  async?: boolean;
  parameters?: RawParameter[];
  returnType?: string;
  isStatic?: boolean;
  isPublic?: boolean;
}

interface RawField {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
  related?: string;
  enum?: unknown;
  _meta?: { ui?: unknown; description?: unknown; [key: string]: unknown };
}

interface RawObject {
  className: string;
  qualifiedName: string;
  collection: string;
  extends?: string;
  extendsTypeArg?: string;
  /** The class's doc description (emitted by newer scanners only). */
  description?: string;
  /** The own field that labels a record in pickers (smrt#3611). */
  displayLabelField?: string;
  fields: Record<string, RawField>;
  methods: Record<string, RawMethod>;
  decoratorConfig: Record<string, unknown>;
}

/** The subset of a `smrt-knowledge.json` the catalog reads. */
export interface RawKnowledge {
  surfaces?: RawSurface[];
  /** Recipes the package declares; also in the manifest. */
  recipes?: unknown;
  /** Browser capability; also in the manifest. */
  browser?: unknown;
}

interface RawSurface {
  kind: 'api' | 'mcp' | 'cli' | (string & {});
  name: string;
  operation: string;
  objectName: string;
  path?: string;
  method?: string;
}

export interface RawPackage {
  packageName: string;
  version: string;
  description: string;
  manifest: RawManifest;
  knowledge: RawKnowledge | null;
}

/** Fields the framework manages; shown in the catalog, hidden from forms. */
const SYSTEM_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  'tenantId',
]);

/** Field types that hold other rows, not a value a form can edit. */
const NON_VALUE_TYPES = new Set(['oneToMany', 'meta']);

const CRUD_VERBS = ['list', 'get', 'create', 'update', 'delete'] as const;

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/** `@happyvertical/smrt-products` -> `products`. */
export function packageId(packageName: string): string {
  return packageName.startsWith(PACKAGE_PREFIX)
    ? packageName.slice(PACKAGE_PREFIX.length)
    : packageName;
}

function primitiveDefault(value: unknown): CatalogField['default'] | undefined {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
    ? value
    : undefined;
}

const WIDGETS = new Set<string>([
  'textarea',
  'currency',
  'email',
  'url',
  'phone',
]);

/** Keep only the known `ui` keys, with their expected primitive types. */
function extractUi(value: unknown): CatalogFieldUI | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const ui: CatalogFieldUI = {
    ...(typeof raw.basic === 'boolean' ? { basic: raw.basic } : {}),
    ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order)
      ? { order: raw.order }
      : {}),
    ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
    ...(typeof raw.widget === 'string' && WIDGETS.has(raw.widget)
      ? { widget: raw.widget as CatalogFieldWidget }
      : {}),
  };
  return Object.keys(ui).length > 0 ? ui : undefined;
}

function extractEnum(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

function extractFields(raw: RawObject): CatalogField[] {
  const fields: CatalogField[] = [];
  for (const [name, field] of Object.entries(raw.fields)) {
    if (NON_VALUE_TYPES.has(field.type)) continue;
    const entry: CatalogField = {
      name,
      type: field.type,
      required: field.required === true,
    };
    const fallback = primitiveDefault(field.default);
    if (fallback !== undefined) entry.default = fallback;
    if (field.related) entry.related = field.related;
    const values = extractEnum(field.enum);
    if (values) entry.enum = values;
    const ui = extractUi(field._meta?.ui);
    if (ui) entry.ui = ui;
    const described = field.description ?? field._meta?.description;
    if (typeof described === 'string' && described.trim()) {
      entry.description = described.trim();
    }
    if (SYSTEM_FIELDS.has(name)) entry.system = true;
    fields.push(entry);
  }
  return fields;
}

/**
 * The surfaces a model gets when the knowledge artifact is absent: derived
 * from `decoratorConfig` the way the generators do (an omitted `api`/`mcp`/
 * `cli` key means full CRUD; `false` means none; `include` narrows it).
 */
function derivedVerbs(config: unknown): readonly string[] {
  if (config === false) return [];
  if (config && typeof config === 'object') {
    const { include, exclude } = config as {
      include?: string[];
      exclude?: string[];
    };
    const base = include ?? [...CRUD_VERBS];
    return base.filter((verb) => !exclude?.includes(verb));
  }
  return [...CRUD_VERBS];
}

const REST_VERB: Record<string, CatalogRoute | undefined> = {
  list: { method: 'GET', path: '' },
  get: { method: 'GET', path: '/[id]' },
  create: { method: 'POST', path: '' },
  update: { method: 'PATCH', path: '/[id]' },
  delete: { method: 'DELETE', path: '/[id]' },
};

function derivedSurfaces(raw: RawObject): RawSurface[] {
  const lower = raw.className.toLowerCase();
  const surfaces: RawSurface[] = [];
  const add = (kind: string, config: unknown) => {
    for (const verb of derivedVerbs(config)) {
      const route = REST_VERB[verb];
      if (kind === 'api' && !route) continue;
      surfaces.push({
        kind,
        name: kind === 'api' ? `${raw.collection}.${verb}` : `${lower}_${verb}`,
        operation: verb,
        objectName: raw.qualifiedName,
        ...(kind === 'api' && route
          ? { method: route.method, path: `/${raw.collection}${route.path}` }
          : {}),
      });
    }
  };
  add('api', raw.decoratorConfig.api);
  add('mcp', raw.decoratorConfig.mcp);
  add('cli', raw.decoratorConfig.cli);
  return surfaces;
}

/** Collection classes carry the custom actions; they belong to their model. */
function ownerName(raw: RawObject): string {
  return raw.extendsTypeArg ?? raw.className.replace(/Collection$/, '');
}

function isModel(raw: RawObject): boolean {
  return Object.values(raw.fields).some((f) => !NON_VALUE_TYPES.has(f.type));
}

function qualify(
  related: string,
  packageName: string,
  models: Map<string, RawObject>,
): string {
  if (related.includes(':')) return related;
  const local = `${packageName}:${related}`;
  return models.has(local) ? local : related;
}

const RECIPE_METADATA_KEYS = [
  'surfaces',
  'providers',
  'runtime',
  'demoSeed',
  'demo',
] as const;

/**
 * The recipes a package declares, in declaration order, from its knowledge
 * artifact (else its manifest). Dropped when they are not an array of
 * objects with a string `id`. `className` is a source detail, not catalog data.
 * The non-model parts (surfaces, providers, runtime, demo seed, demo) are
 * validated by `recipe-metadata.ts` and carried as authored.
 */
function extractRecipes(raw: RawPackage): Recipe[] {
  const found = raw.knowledge?.recipes ?? raw.manifest.recipes;
  if (!Array.isArray(found)) return [];
  return found
    .filter(
      (r): r is Record<string, unknown> =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as { id?: unknown }).id === 'string',
    )
    .map((entry) => {
      const { className: _className, ...recipe } = entry;
      for (const key of RECIPE_METADATA_KEYS) delete recipe[key];
      return {
        ...recipe,
        ...extractRecipeMetadata(entry),
      } as unknown as Recipe;
    });
}

/** Turn one package's raw manifest and knowledge into a catalog entry. */
export function extractPackage(raw: RawPackage): CatalogPackage {
  const { manifest, knowledge, packageName } = raw;
  const recipes = extractRecipes(raw);
  const browser = extractBrowser(knowledge?.browser ?? manifest.browser);
  const objects = Object.values(manifest.objects);
  const rawModels = objects.filter(isModel);
  const modelMap = new Map(rawModels.map((m) => [m.qualifiedName, m]));
  const collections = objects.filter((o) => !isModel(o));
  const knowledgeSurfaces = knowledge?.surfaces ?? null;

  const models: CatalogModel[] = rawModels.map((model) => {
    const owned = [
      model,
      ...collections.filter((c) => ownerName(c) === model.className),
    ];
    const ownedNames = new Set(owned.map((o) => o.qualifiedName));
    const surfaces = knowledgeSurfaces
      ? knowledgeSurfaces.filter((s) => ownedNames.has(s.objectName))
      : derivedSurfaces(model);
    const seen = new Set<string>();
    const unique = surfaces.filter((s) => {
      const key = `${s.kind}:${s.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const rest: CatalogRoute[] = unique
      .filter((s) => s.kind === 'api' && s.path && s.method)
      .map((s) => ({ method: s.method as string, path: s.path as string }));
    const operations = (kind: string): CatalogOperation[] =>
      unique
        .filter((s) => s.kind === kind)
        .map((s) => ({ operation: s.operation, name: s.name }))
        .sort(byName);
    const mcp = operations('mcp');
    const cli = operations('cli');
    const mcpOps = new Set(mcp.map((t) => t.operation));

    const methods: CatalogMethod[] = owned
      .flatMap((o) => Object.values(o.methods))
      .filter((m) => m.isPublic !== false && !m.isStatic)
      .filter((m, i, all) => all.findIndex((x) => x.name === m.name) === i)
      .map((m) => ({
        name: m.name,
        async: m.async === true,
        parameters: (m.parameters ?? []).map(
          (p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`,
        ),
        returnType: m.returnType ?? 'unknown',
        aiCallable: mcpOps.has(m.name),
      }))
      .sort(byName);

    const fields = extractFields(model);
    const references = [
      ...new Set(
        fields
          .filter(
            (f) =>
              f.related && ['foreignKey', 'crossPackageRef'].includes(f.type),
          )
          .map((f) => qualify(f.related as string, packageName, modelMap)),
      ),
    ].sort();
    for (const field of fields) {
      if (field.related) {
        field.related = qualify(field.related, packageName, modelMap);
      }
    }

    return {
      id: model.qualifiedName,
      name: model.className,
      collection: model.collection,
      ...(model.extends && modelMap.has(`${packageName}:${model.extends}`)
        ? { extends: `${packageName}:${model.extends}` }
        : {}),
      ...(model.description?.trim()
        ? { description: model.description.trim() }
        : {}),
      ...(model.displayLabelField &&
      fields.some((f) => f.name === model.displayLabelField)
        ? { display: { label: model.displayLabelField } }
        : {}),
      fields,
      rest,
      mcp,
      cli,
      methods,
      references,
      exposed: rest.length + mcp.length + cli.length > 0,
    };
  });
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    id: packageId(packageName),
    packageName,
    version: raw.version,
    description: raw.description,
    models,
    dependencies: (manifest.smrtDependencies ?? []).map(packageId).sort(),
    surfaceSource: knowledgeSurfaces ? 'knowledge' : 'manifest',
    ...(browser ? { browser } : {}),
    ...(recipes.length > 0 ? { recipes } : {}),
  };
}

/**
 * Resolve each package's dependencies: the other catalog packages named in its
 * manifest's `smrtDependencies` or pointed at by its models' foreign keys and
 * cross-package references. Packages outside the catalog (excluded
 * infrastructure) are not dependencies.
 */
export function resolveDependencies(
  packages: CatalogPackage[],
): CatalogPackage[] {
  const ids = new Set(packages.map((p) => p.id));
  return packages.map((pkg) => {
    const deps = new Set<string>(pkg.dependencies.filter((id) => ids.has(id)));
    for (const model of pkg.models) {
      for (const ref of model.references) {
        const colon = ref.indexOf(':');
        if (colon < 0) continue;
        const id = packageId(ref.slice(0, colon));
        if (ids.has(id)) deps.add(id);
      }
    }
    deps.delete(pkg.id);
    return { ...pkg, dependencies: [...deps].sort() };
  });
}
