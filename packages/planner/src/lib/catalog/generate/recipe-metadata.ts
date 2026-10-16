import type {
  PackageBrowserCapability,
  Recipe,
  RecipeDemo,
  RecipeDemoMode,
  RecipeDemoSeed,
  RecipeExportRef,
  RecipeProvider,
  RecipeRuntime,
  RecipeSurface,
} from '../../recipes/types.ts';

/**
 * The non-model parts of a recipe entry (smrt#3708 surfaces, providers,
 * runtime, demo seed; smrt#3709 `demo` and the package's `browser`), read from
 * the manifest or knowledge artifact. Each is checked against the shape the
 * Features catalogue renders and dropped when malformed, so a manifest from a
 * newer or older smrt never reaches the UI half-typed. Values are copied as
 * authored: nothing here derives, mocks or rewrites what smrt emitted.
 */

const DEMO_MODES: readonly RecipeDemoMode[] = [
  'live',
  'mock',
  'sample',
  'server',
];
const RUNTIMES: readonly RecipeRuntime[] = ['browser', 'server', 'both'];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
}

const isExportRef = (value: unknown): value is RecipeExportRef =>
  isString(value) && value.includes('#') && !value.startsWith('#');

/** A surface of a kind the catalogue knows, else undefined (dropped). */
function surface(raw: unknown): RecipeSurface | undefined {
  if (!isObject(raw)) return undefined;
  const { kind } = raw;
  if (!isExportRef(raw.export)) return undefined;
  const icon = isString(raw.icon) ? { icon: raw.icon } : {};
  switch (kind) {
    case 'shell-widget':
      return isString(raw.slot) && isString(raw.label)
        ? {
            kind,
            slot: raw.slot,
            export: raw.export,
            label: raw.label,
            ...icon,
          }
        : undefined;
    case 'route':
      return isString(raw.path) && isString(raw.label)
        ? { kind, path: raw.path, export: raw.export, label: raw.label }
        : undefined;
    case 'settings-panel':
      return isString(raw.label)
        ? { kind, export: raw.export, label: raw.label }
        : undefined;
    case 'playground':
      return {
        kind,
        export: raw.export,
        ...(isString(raw.label) ? { label: raw.label } : {}),
      };
    case 'widget':
      return isString(raw.type) && isString(raw.label)
        ? ({ ...raw } as RecipeSurface)
        : undefined;
    default:
      return undefined;
  }
}

function provider(raw: unknown): RecipeProvider | undefined {
  if (!isObject(raw) || !isString(raw.id) || !isString(raw.kind)) {
    return undefined;
  }
  const options = strings(raw.options);
  if (!options || typeof raw.required !== 'boolean') return undefined;
  const secrets = strings(raw.secrets);
  const browserOptions = strings(raw.browserOptions);
  return {
    id: raw.id,
    kind: raw.kind,
    options,
    required: raw.required,
    ...(secrets?.length ? { secrets } : {}),
    ...(browserOptions?.length ? { browserOptions } : {}),
  };
}

function demoSeed(raw: unknown): RecipeDemoSeed | undefined {
  if (!isObject(raw)) return undefined;
  if (isExportRef(raw.export)) return { export: raw.export };
  return 'data' in raw ? { data: raw.data } : undefined;
}

/** A recipe's `demo`; absent when the mode is not one of the four. */
export function extractDemo(raw: unknown): RecipeDemo | undefined {
  if (!isObject(raw)) return undefined;
  const mode = DEMO_MODES.find((m) => m === raw.mode);
  const reasons = strings(raw.reasons);
  if (!mode || !reasons) return undefined;
  const mocked = strings(raw.mocked);
  return { mode, reasons, ...(mocked?.length ? { mocked } : {}) };
}

/**
 * The package-level `browser` capability, or undefined when the artifact has
 * none (an unmeasured package, or a smrt that predates smrt#3709).
 */
export function extractBrowser(
  raw: unknown,
): PackageBrowserCapability | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status !== 'browser-safe' && raw.status !== 'server-only') {
    return undefined;
  }
  const issues = strings(raw.issues);
  const via = strings(raw.via);
  return {
    status: raw.status,
    ...(issues?.length ? { issues } : {}),
    ...(isString(raw.reason) ? { reason: raw.reason } : {}),
    ...(via?.length ? { via } : {}),
  };
}

/** The validated non-model metadata of one raw recipe entry. */
export function extractRecipeMetadata(
  raw: Json,
): Pick<Recipe, 'surfaces' | 'providers' | 'runtime' | 'demoSeed' | 'demo'> {
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.flatMap((s) => surface(s) ?? [])
    : [];
  const providers = Array.isArray(raw.providers)
    ? raw.providers.flatMap((p) => provider(p) ?? [])
    : [];
  const runtime = RUNTIMES.find((r) => r === raw.runtime);
  const seed = demoSeed(raw.demoSeed);
  const demo = extractDemo(raw.demo);
  return {
    ...(surfaces.length ? { surfaces } : {}),
    ...(providers.length ? { providers } : {}),
    ...(runtime ? { runtime } : {}),
    ...(seed ? { demoSeed: seed } : {}),
    ...(demo ? { demo } : {}),
  };
}
