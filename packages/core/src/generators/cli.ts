/**
 * CLI command generator for smrt objects
 *
 * Exposes registered `@smrt()` objects as a runnable admin CLI: each object gets
 * `list`/`get`/`create`/`update`/`delete` commands plus its public custom
 * methods, dispatched as `objectname:action`.
 *
 * Security parity with the REST/MCP generators (#1540, #1547, #1554, #1556):
 * - **Mass-assignment guard** — create/update bodies are filtered through the
 *   `@smrt({ api: { writable: [...] } })` allowlist, dropping server-managed and
 *   `@field({ readonly })` fields ({@link CLIGenerator.applyWritablePolicy}).
 * - **Exhaustive include** — an `include` list is the COMPLETE allowlist for the
 *   surface; custom methods are gated on `isPublic`.
 * - **Sensitive redaction** — command *output* is serialized through
 *   {@link CLIGenerator.toPublicData} so `@field({ sensitive })` values never
 *   print (input bodies are guarded by the writable allowlist above).
 * - **Fail-closed tenant context** — tenant-scoped reads/writes run inside the
 *   tenancy gate; without `--tenant <id>` / `--all-tenants` (and with tenancy
 *   enabled) the command throws rather than ranging across all tenants.
 */

import type { SmrtCollection } from '../collection';
import { ObjectRegistry } from '../registry';
import { runWithTenantGate } from './tenant-gate.js';

/**
 * Configuration for a generated CLI.
 */
export interface CLIConfig {
  /** CLI program name (used in help output). */
  name?: string;
  /** CLI version. */
  version?: string;
  /** CLI description. */
  description?: string;
}

/**
 * Per-invocation context for a generated CLI.
 */
export interface CLIContext {
  /** Database handle passed to collections. */
  db?: any;
  /** AI provider passed to collections. */
  ai?: any;
  /** Authenticated operator, when the host establishes one. */
  user?: {
    id: string;
    roles?: string[];
  };
  /**
   * Default tenant for tenant-scoped commands when no `--tenant` flag is given.
   * Hosts that authenticate an operator may set this from the principal.
   */
  tenantId?: string;
  /**
   * Default cross-tenant opt-in when no `--all-tenants` flag is given. Hosts
   * may set this for trusted operator/admin shells.
   */
  allowCrossTenant?: boolean;
}

/** Standard CRUD verbs handled directly by the generator. */
const CRUD_OPERATIONS = ['list', 'get', 'create', 'update', 'delete'];

/**
 * Flags consumed by the CLI itself — never treated as create/update field
 * values or as custom-action options.
 */
const RESERVED_FLAGS = new Set([
  'tenant',
  'all-tenants',
  'from-file',
  'limit',
  'offset',
  'order-by',
  'orderBy',
  'where',
  'format',
  'json',
  'help',
  'id',
]);

/** Parsed CLI invocation. */
interface ParsedInvocation {
  /** Object/collection segment (lowercased), e.g. `product`. */
  objectName: string;
  /** Action segment, e.g. `list` or a custom method name. */
  action: string;
  /** First positional argument after the command (typically an id). */
  positional?: string;
  /** Parsed flags. String for `--k v`/`--k=v`, `true` for bare `--flag`. */
  flags: Record<string, string | boolean>;
}

/**
 * Generate and run an admin CLI for the registered `@smrt()` objects.
 */
export class CLIGenerator {
  private config: CLIConfig;
  private context: CLIContext;

  constructor(config: CLIConfig = {}, context: CLIContext = {}) {
    this.config = {
      name: 'smrt-cli',
      version: '1.0.0',
      description: 'Auto-generated CLI from smrt objects',
      ...config,
    };
    this.context = context;
  }

  /** CLI program name. */
  get name(): string | undefined {
    return this.config.name;
  }

  /** CLI version. */
  get version(): string | undefined {
    return this.config.version;
  }

