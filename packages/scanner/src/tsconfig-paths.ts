/**
 * Path aliases a project declares in its TypeScript configuration
 * (`compilerOptions.paths`, following `extends`), read at build time.
 *
 * The module resolver reads them so a path alias (`@app/models/Event`,
 * `$lib/...`) names the one file of this project TypeScript would load, and
 * is never taken for an installed package of the same name. Only declared
 * mappings count: an alias defined only in a bundler config cannot be read
 * here, so an import through it does not resolve.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface PathMapping {
  pattern: string;
  /** Absolute target patterns, `*` kept where the pattern has one. */
  targets: string[];
}

const MAX_EXTENDS_DEPTH = 8;

/** JSON with comments and trailing commas, as TypeScript reads it. */
function parseConfigText(text: string): Record<string, unknown> | null {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === '*' && text[index + 1] === '/')
      )
        index++;
      index++;
    } else {
      out += char;
    }
  }
  try {
    const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readMappings(
  file: string,
  depth: number,
): { mappings: PathMapping[] | null } {
  if (depth > MAX_EXTENDS_DEPTH || !existsSync(file)) return { mappings: null };
  const config = parseConfigText(readFileSync(file, 'utf8'));
  if (!config) return { mappings: null };
  const dir = dirname(file);
  const options = (config.compilerOptions ?? {}) as Record<string, unknown>;
  const paths = options.paths as Record<string, unknown> | undefined;
  if (paths && typeof paths === 'object') {
    const base =
      typeof options.baseUrl === 'string' ? resolve(dir, options.baseUrl) : dir;
    return {
      mappings: Object.entries(paths).map(([pattern, targets]) => ({
        pattern,
        targets: (Array.isArray(targets) ? targets : [])
          .filter((target): target is string => typeof target === 'string')
          .map((target) => resolve(base, target)),
      })),
    };
  }
  // `paths` is inherited whole from the nearest config that declares it.
  const parents = Array.isArray(config.extends)
    ? config.extends
    : config.extends
      ? [config.extends]
      : [];
  for (const parent of [...parents].reverse()) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    const target = resolve(dir, parent);
    const candidate = target.endsWith('.json') ? target : `${target}.json`;
    const inherited = readMappings(candidate, depth + 1);
    if (inherited.mappings) return inherited;
  }
  return { mappings: null };
}

/**
 * The files a specifier may name through `<root>/tsconfig.json`
 * `compilerOptions.paths`, without extension, in the order TypeScript tries
 * them; `null` when no pattern matches the specifier. Of several matching
 * patterns, an exact one wins, else the one with the longest prefix before
 * its `*`, as TypeScript chooses.
 */
export function pathAliasCandidates(
  root: string,
  specifier: string,
): string[] | null {
  const { mappings } = readMappings(join(root, 'tsconfig.json'), 0);
  let best: { mapping: PathMapping; captured: string; rank: number } | null =
    null;
  for (const mapping of mappings ?? []) {
    const star = mapping.pattern.indexOf('*');
    if (star < 0) {
      if (mapping.pattern === specifier) {
        best = { mapping, captured: '', rank: Number.POSITIVE_INFINITY };
      }
      continue;
    }
    const prefix = mapping.pattern.slice(0, star);
    const suffix = mapping.pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (!best || prefix.length > best.rank)
    ) {
      best = {
        mapping,
        captured: specifier.slice(
          prefix.length,
          specifier.length - suffix.length,
        ),
        rank: prefix.length,
      };
    }
  }
  if (!best) return null;
  return best.mapping.targets.map((target) =>
    target.replace('*', best.captured),
  );
}
