/**
 * Browser-entry export parity (#3614).
 *
 * `package.json` `exports["."].browser` resolves to `dist/browser.js`, so a
 * model package bundled for a browser can only use the value exports that
 * entry carries. Before #3614 it omitted the decorators and runtime helpers
 * every model package imports (`field`, `foreignKey`, `crossPackageRef`,
 * `applyPendingDecoratorRegistrations`, `resolveDatabase`, `bumpChangeFeed`,
 * ...), so `vite build` failed with `[MISSING_EXPORT]` for each of them.
 *
 * Guards:
 * 1. every value exported by the Node entry (`index.ts`) is either exported by
 *    `browser.ts` or listed in {@link BROWSER_ENTRY_NODE_ONLY} with a reason,
 *    the allowlist carries no stale entries, and the browser entry publishes
 *    no value the Node entry lacks;
 * 2. every value a workspace package (`packages/<name>/src`, non-test) imports
 *    from the package root resolves from the browser entry or is on that list.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as browserEntry from '../browser';
import * as nodeEntry from '../index';

const HTTP_ROUTE =
  'HTTP route/response helper (node:http / node:crypto); stays behind the generators subpaths';

/** Names that deliberately exist only on the Node entry, with the reason. */
const NODE_ONLY_GROUPS: ReadonlyArray<{
  reason: string;
  names: readonly string[];
}> = [
  {
    reason:
      'REST server bootstrap (node:http); belongs behind `@happyvertical/smrt-core/generators/rest`. Model packages that import startRestServer from the root are tracked by #3616',
    names: [
      'APIGenerator',
      'computeRuntimeWebManifestHash',
      'createRestServer',
      'startRestServer',
    ],
  },
  {
    reason:
      'OpenAPI/Swagger UI serving; belongs behind `@happyvertical/smrt-core/generators/swagger`',
    names: ['generateOpenAPISpec', 'setupSwaggerUI'],
  },
  {
    reason:
      'MCP tool generator (node:fs/promises); belongs behind `@happyvertical/smrt-core/generators/mcp`',
    names: [
      'MCPGenerator',
      'MCP_STABLE_CATALOG_TTL_MS',
      'resolveMCPToolListCacheHint',
      'sortMCPTools',
    ],
  },
  {
    reason: HTTP_ROUTE,
    names: [
      'PRIVATE_READ_CACHE_CONTROL',
      'canonicalReadRepresentation',
      'computeBodyEtag',
      'computeTableVersionEtag',
      'conditionalJsonResponse',
      'ifNoneMatchHasConcreteMatch',
      'ifNoneMatchSatisfied',
      'resolveReadCacheControl',
      'resolveTenantEtagDiscriminator',
      'versionConditionalResponse',
      'warnIfSharedCacheNeutralized',
    ],
  },
  {
    reason:
      'Server-sent-events route surface for generated REST/SvelteKit transports; stays behind the generators subpaths by policy (its imports are portable)',
    names: [
      'DEFAULT_EVENTS_HEARTBEAT_MS',
      'DEFAULT_EVENTS_MAX_SUBSCRIBERS',
      'DEFAULT_EVENTS_RETRY_AFTER_SECONDS',
      'buildChangeEventStream',
      'changeEventSubscribersAtCapacity',
      'eventStreamCapacityExceededResponse',
      'normalizeEventsMaxSubscribers',
      'signalVisibleToTenant',
      'tryReserveChangeEventSubscriberSlot',
    ],
  },
  {
    reason: `${HTTP_ROUTE} (playbook preflight route; its pure policy predicates could be split out of the route module)`,
    names: [
      'PLAYBOOK_PREFLIGHT_CAPABILITY',
      'PLAYBOOK_PREFLIGHT_ROUTE_SEGMENT',
      'handlePlaybookPreflightRoute',
      'isApiActionEnabledForObject',
      'isRestActionRoutable',
      'isRestRoutePublic',
      'resolveRegisteredObjectName',
      'restFieldReadPermissions',
      'restMethodForApiAction',
    ],
  },
  {
    reason:
      'Server half of the runtime (node:http, MCP server); belongs behind `@happyvertical/smrt-core/runtime`. createSmrtClient (fetch) is exported from the browser entry',
    names: ['SmrtMCPServer', 'createMCPServer', 'createSmrtServer'],
  },
  {
    reason:
      'Manifest discovery and static-manifest loading read the filesystem at call or module scope (node:fs, node:module, node:url); belongs behind `@happyvertical/smrt-core/manifest`. findManifestEntryByQualifiedName is imported by smrt-fields/smrt-users: tracked by #3618',
    names: [
      'ManifestBuilder',
      'ManifestGenerator',
      'ManifestManager',
      'discoverManifestEntry',
      'findManifestEntryByQualifiedName',
      'getManifest',
      'loadExternalManifest',
      'loadExternalManifestSync',
      'loadLocalTestManifestSync',
      'loadManifestFromPathSync',
      'manifest',
      'staticManifest',
    ],
  },
  {
    reason:
      'Knowledge graph and artifact publishing (scanner/knowledge, filesystem); belongs behind `@happyvertical/smrt-core/knowledge`',
    names: [
      'AGENT_SURFACE_HASH_PREFIX',
      'MODULE_DOC_HASH_PREFIX',
      'buildDomainKnowledgeManifest',
      'buildKnowledgeGraph',
      'checkKnowledgeGraphFreshness',
      'discoverKnowledgeArtifactPaths',
      'discoverScopedPackageDirectories',
      'publishArtifactFiles',
      'publishAtomicArtifact',
      'readAgentModuleDocs',
      'readPackageAgentDoc',
      'resolveAgentModuleDocPaths',
      'resolveFileKnowledgeConfig',
      'stableStringify',
    ],
  },
  {
    reason:
      'Run-once claims depend on the knowledge graph (`stableStringify`, scanner/knowledge) and node:crypto hashing',
    names: [
      'RUN_ONCE_CLAIMS_TABLE',
      'deriveRunOnceClaimKey',
      'digestRunOnceContent',
      'resolveExistingRunOnceClaim',
      'runOnce',
    ],
  },
  {
    reason:
      'Registry snapshot for the Node-side dev plane (smrt-dev-mcp); sanitizes filesystem paths with node:path, so it stays out of the browser entry (#2838)',
    names: [
      'BOOTED_PROVENANCE',
      'assertPlainJson',
      'sanitizeMessagePaths',
      'snapshotRegistry',
    ],
  },
  {
    reason:
      'Test-database helper; belongs behind `@happyvertical/smrt-core/testing`',
    names: ['getTestDatabase'],
  },
  {
    reason:
      'Vite plugin (build tooling, node:url + scanner); belongs behind `@happyvertical/smrt-core/vite-plugin`',
    names: ['smrtPlugin'],
  },
];

