/**
 * One package's served surface, in a fresh process (see served-surface.mjs).
 *
 * Input: a job file naming the package P, the built core and CLI generator
 * entries, and the manifests of P's smrtDependencies closure (dependencies
 * first, P last). The worker registers them with the public
 * `ObjectRegistry.registerPackageManifest`, asserts that nothing outside the
 * closure got registered, and writes the inventory of P's keys and of every
 * dependency key, as served under P.
 *
 * Every decision comes from the code the transports run: MCP from the tools
 * `MCPGenerator.generateTools()` emits (their emitted names included), CLI
 * from `CLIGenerator.listCommands()` (command names and aliases included),
 * REST from the route emitter's own resolvers through served-surface-rest.mjs,
 * which the cross-check test shares. The tenant-context guard is not
 * modelled.
 *
 * A surface this worker cannot attribute is an error, never a silent skip: a
 * key with no registration, an MCP tool without a model identity that is not
 * a cookbook tool, a CLI command that is neither an object command with an
 * owner nor a utility or built-in command, a tool or command whose owner no
 * inventoried registration is, and any resolver that throws. Tools and
 * commands are recorded as address -> operation pairs.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { restSurface } from './served-surface-rest.mjs';

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const errors = [];
const finish = (result) => {
  writeFileSync(job.outFile, JSON.stringify({ errors, ...result }));
  process.exit(0);
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const coreDist = (relative) =>
  pathToFileURL(path.join(job.coreDist ?? path.dirname(job.corePath), relative)).href;

let core;
let cli;
let rest;
let cookbookToolNames;
try {
  core = await import(pathToFileURL(job.corePath).href);
  cli = await import(pathToFileURL(job.cliPath).href);
  const web = await import(coreDist('vite-plugin/web-collections.js'));
  const policy = await import(coreDist('vite-plugin/route-policy.js'));
  const cookbook = await import(coreDist('cookbook/index.js'));
  rest = {
    exposedCrudVerbs: core.exposedCrudVerbs,
    resolveOperationPermissionAlias: core.resolveOperationPermissionAlias,
    resolveApiCustomActions: web.resolveApiCustomActions,
    resolveApiActionRouteConfig: web.resolveApiActionRouteConfig,
    resolveCollectionItemObject: web.resolveCollectionItemObject,
    resolvePermissionCollection: policy.resolvePermissionCollection,
  };
  cookbookToolNames = new Set(cookbook.COOKBOOK_TOOL_NAMES);
  for (const [name, fn] of Object.entries(rest))
    if (typeof fn !== 'function') throw new Error(`resolver ${name} not found in the built core`);
} catch (error) {
  errors.push(`${job.packageName}: cannot load built core or CLI: ${error.message}`);
  finish({});
}
const { ObjectRegistry, MCPGenerator, isFrameworkBaseClass } = core;

const manifests = job.manifests.map((m) => ({
  ...m,
  manifest: readJson(m.manifestPath),
}));
const own = manifests.find((m) => m.packageName === job.packageName);
for (const { packageName, manifest } of manifests) {
  const result = ObjectRegistry.registerPackageManifest(manifest);
  if (result && result.loaded === false)
    errors.push(`${job.packageName}: could not register ${packageName}: ${JSON.stringify(result)}`);
}
for (const file of job.extraManifests) {
  ObjectRegistry.registerPackageManifest(readJson(file));
}

// The registry must hold P and its closure only: anything else (an installed
// STI sibling found through the manifest cache, for example) would make this
// file describe a composition no deployment of P has.
const allowed = new Set(manifests.map((m) => m.packageName));
for (const [key, info] of ObjectRegistry.getAllClasses()) {
  if (info.packageName && !allowed.has(info.packageName))
    errors.push(`${job.packageName}: out-of-profile registration ${info.qualifiedName ?? key}`);
}

const allObjects = {};
for (const { manifest } of manifests) Object.assign(allObjects, manifest.objects ?? {});
const isModelClassName = (name) =>
  Object.values(allObjects).some(
    (o) => o.className === name || o.qualifiedName === name,
  );
const isServedKey = (definition) =>
  !isFrameworkBaseClass(definition.className, definition.packageName);

/** Registry keys of the closure, framework bases excluded. */
function registeredKeys() {
  const keys = new Set();
  for (const [key, info] of ObjectRegistry.getAllClasses()) {
    if (!info.packageName || !allowed.has(info.packageName)) continue;
    if (isFrameworkBaseClass(info.name, info.packageName)) continue;
    keys.add(info.qualifiedName ?? key);
  }
  return keys;
}

