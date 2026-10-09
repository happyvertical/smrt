/**
 * Node filesystem access for manifest discovery, resolved lazily (#2838).
 *
 * Manifest discovery reads the filesystem, which only exists on a Node host.
 * The built-ins come from `process.getBuiltinModule()` (see
 * `getNodeBuiltins`) instead of static `node:` imports, so a browser bundle
 * of the registry never reaches them. Without a Node host there is nothing
 * to discover: the probes answer "absent" (`existsSync` false, `readdirSync`
 * empty, `join`/`dirname` plain string math) and the operations that cannot
 * answer (`readFileSync`, `statSync`, `require`) throw, which every caller
 * already treats as "no manifest here". Discovery then falls back to what
 * decorators and `registerPackageManifest()` supplied.
 */

import type { SmartObjectManifest } from '../scanner/types.js';
import { getNodeBuiltins } from './store.js';

type NodeHost = NonNullable<ReturnType<typeof getNodeBuiltins>>;

let cachedNodeHost: NodeHost | undefined;

export function nodeHost(): NodeHost | null {
  if (cachedNodeHost) return cachedNodeHost;
  const host = getNodeBuiltins();
  if (host) cachedNodeHost = host;
  return host;
}

function requireNodeHost(operation: string): NodeHost {
  const host = nodeHost();
  if (!host) {
    throw new Error(
      `[manifest-loader] ${operation} needs a Node host; no filesystem is available here`,
    );
  }
  return host;
}

export function existsSync(path: string): boolean {
  return nodeHost()?.fs.existsSync(path) ?? false;
}

export function readdirSync(path: string): string[] {
  return nodeHost()?.fs.readdirSync(path) ?? [];
}

export function readFileSync(path: string, encoding: 'utf-8'): string {
  return requireNodeHost('readFileSync').fs.readFileSync(path, encoding);
}

export function statSync(path: string): { mtimeMs: number } {
  return requireNodeHost('statSync').fs.statSync(path);
}

/**
 * Path joining for locations that are probed with `existsSync`. Without a Node
 * host the result is only ever looked up in a filesystem that answers
 * "absent", so a plain `/`-separated join is enough.
 */
export function join(...segments: string[]): string {
  const host = nodeHost();
  if (host) return host.path.join(...segments);
  return segments
    .filter((segment) => segment !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function dirname(path: string): string {
  const host = nodeHost();
  if (host) return host.path.dirname(path);
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return '.';
  return cut === 0 ? '/' : trimmed.slice(0, cut);
}

/** CommonJS `require` for the static and test manifest stubs; Node hosts only. */
export function require(specifier: string): {
  staticManifest?: SmartObjectManifest;
  testManifest?: SmartObjectManifest;
  default?: SmartObjectManifest;
} {
  const host = requireNodeHost('require');
  return host.module.createRequire(import.meta.url)(specifier);
}