  /**
   * Return the argv handler invoked by the generated `setupCLI()` wrapper.
   *
   * @returns An async function accepting the post-`node script` argv slice.
   */
  generateHandler(): (args: string[]) => Promise<void> {
    return async (args: string[]) => {
      await this.run(args ?? []);
    };
  }

  /**
   * Parse and execute a single CLI invocation.
   *
   * @param args - argv slice (command + flags).
   */
  async run(args: string[]): Promise<void> {
    if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
      console.log(await this.helpText());
      return;
    }

    const parsed = this.parseArgs(args);
    if (!parsed) {
      console.log(await this.helpText());
      return;
    }

    const classInfo = this.resolveClass(parsed.objectName);
    if (!classInfo) {
      throw new Error(`Object type '${parsed.objectName}' not found`);
    }
    const objectName: string = classInfo.name || parsed.objectName;

    await this.assertCommandExposed(objectName, parsed.action);

    const tenantId =
      typeof parsed.flags.tenant === 'string'
        ? parsed.flags.tenant
        : this.context.tenantId;
    const allowCrossTenant =
      parsed.flags['all-tenants'] === true ||
      this.context.allowCrossTenant === true;

    // Tenant-scoping is resolved authoritatively inside tenancy (by class name),
    // matching the interceptor and covering both @TenantScoped and
    // @smrt({ tenantScoped }) registrations (#1554).
    const result = await runWithTenantGate(
      { className: objectName, tenantId, allowCrossTenant, surface: 'CLI' },
      async () => {
        const collection = await this.getCollection(objectName);
        return this.executeAction(collection, objectName, parsed);
      },
    );