/** A manifest-shaped definition for a key registered without a manifest entry. */
function definitionFromRegistration(key, info) {
  return {
    name: info.name.toLowerCase(),
    className: info.name,
    qualifiedName: info.qualifiedName ?? key,
    packageName: info.packageName,
    collection: info.collection,
    extends: info.extends,
    extendsTypeArg: info.extendsTypeArg,
    collectionOf: info.collectionOf,
    methods: {},
    decoratorConfig: {},
  };
}

/**
 * The composition as the route emitter would see it: every closure
 * definition with its effective config and registered methods.
 */
function semanticManifest(keys) {
  const objects = {};
  for (const key of keys) {
    const info = ObjectRegistry.getClass(key);
    if (!info) continue;
    const base = allObjects[key] ?? definitionFromRegistration(key, info);
    objects[key] = {
      ...base,
      decoratorConfig: ObjectRegistry.getConfig(key),
      methods: Object.fromEntries(info.methods ?? []),
    };
  }
  return { version: '1.0.0', objects };
}

async function transportOps() {
  // MCP: every registered class, so a dependency key reads the same under P
  // as in its own run. Colliding simple names across the closure (ledgers and
  // messages both declare Account) are qualified rather than refused, and the
  // emitted name is recorded, so a collision-induced rename shows.
  const mcp = new Map();
  const generator = new MCPGenerator({ qualifyCollidingNames: true });
  for (const tool of await generator.generateTools()) {
    let identity;
    try {
      identity = generator.getToolIdentity(tool);
    } catch (error) {
      if (cookbookToolNames.has(tool.name)) continue; // carries no model identity
      errors.push(`${job.packageName}: MCP tool ${tool.name} has no model identity: ${error.message}`);
      continue;
    }
    const owner = identity.qualifiedName;
    if (!owner) {
      errors.push(`${job.packageName}: MCP tool ${tool.name} (${identity.objectName}) cannot be attributed to a registration.`);
      continue;
    }
    // Each address keeps the operation it runs: two tools swapping actions
    // keep both sets equal but change what a client's call does.
    if (!mcp.has(owner)) mcp.set(owner, { ops: new Set(), names: new Map() });
    mcp.get(owner).ops.add(identity.action);
    mcp.get(owner).names.set(tool.name, identity.action);
  }
  // CLI: what a user can type, names and aliases included, each with the
  // operation it runs. Utility and built-in commands are identified by the
  // generator, never by elimination. Built-ins are left out: their modules'
  // imports register other packages' models, which would change the
  // composition measured, and they take only addresses no object command has.
  const cliOps = new Map();
  const cliGenerator = new cli.CLIGenerator();
  for (const command of await cliGenerator.listCommands({ builtIns: false })) {
    if (command.source === 'utility' || command.source === 'built-in') continue;
    const owner = command.runtimeModel?.qualifiedName;
    if (command.source !== 'object' || !owner) {
      errors.push(`${job.packageName}: CLI command ${command.name} cannot be attributed (source ${command.source ?? 'none'}).`);
      continue;
    }
    const colon = command.name.indexOf(':');
    const op = command.name.slice(colon + 1);
    if (!cliOps.has(owner)) cliOps.set(owner, { ops: new Set(), names: new Map() });
    cliOps.get(owner).ops.add(op);
    cliOps.get(owner).names.set(command.name, op);
    for (const alias of command.aliases ?? []) cliOps.get(owner).names.set(alias, op);
  }
  return { mcp, cli: cliOps, cliGenerator };
}

/**
 * Transport buckets no inventoried registration consumed: a tool or command
 * attributed to a stale or unknown owner would otherwise drop out of every
 * file silently.
 */
function unconsumedBuckets(ops, consumed) {
  const left = [];
  for (const [surface, noun] of [
    ['mcp', 'MCP tools'],
    ['cli', 'CLI commands'],
  ])
    for (const [owner, bucket] of ops[surface])
      if (!consumed.has(owner))
        left.push(`${noun} ${[...bucket.names.keys()].sort(byCodeUnit).join(', ')} are attributed to ${owner}, which no inventoried registration owns`);
  return left;
}

