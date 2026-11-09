/**
 * A small, conservative reader for the one thing the bundler needs from
 * `pnpm-lock.yaml`: which packages do NOT resolve to a registry tarball with
 * an integrity hash.
 *
 * It is not a YAML parser. It understands the layout pnpm writes (a top-level
 * `packages:` section, entries indented by two spaces, a `resolution:` mapping
 * indented by four, in flow `{...}` or block form) and treats anything it
 * cannot place as "not registry", which fails closed. Package names are
 * returned, never URLs: a tarball URL can carry credentials.
 *
 * The orchestrator intersects the result with the packages that were really
 * installed, so a git-resolved development dependency does not block a
 * production bundle.
 */

const NON_REGISTRY_KEY =
  /(?:^|[\s,{])(?:tarball|directory|repo|commit|type|path)\s*:/;
const INTEGRITY_KEY = /(?:^|[\s,{])integrity\s*:\s*\S/;

function packageName(key: string): string {
  const at = key.indexOf('@', 1);
  return at === -1 ? key : key.slice(0, at);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith("'") || trimmed.startsWith('"')) &&
    trimmed.endsWith(trimmed[0] as string)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Names of packages in the lockfile's `packages:` section whose resolution is
 * not a plain registry integrity entry (tarball URL, git, directory, or no
 * integrity at all). Sorted, unique.
 */
export function findNonRegistryLockfilePackages(lockfile: string): string[] {
  const lines = lockfile.split(/\r?\n/);
  const names = new Set<string>();

  let inPackages = false;
  let current: string | undefined;
  let resolution: string[] | undefined;
  let resolutionIndent = 0;

  const flush = (): void => {
    if (current !== undefined) {
      const body = (resolution ?? []).join(' ');
      const registry =
        resolution !== undefined &&
        INTEGRITY_KEY.test(body) &&
        !NON_REGISTRY_KEY.test(body);
      if (!registry) names.add(packageName(current));
    }
    current = undefined;
    resolution = undefined;
  };

  for (const line of lines) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      flush();
      inPackages = /^packages\s*:\s*$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    if (indent === 2) {
      flush();
      const match = /^\s{2}(.+?):\s*$/.exec(line);
      if (match?.[1] !== undefined) current = unquote(match[1]);
      resolution = undefined;
      continue;
    }
    if (current === undefined) continue;
    if (indent === 4 && /^\s{4}resolution\s*:/.test(line)) {
      resolution = [line.replace(/^\s{4}resolution\s*:/, '').trim()];
      resolutionIndent = indent;
      continue;
    }
    if (resolution !== undefined && indent > resolutionIndent) {
      // Block-form mapping under `resolution:`.
      if (indent >= 6 && resolution.length > 0) resolution.push(line.trim());
      continue;
    }
    if (indent === 4) resolutionIndent = Number.MAX_SAFE_INTEGER;
  }
  flush();
  return [...names].sort();
}
