/**
 * Regression gate: across every published SMRT package, no model subclass
 * publishes a generated operation its parent model closes.
 *
 * Each package is imported the way a consumer imports it (its inline manifest
 * registers its classes). Then, for every model that extends another
 * registered model (STI children and CTI subclasses alike), the gate reads
 * the subclass's real generated surface:
 *
 * - MCP: the tools `MCPGenerator` lists for it;
 * - CLI: the commands the local `smrt` CLI generator builds for it;
 * - REST: the actions `resolveApiActionSet` routes for it (the set both
 *   SvelteKit route emitters read).
 *
 * Every operation on each transport must be a method only the subclass
 * declares, an operation its parent's declared surface opens, or one the
 * subclass lists in `widenParentExposure`. A sensitive parent's subclasses
 * must be sensitive.
 *
 * The parent's surface is read from its package manifest, which is what the
 * build guard (`CONFIG_SUBCLASS_EXPOSURE`) checks. An abstract parent is
 * skipped for its nearest concrete ancestor: the build makes the abstract
 * class itself read-only, and its concrete subclasses exist to lift that.
 *
 * `INVENTORY` pins the subclasses (and collections over them) that published
 * operations their parent closed before this gate existed, with the MCP tools
 * each publishes now, so a rename cannot silently drop one from coverage.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isFrameworkBaseClass,
  ObjectRegistry,
  type SmartObjectConfig,
  type SmartObjectManifest,
  surfaceOpensOperation,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators';
import { resolveApiActionSet } from '@happyvertical/smrt-core/vite-plugin';
import { beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '../../..');
// The CLI generator is not a public export of @happyvertical/smrt-cli; load
// the workspace source the published binary is built from.
const cliGeneratorPath = path.resolve(packagesDir, 'cli/src/cli-generator.ts');
const CRUD = ['list', 'get', 'create', 'update', 'delete'];
const SURFACES = ['api', 'mcp', 'cli'] as const;
type Surface = (typeof SURFACES)[number];

/**
 * Before the fix (v0.57.0), measured with this gate's rule: 214 MCP tools and
 * 164 REST actions their parent closes, across these 14 subclasses, plus 21
 * MCP tools on `EmailAttachmentCollection`. Per class, MCP tools before ->
 * now: Person, Organization and Bot 35 -> 4 (including `delete`,
 * `generateapikey`, `linkoidcidentity`, `linknostridentity` before);
 * EmailAttachment 14 -> 2; EmailAttachmentCollection 23 -> 2; each commerce
 * contract subtype 13 -> 2 (LicenseSale 15 -> 2), including
 * `create`/`update`/`delete`, `recalculatetotals` and `savederived` before.
 * No CLI command changed: `Profile` and `Contract` leave their CLI open.
 */
const INVENTORY: Record<string, string[]> = {
  'profiles:Person': ['create', 'get', 'list', 'update'],
  'profiles:Organization': ['create', 'get', 'list', 'update'],
  'profiles:Bot': ['create', 'get', 'list', 'update'],
  'messages:EmailAttachment': ['get', 'list'],
  'messages:EmailAttachmentCollection': ['get', 'list'],
  'commerce:Estimate': ['get', 'list'],
  'commerce:Order': ['get', 'list'],
  'commerce:Lease': ['get', 'list'],
  'commerce:Agreement': ['get', 'list'],
  'commerce:Cart': ['get', 'list'],
  'commerce:LicenseSale': ['get', 'list'],
  'commerce:WholesaleOrder': ['get', 'list'],
  'commerce:PurchaseOrder': ['get', 'list'],
  'commerce:ProductionOrder': ['get', 'list'],
  'commerce:SupplierQuote': ['get', 'list'],
};

/** Subclasses that deliberately widen their parent, with what they widen. */
const DECLARED_WIDENINGS: Record<
  string,
  SmartObjectConfig['widenParentExposure']
> = {
  'messages:Email': { api: ['create', 'update', 'delete'] },
  'messages:SlackMessage': { api: ['create'] },
  'messages:Tweet': { api: ['create'] },
};

interface ManifestObject {
  className: string;
  qualifiedName: string;
  extends?: string;
  methods?: Record<string, { isPublic?: boolean }>;
  decoratorConfig?: SmartObjectConfig;
}

interface SubclassSurface {
  key: string;
  parent: string;
  reference: string;
  operations: Record<Surface, string[]>;
}

interface CliGeneratorLike {
  generateObjectCommands(
    name: string,
    info: unknown,
  ): Promise<Array<{ name: string }>>;
  tryLoadUserClasses(): Promise<void>;
}

const packageNames = Object.keys(
  JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'))
    .devDependencies as Record<string, string>,
).filter((name) => name.startsWith('@happyvertical/smrt-'));

function readManifest(packageName: string) {
  const dir = packageName.replace('@happyvertical/smrt-', '');
  // Svelte-packaged libraries publish their manifest under `dist/lib/`.
  for (const relative of ['dist/manifest.json', 'dist/lib/manifest.json']) {
    try {
      return JSON.parse(
        readFileSync(path.join(packagesDir, dir, relative), 'utf8'),
      ) as SmartObjectManifest;
    } catch {
      // try the next location
    }
  }
  return undefined;
}

const declared = new Map<string, ManifestObject>();
const manifests = new Map<string, SmartObjectManifest>();
const subclasses = new Map<string, SubclassSurface>();
const mcpTools = new Map<string, string[]>();

function isModel(key: string): boolean {
  const registered = ObjectRegistry.getClass(key);
  return (
    !!registered &&
    !isFrameworkBaseClass(registered.name, registered.packageName) &&
    !ObjectRegistry.isCollectionClass(key)
  );
}

