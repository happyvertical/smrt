import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InferenceConfig } from '../inference/config.ts';
import { validateInferenceConfig } from '../inference/config.ts';
import type { KitchenEndpoint } from '../kitchen/client.ts';
import { parseKitchenConfig } from '../kitchen/client.ts';

/**
 * Absolute path of the root-built prerendered planner app inside this package.
 * Node only; kept out of `./core` so that entry stays free of Node built-ins.
 * Serve it at `/`, or use `materializeApp` for a supported subpath artifact.
 */
export const appDir: string = fileURLToPath(
  new URL('../../app/', import.meta.url),
);

/** Absolute path of one packaged app file, e.g. `appFile('index.html')`. */
export function appFile(relativePath: string): string {
  return fileURLToPath(
    new URL(relativePath, new URL('../../app/', import.meta.url)),
  );
}

export interface PlannerAppConfig {
  inference?: InferenceConfig;
  kitchen?: KitchenEndpoint;
}

export interface MaterializeAppOptions {
  /** New or empty directory that receives the app root. */
  outDir: string;
  /** Canonical mount prefix: leading slash, no trailing slash, e.g. `/plan`. */
  basePath: string;
  /** Written as `planner.config.json` after validation and normalization. */
  config: PlannerAppConfig;
}

export interface MaterializedApp {
  outDir: string;
  configFile: string;
  fallbackFile: string;
}

const sensitiveName =
  /^(?:api[-_]?key|key|token|authorization|secret|password)$/i;

/** Validate and canonicalize a non-root app mount prefix. */
export function normalizeAppBasePath(basePath: string): string {
  if (
    typeof basePath !== 'string' ||
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath) ||
    basePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(
      'basePath must start with /, contain URL-safe path segments, and have no trailing slash',
    );
  }
  return basePath;
}

function assertCredentialFree(value: unknown, path = 'config'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertCredentialFree(entry, `${path}[${index}]`);
    });
    return;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (sensitiveName.test(name)) {
      throw new Error(
        `${path}.${name} is a credential field and cannot be built into the app`,
      );
    }
    assertCredentialFree(entry, `${path}.${name}`);
  }
}

/** Validate config strictly enough for an immutable public artifact. */
export function normalizePlannerAppConfig(
  config: PlannerAppConfig,
): PlannerAppConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be an object');
  }
  const unknown = Object.keys(config).filter(
    (name) => name !== 'inference' && name !== 'kitchen',
  );
  if (unknown.length)
    throw new Error(`unknown app config field: ${unknown[0]}`);
  assertCredentialFree(config);
  const inference = validateInferenceConfig({
    inference: config.inference,
  });
  if (inference.notice) throw new Error(inference.notice);
  let kitchen: KitchenEndpoint | undefined;
  if (config.kitchen !== undefined) {
    kitchen = parseKitchenConfig(config.kitchen);
    if (!kitchen) {
      throw new Error('kitchen.endpoint must be a usable http(s) URL');
    }
  }
  return {
    inference: inference.config,
    ...(kitchen ? { kitchen } : {}),
  };
}

function patchFallback(file: string, basePath: string): void {
  const source = readFileSync(file, 'utf8');
  if (!source.includes('/_app/') || !/base:\s*""/.test(source)) {
    throw new Error(
      'packaged 404.html does not match the supported root fallback',
    );
  }
  const patched = source
    .replaceAll('/_app/', `${basePath}/_app/`)
    .replace(/base:\s*""/, `base: ${JSON.stringify(basePath)}`);
  if (patched.includes('"/_app/') || /base:\s*""/.test(patched)) {
    throw new Error('could not make the fallback prefix-safe');
  }
  writeFileSync(file, patched);
}

/**
 * Copy the published static app into a deterministic, prefix-safe deployment
 * artifact. The copy is assembled beside `outDir` and renamed only after its
 * fallback and config validate, so callers never receive a partial tree.
 */
export function materializeApp(
  options: MaterializeAppOptions,
): MaterializedApp {
  const basePath = normalizeAppBasePath(options.basePath);
  const config = normalizePlannerAppConfig(options.config);
  const outDir = resolve(options.outDir);
  const source = resolve(appDir);
  const relation = relative(source, outDir);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..')) {
    throw new Error('outDir must be outside the packaged app directory');
  }
  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory() || readdirSync(outDir).length > 0) {
      throw new Error('outDir must be new or empty');
    }
  }

  mkdirSync(dirname(outDir), { recursive: true });
  const temporary = mkdtempSync(resolve(dirname(outDir), '.smrt-planner-'));
  try {
    cpSync(source, temporary, { recursive: true });
    patchFallback(resolve(temporary, '404.html'), basePath);
    writeFileSync(
      resolve(temporary, 'planner.config.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    if (existsSync(outDir)) rmdirSync(outDir);
    renameSync(temporary, outDir);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }

  return {
    outDir,
    configFile: resolve(outDir, 'planner.config.json'),
    fallbackFile: resolve(outDir, '404.html'),
  };
}
