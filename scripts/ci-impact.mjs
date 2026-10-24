#!/usr/bin/env node
/** Conservative selection ledger only: never executes tasks or authorizes reuse. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WORKSPACE_HEADER = `packages:
  - 'packages/*'
  - 'packages/smrt-playground/host'
  - 'packages/smrt-workbench/host'

`;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const METADATA_FIELDS = new Set(['description', 'author', 'license']);
const HARNESS_ROOTS = new Set([
  'packages/core',
  'packages/scanner',
  'packages/vitest',
]);
const SUITES = ['test', 'test:postgres'];
const packageManifest = /^packages\/[^/]+\/package\.json$|^packages\/smrt-(?:playground|workbench)\/host\/package\.json$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = (path) => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..') && !/[\x00-\x1f\\]/.test(path);

/** Validate the explicitly supported repository layout, rather than parse YAML. */
export function workspacePackages(snapshot) {
  if (!object(snapshot) || !Array.isArray(snapshot.files) || !snapshot.files.every(validPath) || !object(snapshot.manifests)) {
    throw new Error('Malformed tree snapshot');
  }
  if (typeof snapshot.workspaceConfig !== 'string' || (!snapshot.workspaceConfig.startsWith(WORKSPACE_HEADER) || [...snapshot.workspaceConfig.matchAll(/^["']?packages["']?:/gm)].length !== 1)) {
    throw new Error('Unknown workspace layout');
  }
  const packages = new Map();
  for (const path of snapshot.files.filter((path) => packageManifest.test(path))) {
    const manifest = snapshot.manifests[path];
    if (!object(manifest) || typeof manifest.name !== 'string' || !manifest.name || packages.has(manifest.name)) {
      throw new Error(`Invalid or duplicate workspace manifest: ${path}`);
    }
    if (manifest.scripts !== undefined && (!object(manifest.scripts) || !Object.values(manifest.scripts).every((script) => typeof script === 'string'))) {
      throw new Error(`Invalid scripts: ${path}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      if (manifest[field] !== undefined && (!object(manifest[field]) || !Object.values(manifest[field]).every((range) => typeof range === 'string'))) {
        throw new Error(`Invalid ${field}: ${path}`);
      }
    }
    packages.set(manifest.name, { name: manifest.name, root: path.slice(0, -13), manifest });
  }
  if (!packages.size) throw new Error('Empty workspace inventory');
  for (const pkg of packages.values()) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
        if (/^(?:file:|link:)/.test(range)) throw new Error(`Unmodelled local dependency: ${name}`);
        if (range.startsWith('workspace:') && !packages.has(name)) throw new Error(`Unknown workspace dependency: ${name}`);
      }
    }
  }
  return packages;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function metadataOnly(before, after) {
  if (!object(before) || !object(after)) return false;
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.every((field) => METADATA_FIELDS.has(field) || JSON.stringify(stable(before[field])) === JSON.stringify(stable(after[field])));
}

/** Parse git --name-status -z, preserving both sides of renames and deletions. */
export function parseChanges(text) {
  const tokens = text.split('\0');
  if (tokens.pop() !== '') throw new Error('Unterminated git diff');
  const changes = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    if (!/^(?:[AMDT]|[RC]\d+)$/.test(status)) throw new Error(`Unknown diff status: ${status}`);
    const paths = tokens.slice(i, i + (/^[RC]/.test(status) ? 2 : 1));
    i += paths.length;
    if (paths.length !== (/^[RC]/.test(status) ? 2 : 1) || !paths.every(validPath)) throw new Error('Malformed diff path');
    changes.push({ status, paths });
  }
  return changes;
}

/** Inputs must describe trusted exact base/head trees. Any uncertainty selects full. */
export function planImpact({ base, head, baseSnapshot, headSnapshot, changes, error } = {}) {
  const reasons = [];
  let before = new Map();
  let after = new Map();
  let inventoryComplete = false;
  let full = false;
  const fallback = (reason) => { full = true; reasons.push(reason); };
  try {
    after = workspacePackages(headSnapshot);
    inventoryComplete = true;
    before = workspacePackages(baseSnapshot);
    if (error) throw new Error(error);
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Missing exact commit identity');
    if (!Array.isArray(changes) || !changes.every((change) => object(change) && /^(?:[AMDT]|[RC]\d+)$/.test(change.status) && Array.isArray(change.paths) && change.paths.length === (/^[RC]/.test(change.status) ? 2 : 1) && change.paths.every(validPath))) throw new Error('Malformed changed-file inventory');
  } catch (cause) {
    fallback(cause.message);
  }
  const affected = new Map();
  const select = (name, reason) => {
    if (!affected.has(name)) affected.set(name, new Set());
    affected.get(name).add(reason);
  };
  // Union both graphs: deleting an edge must not drop a former consumer.
  const reverse = new Map();
  for (const graph of [before, after]) {
    for (const pkg of graph.values()) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const dependency of Object.keys(pkg.manifest[field] ?? {})) {
          if (!graph.has(dependency)) continue;
          if (!reverse.has(dependency)) reverse.set(dependency, new Set());
          reverse.get(dependency).add(pkg.name);
        }
      }
    }
  }
  if (!full) {
    const owners = [...before.values(), ...after.values()].sort((a, b) => b.root.length - a.root.length);
    for (const change of changes) {
      for (const path of change.paths) {
        if (!baseSnapshot.files.includes(path) && !headSnapshot.files.includes(path)) {
          fallback(`Path absent from both trees: ${path}`);
          continue;
        }
        const owner = owners.find((pkg) => path.startsWith(`${pkg.root}/`));
        if (!owner) {
          fallback(`Global or unowned input: ${path}`);
          continue;
        }
        const relative = path.slice(owner.root.length + 1);
        if (relative === 'package.json' && change.status === 'M' && metadataOnly(baseSnapshot.manifests[path], headSnapshot.manifests[path])) {
          reasons.push(`Publication metadata only: ${path}`);
          continue;
        }
        if (HARNESS_ROOTS.has(owner.root)) {
          fallback(`Implicit shared generator/test-harness input: ${path}`);
        }
        for (const identity of owners.filter((pkg) => pkg.root === owner.root)) {
          select(identity.name, `Changed input: ${path}`);
        }
      }
    }
  }
  // Fixed-point traversal handles dependency cycles and deleted packages.
  const queue = [...affected.keys()];
  for (let index = 0; index < queue.length; index++) {
    for (const consumer of reverse.get(queue[index]) ?? []) {
      if (!affected.has(consumer)) queue.push(consumer);
      select(consumer, `Depends on affected package: ${queue[index]}`);
    }
  }
  if (full) for (const name of after.keys()) select(name, 'Full fallback');
  const packages = [...after.values()].sort((a, b) => a.name.localeCompare(b.name)).map((pkg) => ({
    name: pkg.name,
    root: pkg.root,
    selected: affected.has(pkg.name),
    reasons: [...(affected.get(pkg.name) ?? [])].sort(),
  }));
  const suites = Object.fromEntries(SUITES.map((suite) => [suite, packages.filter((pkg) => pkg.selected && after.get(pkg.name).manifest.scripts?.[suite]).map(({ name, reasons }) => ({ name, reasons }))]));
  return { schemaVersion: 1, base: base ?? null, head: head ?? null, full, inventoryComplete, knowledge: true, packaging: true, reasons: [...new Set(reasons)].sort(), packages, suites };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function readSnapshot(cwd, commit) {
  if (git(cwd, 'cat-file', '-t', commit).trim() !== 'commit') throw new Error('Identity is not a commit');
  const files = git(cwd, 'ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(Boolean);
  const workspaceConfig = git(cwd, 'show', `${commit}:pnpm-workspace.yaml`);
  const manifests = Object.fromEntries(files.filter((path) => packageManifest.test(path)).map((path) => [path, JSON.parse(git(cwd, 'show', `${commit}:${path}`))]));
  return { files, workspaceConfig, manifests };
}

export function planFromGit({ cwd = process.cwd(), base, head }) {
  let baseSnapshot;
  let headSnapshot;
  try {
    // Full SHAs prevent ref drift and option injection; callers supply exact event SHAs.
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Expected exact base/head commit SHAs');
    headSnapshot = readSnapshot(cwd, head);
    baseSnapshot = readSnapshot(cwd, base);
    const changes = parseChanges(git(cwd, 'diff', '--name-status', '-z', '--find-renames', base, head, '--'));
    return planImpact({ base, head, baseSnapshot, headSnapshot, changes });
  } catch (cause) {
    return planImpact({ base, head, baseSnapshot, headSnapshot, error: cause.message });
  }
}

function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    if (!['--base', '--head', '--output'].includes(key) || !process.argv[index + 1] || options[key]) throw new Error('Usage: ci-impact.mjs --base <sha> --head <sha> [--output <file>]');
    options[key] = process.argv[index + 1];
  }
  const plan = planFromGit({ base: options['--base'], head: options['--head'] });
  const output = `${JSON.stringify(plan, null, 2)}\n`;
  if (options['--output']) writeFileSync(options['--output'], output);
  process.stdout.write(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