function inventory(key, definition, ops, manifest) {
  const info = ObjectRegistry.getClass(key);
  if (!info) {
    // getConfig() of an unregistered key is `{}`, which reads as the open
    // default: an unresolved key is never inventoried.
    errors.push(`${job.packageName}: ${key} has no registration; its surface cannot be computed.`);
    return undefined;
  }
  const owner = info.qualifiedName ?? key;
  const isCollection = ObjectRegistry.isCollectionClass(key);
  const surfaceOf = (map, field) => {
    const found = map.get(owner);
    return found && found.ops.size
      ? {
          ops: [...found.ops].sort(byCodeUnit),
          // address -> operation, keys in code-unit order
          [field]: Object.fromEntries(
            [...found.names].sort(([a], [b]) => byCodeUnit(a, b)),
          ),
        }
      : false;
  };
  const flags = [
    'crossPackageJunction',
    'junctionItemUnresolved',
    'junctionAncestryUnresolved',
  ].filter((flag) => definition?.[flag] === true);
  return {
    key,
    kind: isCollection ? 'collection' : 'model',
    owner,
    ...(definition?.internal ? { internal: definition.internal } : {}),
    ...(definition?.inheritedExposure?.length ? { src: 'inherited' } : {}),
    ...(flags.length ? { flags } : {}),
    api: restSurface(rest, {
      definition: manifest.objects[key] ?? semanticManifest([key]).objects[key],
      manifest,
      isCollection,
      isModelClassName,
    }),
    mcp: surfaceOf(ops.mcp, 'tools'),
    cli: surfaceOf(ops.cli, 'commands'),
  };
}

async function snapshot() {
  const ops = await transportOps();
  const keys = registeredKeys();
  const manifest = semanticManifest(keys);
  const entries = [];
  const ownKeys = new Set();
  for (const [key, d] of Object.entries(own.manifest.objects ?? {})) {
    if (!isServedKey(d)) continue;
    ownKeys.add(key);
    const entry = inventory(key, d, ops, manifest);
    if (entry) entries.push(entry);
  }
  const dependencyEntries = [];
  for (const { packageName, manifest: m } of manifests) {
    if (packageName === job.packageName) continue;
    for (const [key, d] of Object.entries(m.objects ?? {})) {
      if (!isServedKey(d)) continue;
      const entry = inventory(key, d, ops, manifest);
      if (entry) dependencyEntries.push({ ...entry, packageName });
    }
  }
  // CLI commands are named by simple name: two closure classes sharing one
  // mask each other, and the CLI serves whichever its own name resolution
  // picks, even one whose config emits no command. Each of P's keys whose
  // `<name>:` prefix resolves to another registration is marked.
  const masked = [];
  const classes = ObjectRegistry.getAllClasses();
  for (const entry of entries) {
    const name = ObjectRegistry.getClass(entry.key)?.name;
    const winnerKey = name ? ops.cliGenerator.resolveCommandRegistrationKey(name) : undefined;
    const winner = winnerKey ? classes.get(winnerKey) : undefined;
    const servedBy = winner ? (winner.qualifiedName ?? winnerKey) : undefined;
    if (servedBy && servedBy !== entry.owner)
      masked.push({ key: entry.key, surface: 'cli', by: servedBy });
  }
  const consumed = new Set(
    [...entries, ...dependencyEntries].map((entry) => entry.owner),
  );
  return { entries, dependencyEntries, masked, keys, ownKeys, ops, consumed };
}

let result;
try {
  result = await snapshot();
} catch (error) {
  errors.push(`${job.packageName}: inventory failed: ${error.stack ?? error.message}`);
  finish({});
}
for (const leftover of unconsumedBuckets(result.ops, result.consumed))
  errors.push(`${job.packageName}: ${leftover}.`);

const unmarked = manifests
  .filter((m) => m.packageName !== job.packageName && !m.manifest.exposureRules)
  .map((m) => m.packageName);
const ambiguous = result.entries
  .filter((e) =>
    e.flags?.some((flag) => flag === 'junctionItemUnresolved' || flag === 'junctionAncestryUnresolved'),
  )
  .map((e) => e.key);