const BROWSER_ENTRY_NODE_ONLY: ReadonlyMap<string, string> = new Map(
  NODE_ONLY_GROUPS.flatMap(({ names, reason }) =>
    names.map((name): [string, string] => [name, reason]),
  ),
);

/**
 * Browser-only names that predate #3614. `export * from './decisions'` leaks
 * `assertFiniteUnitInterval`, which `index.ts` deliberately does not re-export;
 * dropping it would narrow the browser surface, so it is recorded, not removed.
 */
const BROWSER_ONLY_EXISTING: ReadonlyMap<string, string> = new Map([
  [
    'assertFiniteUnitInterval',
    'leaked by the pre-existing decisions star export',
  ],
]);

const nodeNames = new Set(Object.keys(nodeEntry));
const browserNames = new Set(Object.keys(browserEntry));

describe('browser entry export parity (#3614)', () => {
  it('exports every Node-entry value or lists it as node-only with a reason', () => {
    const unaccounted = [...nodeNames].filter(
      (name) => !browserNames.has(name) && !BROWSER_ENTRY_NODE_ONLY.has(name),
    );
    expect(unaccounted).toEqual([]);
  });

  it('keeps the node-only allowlist free of stale or duplicated entries', () => {
    const total = NODE_ONLY_GROUPS.reduce((n, g) => n + g.names.length, 0);
    expect(BROWSER_ENTRY_NODE_ONLY.size).toBe(total);
    const stale = [...BROWSER_ENTRY_NODE_ONLY.keys()].filter(
      (name) => !nodeNames.has(name) || browserNames.has(name),
    );
    expect(stale).toEqual([]);
    for (const reason of BROWSER_ENTRY_NODE_ONLY.values()) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('publishes no value the Node entry lacks, apart from documented browser-only names', () => {
    const extra = [...browserNames].filter(
      (name) => !nodeNames.has(name) && !BROWSER_ONLY_EXISTING.has(name),
    );
    expect(extra).toEqual([]);
    const stale = [...BROWSER_ONLY_EXISTING.keys()].filter(
      (name) => !browserNames.has(name) || nodeNames.has(name),
    );
    expect(stale).toEqual([]);
  });

  it('exports the decorators and helpers model packages need at module scope', () => {
    for (const name of [
      'field',
      'foreignKey',
      'crossPackageRef',
      'manyToMany',
      'oneToMany',
      'meta',
      'method',
      'applyPendingDecoratorRegistrations',
      'registerCompatibleFieldDecorator',
      'resolveDatabase',
      'bumpChangeFeed',
      'isEmbeddedDatabase',
      'isPostgresDatabase',
      'withEmbeddedWriteTransaction',
      'GlobalInterceptors',
      'setTenantEntryPointRunner',
    ]) {
      expect(typeof (browserEntry as Record<string, unknown>)[name]).not.toBe(
        'undefined',
      );
    }
  });

  it('resolves the same values as the Node entry for shared names', () => {
    const mismatched = [...browserNames].filter(
      (name) =>
        nodeNames.has(name) &&
        (nodeEntry as Record<string, unknown>)[name] !==
          (browserEntry as Record<string, unknown>)[name],
    );
    expect(mismatched).toEqual([]);
  });
});

const PACKAGES_DIR = resolve(import.meta.dirname, '../../..');
const TEST_PATH = /(\.test\.|\.spec\.|__tests__|\.stories\.|[\\/]tests?[\\/])/;

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.svelte-kit'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
    } else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.d.ts')) {
      if (!TEST_PATH.test(full)) yield full;
    }
  }
}