/** The declared name for an operation, matched case-insensitively (MCP). */
function canonical(operation: string, names: string[]): string {
  return (
    names.find((name) => name.toLowerCase() === operation.toLowerCase()) ??
    operation
  );
}

async function mcpActions(key: string): Promise<string[]> {
  const generator = new MCPGenerator({ classNames: [key] });
  return (await generator.generateTools())
    .map((tool) => generator.getToolIdentity(tool).action)
    .sort();
}

describe('model subclasses never publish more than their parent model', () => {
  beforeAll(async () => {
    for (const packageName of packageNames) {
      const manifest = readManifest(packageName);
      if (manifest) {
        manifests.set(packageName, manifest);
        for (const [key, def] of Object.entries(manifest.objects)) {
          declared.set(key, def as unknown as ManifestObject);
        }
      }
      try {
        await import(/* @vite-ignore */ packageName);
      } catch {
        // A package whose entry needs a bundler (Svelte components) still
        // registers its classes from its published manifest.
        if (manifest) {
          ObjectRegistry.registerPackageManifest(structuredClone(manifest));
        }
      }
    }
    const { CLIGenerator } = (await import(
      /* @vite-ignore */ cliGeneratorPath
    )) as { CLIGenerator: new (config: object) => CliGeneratorLike };
    const cli = new CLIGenerator({ prompt: false, colors: false });
    cli.tryLoadUserClasses = async () => {};

    for (const manifest of manifests.values()) {
      for (const [key, def] of Object.entries(manifest.objects)) {
        if (!isModel(key)) continue;
        const chain = ObjectRegistry.getInheritanceChain(key);
        const parent = chain.at(-2);
        if (!parent || !isModel(parent) || !declared.has(parent)) continue;
        // The nearest concrete ancestor stands in for an abstract parent.
        let reference = parent;
        for (const ancestor of chain.slice(0, -1).reverse()) {
          reference = ancestor;
          if (declared.get(ancestor)?.decoratorConfig?.abstract !== true) break;
        }

        const prefix = `${key}:`.toLowerCase();
        const cliCommands = (
          await cli.generateObjectCommands(key, ObjectRegistry.getClass(key))
        ).map((command) =>
          command.name.toLowerCase().startsWith(prefix)
            ? command.name.slice(prefix.length)
            : (command.name.split(':').at(-1) as string),
        );
        // Routes are emitted from the manifest; give the definition the
        // effective runtime surface, so a manifest built before inheritance
        // existed is held to the same rule.
        const rest = [
          ...resolveApiActionSet(
            {
              ...def,
              decoratorConfig: {
                ...(def.decoratorConfig ?? {}),
                api: ObjectRegistry.getConfig(key).api,
              },
            } as unknown as Parameters<typeof resolveApiActionSet>[0],
            manifest,
          ),
        ];
        subclasses.set(key, {
          key,
          parent,
          reference,
          operations: {
            api: rest,
            mcp: await mcpActions(key),
            cli: cliCommands,
          },
        });
      }
    }
    for (const entry of Object.keys(INVENTORY)) {
      const [dir, className] = entry.split(':');
      const key = `@happyvertical/smrt-${dir}:${className}`;
      if (ObjectRegistry.getAllClasses().has(key)) {
        mcpTools.set(entry, await mcpActions(key));
      }
    }
  }, 600_000);

  it('found the subclasses it checks', () => {
    expect(subclasses.size).toBeGreaterThan(40);
  });

  it('opens no operation on REST, MCP or CLI that the parent closes', () => {
    const leaks: string[] = [];
    for (const surface of subclasses.values()) {
      const parentDef = declared.get(surface.parent) as ManifestObject;
      const referenceConfig =
        declared.get(surface.reference)?.decoratorConfig ?? {};
      const parentMethods = Object.entries(parentDef.methods ?? {})
        .filter(([, method]) => method.isPublic !== false)
        .map(([name]) => name);
      const known = [...CRUD, ...parentMethods];
      const childConfig = ObjectRegistry.getConfig(surface.key);
      for (const transport of SURFACES) {
        const accepted = childConfig.widenParentExposure?.[transport] ?? [];
        for (const raw of surface.operations[transport]) {
          const operation = canonical(raw, known);
          // A method only the subclass declares is its own API.
          if (!known.includes(operation)) continue;
          if (accepted.includes(operation)) continue;
          if (
            surfaceOpensOperation(
              transport,
              referenceConfig[transport],
              operation,
            )
          ) {
            continue;
          }
          leaks.push(`${surface.key} ${transport} ${operation}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('declares every deliberate widening, and only those', () => {
    const widenings: Record<string, unknown> = {};
    for (const key of subclasses.keys()) {
      const widen = ObjectRegistry.getConfig(key).widenParentExposure;
      if (widen) widenings[key.replace('@happyvertical/smrt-', '')] = widen;
    }
    expect(widenings).toEqual(DECLARED_WIDENINGS);
  });

  it("keeps a sensitive parent's subclasses sensitive", () => {
    const leaks: string[] = [];
    for (const surface of subclasses.values()) {
      if (ObjectRegistry.getConfig(surface.parent).sensitive !== true) continue;
      if (ObjectRegistry.getConfig(surface.key).sensitive !== true) {
        leaks.push(surface.key);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('covers every class from the exposure inventory, with its MCP tools pinned', () => {
    expect(Object.fromEntries(mcpTools)).toEqual(INVENTORY);
    for (const entry of Object.keys(INVENTORY)) {
      if (entry.endsWith('Collection')) continue;
      const [dir, className] = entry.split(':');
      expect(
        subclasses.has(`@happyvertical/smrt-${dir}:${className}`),
        entry,
      ).toBe(true);
    }
  });
});