/** Owner and served operations: what loader parity compares. */
const servedTuple = (entry) =>
  entry ? { owner: entry.owner, api: entry.api, mcp: entry.mcp, cli: entry.cli } : null;

/** Canonical JSON (keys sorted at every level) of a divergence pair. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The package's root as a consumer imports it: Node resolves the package
 * name, with its real conditions, from a directory whose node_modules links
 * to the package. Throws when no entry resolves.
 */
async function resolveConsumerEntry(packageDir, packageName) {
  const consumer = path.join(process.cwd(), 'parity-consumer');
  const link = path.join(consumer, 'node_modules', ...packageName.split('/'));
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(packageDir, link, 'dir');
  const probe = path.join(consumer, 'resolve.mjs');
  writeFileSync(probe, 'export const resolveEntry = (name) => import.meta.resolve(name);\n');
  const { resolveEntry } = await import(pathToFileURL(probe).href);
  return resolveEntry(packageName);
}

// Loader parity: import the package's built root as a consumer would, so its
// decorators register real constructors over the manifest entries. Owner and
// served operations must not move for any key: P's own keys, every key the
// root import adds, and every dependency key; the import may register no
// package outside the closure. Divergences go back to the parent, which
// holds their difference to the reviewed list.
const parityDivergences = [];
let parityChecked = false;
if (job.parityPackageJson) {
  try {
    const packageDir = path.dirname(job.parityPackageJson);
    let url;
    try {
      url = await resolveConsumerEntry(packageDir, job.packageName);
    } catch (error) {
      throw new Error(`no entry of ${job.packageName} resolves for a consumer under Node's conditions: ${error.message}`);
    }
    const registeredBefore = new Set(ObjectRegistry.getAllClasses().keys());
    await import(url);
    // A registration the import adds must belong to the declared closure: a
    // model of another installed package (or one without a package identity)
    // would add tools and commands no closure key accounts for.
    for (const [key, info] of ObjectRegistry.getAllClasses()) {
      if (registeredBefore.has(key) || isFrameworkBaseClass(info.name, info.packageName)) continue;
      if (!info.packageName || !allowed.has(info.packageName))
        errors.push(
          `loader parity: importing ${job.packageName}'s built root registers ${info.qualifiedName ?? key}${info.packageName ? ` of ${info.packageName}` : ' with no package identity'}, outside its smrtDependencies closure. Declare the package in smrtDependencies or stop registering it from this root.`,
        );
    }
    const after = await snapshot();
    const push = (id, before, now) => {
      const manifest = servedTuple(before);
      const builtRoot = servedTuple(now);
      if (canonical(manifest) === canonical(builtRoot)) return;
      parityDivergences.push({ key: id, manifest, builtRoot });
    };
    const afterOwn = new Map(after.entries.map((e) => [e.key, e]));
    for (const before of result.entries) push(before.key, before, afterOwn.get(before.key));
    // A key the root import registers that no manifest declares.
    const added = [...after.keys].filter((key) => !result.keys.has(key)).sort(byCodeUnit);
    const consumedAfter = new Set(after.consumed);
    if (added.length > 0) {
      const afterManifest = semanticManifest(after.keys);
      for (const key of added) {
        const info = ObjectRegistry.getClass(key);
        const entry = inventory(key, undefined, after.ops, afterManifest);
        if (entry) consumedAfter.add(entry.owner);
        push(info?.packageName === job.packageName ? key : `${key} (under ${job.packageName})`, null, entry);
      }
    }
    for (const leftover of unconsumedBuckets(after.ops, consumedAfter))
      errors.push(`loader parity: ${job.packageName}: after importing the built root, ${leftover}.`);
    // Dependency keys, owner included: a decorator that changes which model
    // serves a dependency key, or how, diverges.
    const afterDeps = new Map(after.dependencyEntries.map((e) => [e.key, e]));
    for (const before of result.dependencyEntries)
      push(`${before.key} (under ${job.packageName})`, before, afterDeps.get(before.key));
    parityChecked = true;
  } catch (error) {
    errors.push(`loader parity: ${job.packageName}: ${error.message}`);
  }
}

finish({
  entries: result.entries,
  dependencyEntries: result.dependencyEntries,
  masked: result.masked,
  unmarked,
  ambiguous,
  parityChecked,
  parityDivergences,
});