/** Value names imported (or re-exported) from the package root, per package. */
function collectRootValueImports(): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  const add = (name: string, pkg: string) => {
    const set = byName.get(name) ?? new Set<string>();
    set.add(pkg);
    byName.set(name, set);
  };
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const srcDir = join(PACKAGES_DIR, pkg, 'src');
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sourceFiles(srcDir)) {
      let text = readFileSync(file, 'utf8');
      if (file.endsWith('.svelte')) {
        text = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
          .map((m) => m[1])
          .join('\n');
      }
      if (!text.includes('@happyvertical/smrt-core')) continue;
      const sf = ts.createSourceFile(
        relative(PACKAGES_DIR, file),
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const node of sf.statements) {
        if (
          !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
          !node.moduleSpecifier ||
          !ts.isStringLiteral(node.moduleSpecifier) ||
          node.moduleSpecifier.text !== '@happyvertical/smrt-core'
        ) {
          continue;
        }
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly
            ? undefined
            : node.importClause?.namedBindings
          : node.isTypeOnly
            ? undefined
            : node.exportClause;
        if (!bindings || !('elements' in bindings)) continue;
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          add((element.propertyName ?? element.name).text, pkg);
        }
      }
    }
  }
  return byName;
}

describe('workspace imports from the package root (#3614)', () => {
  const imported = collectRootValueImports();

  it('finds the model-package imports the scan is meant to cover', () => {
    expect(imported.get('field')?.has('inventory')).toBe(true);
    expect(imported.get('crossPackageRef')?.has('commerce')).toBe(true);
    expect(imported.get('resolveDatabase')?.has('inventory')).toBe(true);
  });

  it('resolves every imported value from the browser entry or lists it as node-only', () => {
    const unreachable = [...imported.entries()]
      .filter(
        ([name]) =>
          !browserNames.has(name) && !BROWSER_ENTRY_NODE_ONLY.has(name),
      )
      .map(([name, pkgs]) => `${name} (${[...pkgs].sort().join(', ')})`);
    expect(unreachable).toEqual([]);
  });
});