    if (result !== undefined) {
      console.log(JSON.stringify(this.toPublicData(result), null, 2));
    }
  }

  /**
   * Parse argv into a command + flags. Supports `name:action` and
   * `name action` command forms, `--key value`, `--key=value`, and bare
   * `--flag` booleans.
   */
  private parseArgs(args: string[]): ParsedInvocation | null {
    const [command, ...rest] = args;
    if (!command || command.startsWith('-')) return null;

    let objectName: string;
    let action: string;
    let tail = rest;

    if (command.includes(':')) {
      const [obj, act] = command.split(':');
      objectName = obj.toLowerCase();
      action = act;
    } else if (rest.length > 0 && !rest[0].startsWith('-')) {
      objectName = command.toLowerCase();
      action = rest[0];
      tail = rest.slice(1);
    } else {
      // A bare object name with no action is not a runnable command.
      return null;
    }

    if (!objectName || !action) return null;

    const flags: Record<string, string | boolean> = {};
    let positional: string | undefined;

    for (let i = 0; i < tail.length; i++) {
      const token = tail[i];
      if (token.startsWith('--')) {
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq !== -1) {
          flags[body.slice(0, eq)] = body.slice(eq + 1);
        } else {
          const next = tail[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            flags[body] = next;
            i++;
          } else {
            flags[body] = true;
          }
        }
      } else if (positional === undefined) {
        positional = token;
      }
    }

    return { objectName, action, positional, flags };
  }

  /**
   * Resolve a registered class by simple name (case-insensitive), mirroring the
   * MCP generator's lookup.
   */
  private resolveClass(objectName: string): any {
    const registeredClasses = ObjectRegistry.getAllClasses();
    for (const [key, info] of registeredClasses) {
      const simpleName = info.name || key;
      if (simpleName.toLowerCase() === objectName.toLowerCase()) {
        return info;
      }
    }
    return null;
  }

  /**
   * Throw if `action` is not exposed for `objectName` under its `@smrt({ cli })`
   * config. `cli: false` disables the object entirely; an `include` list is the
   * complete allowlist; custom methods must be `isPublic`.
   */
  private async assertCommandExposed(
    objectName: string,
    action: string,
  ): Promise<void> {
    const config = ObjectRegistry.getConfig(objectName);
    const cliConfig = config?.cli;

    if (cliConfig === false) {
      throw new Error(`CLI is disabled for ${objectName}`);
    }

    const included: string[] | undefined =
      typeof cliConfig === 'object' ? cliConfig?.include : undefined;
    const excluded: string[] =
      typeof cliConfig === 'object' && cliConfig?.exclude
        ? cliConfig.exclude
        : [];

    if (excluded.includes(action)) {
      throw new Error(`Command '${action}' is excluded for ${objectName}`);
    }

    const isCrud = CRUD_OPERATIONS.includes(action);

    if (isCrud) {
      // An include list, when present, is the complete allowlist for CRUD too.
      if (included && !included.includes(action)) {
        throw new Error(`Command '${action}' is not enabled for ${objectName}`);
      }
      return;
    }

    // Custom method: must be public, and — when an include list is present — it
    // is the COMPLETE allowlist (parity with MCP exhaustive-include, #1547).
    const methods = await ObjectRegistry.getAllMethods(objectName);
    const methodDef = methods.get(action);
    if (!methodDef) {
      throw new Error(`Unknown command '${action}' for ${objectName}`);
    }
    if (!methodDef.isPublic) {
      throw new Error(`Command '${action}' is not public on ${objectName}`);
    }
    if (included !== undefined && !included.includes(action)) {
      throw new Error(`Command '${action}' is not enabled for ${objectName}`);
    }
  }

  /**
   * Get the collection for an object via the registry factory. Uses
   * `ObjectRegistry.getCollection`, which caches, initializes, and — for plain
   * `@smrt()` models without a hand-written collection class — auto-creates the
   * default collection. (A bare `collectionConstructor` check would wrongly
   * throw for those models even though CRUD is advertised.)
   */
  private async getCollection(
    objectName: string,
  ): Promise<SmrtCollection<any>> {
    return ObjectRegistry.getCollection(objectName, {
      ai: this.context.ai,
      db: this.context.db,
    });
  }

  /**
   * Execute a parsed command against a collection.
   */
  private async executeAction(
    collection: SmrtCollection<any>,
    objectName: string,
    parsed: ParsedInvocation,
  ): Promise<any> {
    const { action, positional, flags } = parsed;

    switch (action) {
      case 'list': {
        const listOptions: any = {
          limit: Math.min(this.toNumber(flags.limit, 50), 1000),
          offset: this.toNumber(flags.offset, 0),
        };
        const orderBy = flags['order-by'] ?? flags.orderBy;
        if (typeof orderBy === 'string') listOptions.orderBy = orderBy;
        if (typeof flags.where === 'string') {
          listOptions.where = JSON.parse(flags.where);
        }
        return collection.list(listOptions);
      }

      case 'get': {
        const id = positional ?? this.flagString(flags.id);
        if (!id) throw new Error('An id is required for get');
        const item = await collection.get(id);
        if (!item) throw new Error(`${objectName} not found`);
        return item;
      }

      case 'create': {
        const data = this.applyWritablePolicy(
          objectName,
          await this.readPayload(flags),
        );
        if (this.context.user) {
          (data as any).created_by = this.context.user.id;
          (data as any).owner_id = this.context.user.id;
        }
        const created = await collection.create(data);
        await created.save();
        return created;
      }

      case 'update': {
        const id = positional ?? this.flagString(flags.id);
        if (!id) throw new Error('An id is required for update');
        const existing = await collection.get(id);
        if (!existing) throw new Error(`${objectName} not found`);
        const data = this.applyWritablePolicy(
          objectName,
          await this.readPayload(flags),
        );
        Object.assign(existing, data);
        if (this.context.user) {
          (existing as any).updated_by = this.context.user.id;
        }
        await existing.save();
        return existing;
      }

      case 'delete': {
        const id = positional ?? this.flagString(flags.id);
        if (!id) throw new Error('An id is required for delete');
        const existing = await collection.get(id);
        if (!existing) throw new Error(`${objectName} not found`);
        await existing.delete();
        return { success: true, id, message: `${objectName} deleted` };
      }

      default:
        return this.executeCustomAction(collection, action, positional, flags);
    }
  }

  /**
   * Execute a custom method on an instance (when an id is given) or on the
   * collection (singleton actions). Mirrors the MCP custom-action path.
   */
  private async executeCustomAction(
    collection: SmrtCollection<any>,
    action: string,
    positional: string | undefined,
    flags: Record<string, string | boolean>,
  ): Promise<any> {
    const options = this.customOptions(flags);
    const id = positional ?? this.flagString(flags.id);

    if (id) {
      const object = (await collection.get(id)) as any;
      if (!object) throw new Error('Object not found');
      if (typeof object[action] !== 'function') {
        throw new Error(`Method '${action}' not found on object instance`);
      }
      return object[action](options);
    }

    if (typeof (collection as any)[action] === 'function') {
      return (collection as any)[action](options);
    }
    throw new Error(
      `Method '${action}' not found on collection. Provide an id for object-specific actions.`,
    );
  }

  /**
   * Resolve the create/update payload: `--from-file <path>` (JSON) takes
   * precedence; otherwise non-reserved `--field value` flags form the body.
   * Reading from a file also keeps secrets off the process argv (#1556).
   */
  private async readPayload(
    flags: Record<string, string | boolean>,
  ): Promise<Record<string, any>> {
    const fromFile = flags['from-file'];
    if (typeof fromFile === 'string' && fromFile) {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(fromFile, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--from-file must contain a JSON object');
      }
      return parsed as Record<string, any>;
    }

    const data: Record<string, any> = {};
    for (const [key, value] of Object.entries(flags)) {
      if (RESERVED_FLAGS.has(key)) continue;
      data[key] = this.coerceValue(value);
    }
    return data;
  }

  /** Collect non-reserved flags as custom-action options. */
  private customOptions(
    flags: Record<string, string | boolean>,
  ): Record<string, any> {
    const options: Record<string, any> = {};
    for (const [key, value] of Object.entries(flags)) {
      if (RESERVED_FLAGS.has(key)) continue;
      options[key] = this.coerceValue(value);
    }
    return options;
  }

  /**
   * Mass-assignment guard (#1540/#1556): strip framework/server-managed and
   * `@field({ readonly })` fields, and — when an `@smrt({ api: { writable } })`
   * allowlist is set — intersect with it. Identical policy to the REST/MCP
   * generators so a CLI create/update cannot set fields the API forbids.
   */
  private applyWritablePolicy(
    objectName: string | undefined,
    data: any,
  ): Record<string, any> {
    if (!data || typeof data !== 'object') return {};

    const serverManaged = new Set([
      'id',
      'tenantId',
      'tenant_id',
      'createdAt',
      'created_at',
      'updatedAt',
      'updated_at',
    ]);

    const readonly = new Set<string>();
    let writable: string[] | null = null;

    if (objectName) {
      const apiConfig = ObjectRegistry.getConfig(objectName)?.api;
      if (
        apiConfig &&
        typeof apiConfig === 'object' &&
        Array.isArray((apiConfig as { writable?: unknown }).writable)
      ) {
        writable = (apiConfig as { writable: string[] }).writable;
      }

      for (const [name, def] of ObjectRegistry.getFields(objectName)) {
        if (def && (def.readonly === true || def._meta?.readonly === true)) {
          readonly.add(name);
        }
      }
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (serverManaged.has(key)) continue;
      if (readonly.has(key)) continue;
      if (writable && !writable.includes(key)) continue;
      result[key] = value;
    }
    return result;
  }

  /**
   * Serialize command output, excluding `@field({ sensitive })` fields (#1540).
   * Recurses arrays/plain objects so a SmrtObject nested in a custom-action
   * result is stripped too; a cycle guard prevents infinite loops.
   */
  private toPublicData(value: any, seen: WeakSet<object> = new WeakSet()): any {
    if (value === null || typeof value !== 'object') return value;
    if (typeof value.toPublicJSON === 'function') return value.toPublicJSON();
    if (Array.isArray(value)) {
      if (seen.has(value)) return value;
      seen.add(value);
      return value.map((entry) => this.toPublicData(entry, seen));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    if (seen.has(value)) return value;
    seen.add(value);
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = this.toPublicData(entry, seen);
    }
    return out;
  }

  /** List the runnable commands grouped by object, for help output. */
  async listCommands(): Promise<string[]> {
    const commands: string[] = [];
    for (const [key, classInfo] of ObjectRegistry.getAllClasses()) {
      const objectName = classInfo.name || key;
      const config = ObjectRegistry.getConfig(objectName);
      const cliConfig = config?.cli;
      if (cliConfig === false) continue;

      const lower = objectName.toLowerCase();
      const included: string[] | undefined =
        typeof cliConfig === 'object' ? cliConfig?.include : undefined;
      const excluded: string[] =
        typeof cliConfig === 'object' && cliConfig?.exclude
          ? cliConfig.exclude
          : [];

      const expose = (cmd: string) =>
        !excluded.includes(cmd) && (!included || included.includes(cmd));

      for (const verb of CRUD_OPERATIONS) {
        if (expose(verb)) commands.push(`${lower}:${verb}`);
      }

      const methods = await ObjectRegistry.getAllMethods(objectName);
      for (const [methodName, methodDef] of methods) {
        if (CRUD_OPERATIONS.includes(methodName)) continue;
        if (!methodDef.isPublic) continue;
        if (excluded.includes(methodName)) continue;
        if (included !== undefined && !included.includes(methodName)) continue;
        commands.push(`${lower}:${methodName}`);
      }
    }
    return commands.sort();
  }

  private async helpText(): Promise<string> {
    const commands = await this.listCommands();
    return [
      `${this.config.name} ${this.config.version}`,
      this.config.description ?? '',
      '',
      'Usage: <object>:<action> [id] [--flags]',
      '',
      'Global flags:',
      '  --tenant <id>     run the command inside a specific tenant',
      '  --all-tenants     allow cross-tenant access (operator opt-in)',
      '  --from-file <p>   read create/update payload from a JSON file',
      '  --where <json>    filter for list',
      '  --limit / --offset / --order-by',
      '',
      'Commands:',
      ...commands.map((c) => `  ${c}`),
    ].join('\n');
  }

  private toNumber(
    value: string | boolean | undefined,
    fallback: number,
  ): number {
    if (typeof value !== 'string') return fallback;
    const n = Number.parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
  }

  private flagString(value: string | boolean | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  /** Coerce a flag value to a JSON scalar/object where it parses cleanly. */
  private coerceValue(value: string | boolean): any {
    if (typeof value !== 'string') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
    if (
      (value.startsWith('{') && value.endsWith('}')) ||
      (value.startsWith('[') && value.endsWith(']'))
    ) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}

/**
 * Convenience runner used by the generated `setupCLI()` wrapper.
 *
 * @param config - CLI configuration.
 * @param context - Per-invocation context.
 * @returns A `{ run, generator }` pair; `run(argv)` strips the leading
 *   `node script` entries before dispatching.
 */
export function setupCLI(config: CLIConfig = {}, context: CLIContext = {}) {
  const generator = new CLIGenerator(config, context);
  return {
    run: async (argv: string[]) => {
      const handler = generator.generateHandler();
      await handler(argv.slice(2));
    },
    generator,
  };
}

/**
 * Get a bare argv handler for a generated CLI.
 *
 * @param config - CLI configuration.
 * @param context - Per-invocation context.
 * @returns An async argv-slice handler.
 */
export function getCLIHandler(
  config: CLIConfig = {},
  context: CLIContext = {},
) {
  const generator = new CLIGenerator(config, context);
  return generator.generateHandler();
}
