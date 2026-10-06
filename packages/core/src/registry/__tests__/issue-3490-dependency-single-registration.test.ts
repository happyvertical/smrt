/**
 * #3490: a dependency's class is registered once, under its own package, and
 * an application class is never re-attributed to a dependency.
 *
 * An app consuming `@happyvertical/smrt-chat` (which brings
 * `@happyvertical/smrt-agents`) ended up with `AgentConfig` registered twice:
 * the real class under the app's package and a manifest stub under
 * smrt-agents, so `MCPGenerator.generateTools()` built `agentconfig_list`
 * twice and every `tools/list` on the app's `/mcp` failed.
 *
 * - `smrt app dev`: the Vite module runner reports dependency frames with a
 *   `?v=<hash>` query. The stack walk rejected those frames and fell through
 *   to the app's own `.smrt/register.js` below them.
 * - `smrt app build`: the server bundle inlines the dependency, so the stack
 *   names the app's package, and the bundler can order a class's chunk before
 *   its package's `__smrt-register__`.
 *
 * Identity in a bundle is constructor-bound: a package's library build stamps
 * each decorated class it declares with `static __smrtPackage__`, which the
 * registry reads when the class is decorated, and the package's manifest
 * records `stampsConstructors`. An unstamped class that only shares a simple
 * name and table with such a package's class is never that class, in either
 * registration order (an application class must keep the application's
 * identity).
 */
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { MCPGenerator } from '../../generators/mcp.js';
import { getPackageName } from '../../manifest/manifest-loader.js';
import { getManifestCache } from '../../manifest/store.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getSourceFileFromStack } from '../shared-state.js';
import type { SmrtObjectConstructor } from '../types.js';
import {
  type ConsumerWorkspace,
  createConsumerWorkspace,
  manifestEntry,
} from './helpers/consumer-workspace.js';

type Deps = { smrt: typeof smrt; SmrtObject: typeof SmrtObject };
type Define = (deps: Deps, parent: typeof SmrtObject) => typeof SmrtObject;

async function defineFrom(
  file: string,
  parent: typeof SmrtObject = SmrtObject,
): Promise<typeof SmrtObject> {
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as { define: Define };
  return module.define({ smrt, SmrtObject }, parent);
}

/**
 * A fixture module declaring `class <name> extends <parent>`, stamped with
 * `stampedBy` the way a library build stamps its own classes.
 */
function classModule(
  className: string,
  config: Record<string, unknown>,
  stampedBy?: string,
) {
  const stamp = stampedBy
    ? ` static __smrtPackage__ = ${JSON.stringify(stampedBy)};`
    : '';
  return [
    'export function define({ smrt }, Parent) {',
    `  return smrt(${JSON.stringify(config)})(class ${className} extends Parent {${stamp}});`,
    '}',
    '',
  ].join('\n');
}

const APP = '@fixture/app3490';
const AGENTS = '@fixture/agents3490';
const LEGACY = '@fixture/legacy3490';
const EXPLICIT = '@fixture/explicit3490';
const DISCOVERED = '@happyvertical/smrt-fixture3490';
const RELOADED = '@fixture/reloaded3490';

const keysNamed = (className: string) =>
  [...ObjectRegistry.getAllClasses()]
    .filter(([, info]) => info.name === className)
    .map(([key]) => key)
    .sort();

const isStub = (ctor: unknown) =>
  (ctor as { _isManifestStub?: boolean })._isManifestStub === true;

function registerManifest(
  packageName: string,
  objects: Record<string, unknown>,
  stampsConstructors = true,
) {
  return ObjectRegistry.registerPackageManifest({
    version: '1',
    timestamp: 0,
    packageName,
    ...(stampsConstructors ? { stampsConstructors: true } : {}),
    objects,
  } as unknown as Parameters<typeof ObjectRegistry.registerPackageManifest>[0]);
}

function entryFor(
  packageName: string,
  className: string,
  tableName: string,
  extra: Record<string, unknown> = {},
) {
  return {
    [`${packageName}:${className}`]: {
      ...manifestEntry({
        className,
        packageName,
        // Build-time source path from the dependency's CI checkout: never
        // the file the class loads from in a consumer.
        filePath: `/home/runner/work/smrt/smrt/packages/agents/src/${className}.ts`,
        tableName,
        fields: { agentId: { type: 'text' } },
      }),
      decoratorConfig: { tableName, mcp: { include: ['list', 'get'] } },
      ...extra,
    },
  };
}

describe('#3490: dependency classes register once, under their own package', () => {
  let ws: ConsumerWorkspace;
  let installedCore: string;
  let previousCwd: string;
  let restoreRegistry: () => void;
  const chunk = (name: string) =>
    ws.path(`apps/app/build/server/chunks/${name}.js`);
  const bundled = (
    name: string,
    className: string,
    config: Record<string, unknown>,
    stampedBy?: string,
  ) =>
    ws.write(
      `apps/app/build/server/chunks/${name}.js`,
      classModule(className, config, stampedBy),
    );

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3490-consumer');
    installedCore =
      'node_modules/.pnpm/@happyvertical+smrt-core@0.53.5_x/node_modules/@happyvertical/smrt-core';
    ws.writePackage(installedCore, '@happyvertical/smrt-core');
    ws.writePackage('apps/app', APP);
    ws.write('apps/app/.smrt/register.js', '');
    ws.writePackage(
      `node_modules/.pnpm/@fixture+agents3490@1.0.0/node_modules/${AGENTS}`,
      AGENTS,
    );
    // The production server bundle: the dependency's stamped classes inlined
    // into the app's own output, beside the app's own (unstamped) classes.
    const agentConfig = {
      tableName: 'agent_configs',
      mcp: { include: ['list', 'get'] },
    };
    bundled('agent-config', 'AgentConfig', agentConfig, AGENTS);
    bundled(
      'agent-config-late',
      'AgentConfigLate',
      { tableName: 'agent_configs_late' },
      AGENTS,
    );
    bundled(
      'agent-document',
      'AgentDocument',
      { tableStrategy: 'sti', tableName: 'agent_documents' },
      AGENTS,
    );
    bundled('agent-brief', 'AgentBrief', { tableStrategy: 'sti' }, AGENTS);
    bundled('app-ledger-first', 'LedgerFirst', { tableName: 'ledgers_first' });
    bundled('app-ledger-second', 'LedgerSecond', {
      tableName: 'ledgers_second',
    });
    bundled('app-extends-agent', 'AppAgentConfig', {});
    bundled('legacy-widget', 'LegacyWidget', { tableName: 'legacy_widgets' });
    bundled('app-ledger-explicit', 'LedgerExplicit', {
      tableName: 'ledgers_explicit',
    });
    bundled('app-ledger-discovered', 'LedgerDiscovered', {
      tableName: 'ledgers_discovered',
    });
    bundled('reloaded-widget', 'ReloadedWidget', {
      tableName: 'reloaded_widgets',
    });
    // Stamping manifests reached only through `loadAllManifests()`: an
    // explicit path, and an installed package the auto-discovery finds.
    ws.write(
      'manifests/explicit.json',
      JSON.stringify({
        version: '1',
        timestamp: 0,
        packageName: EXPLICIT,
        stampsConstructors: true,
        objects: entryFor(EXPLICIT, 'LedgerExplicit', 'ledgers_explicit'),
      }),
    );
    ws.write(
      `apps/app/node_modules/${DISCOVERED}/package.json`,
      JSON.stringify({
        name: DISCOVERED,
        exports: { './manifest.json': './dist/manifest.json' },
      }),
    );
    ws.write(
      `apps/app/node_modules/${DISCOVERED}/dist/manifest.json`,
      JSON.stringify({
        version: '1',
        timestamp: 0,
        packageName: DISCOVERED,
        stampsConstructors: true,
        objects: entryFor(DISCOVERED, 'LedgerDiscovered', 'ledgers_discovered'),
      }),
    );
    previousCwd = process.cwd();
    process.chdir(ws.path('apps/app'));
  });

  afterAll(() => {
    process.chdir(previousCwd);
    ws.dispose();
  });

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
    for (const pkg of [APP, AGENTS, LEGACY, EXPLICIT, DISCOVERED, RELOADED]) {
      getManifestCache().delete(pkg);
    }
  });

  describe('dev server frames carry a module-runner query (smrt app dev)', () => {
    // The stack `smrt app dev` produced registering smrt-agents' AgentConfig
    // on 0.53.5, reduced to the frames the walk reads.
    const devStack = (query: string) => {
      const chunkPath = ws.path(
        `node_modules/.pnpm/@fixture+agents3490@1.0.0/node_modules/${AGENTS}/dist/chunks/execute-as-principal-DtwCUq2t.js`,
      );
      const runner = ws.path(
        'node_modules/.pnpm/vite@8.3.0/node_modules/vite/dist/node/module-runner.js',
      );
      return [
        'Error',
        `    at getPackageName (file://${ws.path(installedCore, 'dist/manifest/manifest-loader.js')}:314:58)`,
        `    at registerUntracked (file://${ws.path(installedCore, 'dist/registry/class-registration.js')}:552:58)`,
        `    at ObjectRegistry.register (file://${ws.path(installedCore, 'dist/registry.js')}:665:3)`,
        `    at file://${ws.path(installedCore, 'dist/registry.js')}:2755:19`,
        `    at __decorateClass (${chunkPath}${query}:32:143)`,
        `    at eval (${chunkPath}${query}:133:15)`,
        `    at async ESModulesEvaluator.runInlinedModule (file://${runner}:809:3)`,
        `    at async eval (${ws.path('apps/app/.smrt/register.js')}:6:31)`,
      ].join('\n');
    };

    it.each([
      ['?v=030af238'],
      ['?t=1791123514710'],
      ['?v=030af238&import'],
      [''],
    ])('attributes a dependency frame with query %j to the dependency', (query) => {
      const stack = devStack(query);
      expect(
        getPackageName(
          class AgentConfig {} as unknown as SmrtObjectConstructor,
          true,
          stack,
        ),
      ).toBe(AGENTS);
      expect(getSourceFileFromStack(stack)).toBe(
        ws.path(
          `node_modules/.pnpm/@fixture+agents3490@1.0.0/node_modules/${AGENTS}/dist/chunks/execute-as-principal-DtwCUq2t.js`,
        ),
      );
    });
  });

  describe('production bundle (smrt app build)', () => {
    it('registers a stamped dependency class decorated before its manifest once, under the dependency', async () => {
      const AgentConfig = await defineFrom(chunk('agent-config'));
      expect(keysNamed('AgentConfig')).toEqual([`${AGENTS}:AgentConfig`]);

      registerManifest(
        AGENTS,
        entryFor(AGENTS, 'AgentConfig', 'agent_configs'),
      );

      expect(keysNamed('AgentConfig')).toEqual([`${AGENTS}:AgentConfig`]);
      const info = ObjectRegistry.getClass(`${AGENTS}:AgentConfig`);
      expect(info?.constructor).toBe(AgentConfig);
      expect(isStub(info?.constructor)).toBe(false);
      expect(info?.fields.has('agentId')).toBe(true);
      const tools = await new MCPGenerator().generateTools();
      expect(
        tools.filter((tool) => tool.name === 'agentconfig_list'),
      ).toHaveLength(1);
    });

    it('registers a stamped dependency class decorated after its manifest once, under the dependency', async () => {
      registerManifest(
        AGENTS,
        entryFor(AGENTS, 'AgentConfigLate', 'agent_configs_late'),
      );
      const AgentConfigLate = await defineFrom(chunk('agent-config-late'));

      expect(keysNamed('AgentConfigLate')).toEqual([
        `${AGENTS}:AgentConfigLate`,
      ]);
      const info = ObjectRegistry.getClassByConstructor(AgentConfigLate);
      expect(info?.qualifiedName).toBe(`${AGENTS}:AgentConfigLate`);
      expect(isStub(info?.constructor)).toBe(false);
    });

    it('keeps a stamped STI base and subtype under the dependency, so the discriminator names it', async () => {
      const AgentDocument = await defineFrom(chunk('agent-document'));
      const AgentBrief = await defineFrom(chunk('agent-brief'), AgentDocument);
      registerManifest(AGENTS, {
        ...entryFor(AGENTS, 'AgentDocument', 'agent_documents', {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'agent_documents',
          },
        }),
        ...entryFor(AGENTS, 'AgentBrief', 'agent_documents', {
          extends: 'AgentDocument',
          collection: 'agent_documents',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'agent_documents',
          },
        }),
      });

      for (const [ctor, name] of [
        [AgentDocument, 'AgentDocument'],
        [AgentBrief, 'AgentBrief'],
      ] as const) {
        expect(keysNamed(name)).toEqual([`${AGENTS}:${name}`]);
        // `_meta_type` is the qualified name registered for the constructor.
        expect(ObjectRegistry.getClassByConstructor(ctor)?.qualifiedName).toBe(
          `${AGENTS}:${name}`,
        );
      }
      expect(ObjectRegistry.getSTIBase(`${AGENTS}:AgentBrief`)).toBe(
        `${AGENTS}:AgentDocument`,
      );
    });

    it("never re-attributes an app class sharing a dependency entry's name and table (app class first)", async () => {
      const Ledger = await defineFrom(chunk('app-ledger-first'));
      registerManifest(
        AGENTS,
        entryFor(AGENTS, 'LedgerFirst', 'ledgers_first'),
      );

      expect(ObjectRegistry.getClassByConstructor(Ledger)?.qualifiedName).toBe(
        `${APP}:LedgerFirst`,
      );
      expect(ObjectRegistry.getClass(`${APP}:LedgerFirst`)?.constructor).toBe(
        Ledger,
      );
      expect(
        isStub(ObjectRegistry.getClass(`${AGENTS}:LedgerFirst`)?.constructor),
      ).toBe(true);
    });

    it("never re-attributes an app class sharing a dependency entry's name and table (manifest first)", async () => {
      registerManifest(
        AGENTS,
        entryFor(AGENTS, 'LedgerSecond', 'ledgers_second'),
      );
      const Ledger = await defineFrom(chunk('app-ledger-second'));

      const info = ObjectRegistry.getClassByConstructor(Ledger);
      expect(info?.qualifiedName).toBe(`${APP}:LedgerSecond`);
      // Nor does it take the dependency entry's fields.
      expect(info?.fields.has('agentId')).toBe(false);
      expect(
        isStub(ObjectRegistry.getClass(`${AGENTS}:LedgerSecond`)?.constructor),
      ).toBe(true);
    });

    it('does not let an app subclass inherit the dependency stamp', async () => {
      const AgentConfig = await defineFrom(chunk('agent-config'));
      const AppAgentConfig = await defineFrom(
        chunk('app-extends-agent'),
        AgentConfig,
      );
      expect(
        ObjectRegistry.getClassByConstructor(AppAgentConfig)?.qualifiedName,
      ).toBe(`${APP}:AppAgentConfig`);
    });

    it('keeps the earlier bundled-duplicate adoption for a package built before stamping', async () => {
      // A manifest without `stampsConstructors` comes from a build whose
      // classes carry no stamp; its bundled class still adopts its stub.
      registerManifest(
        LEGACY,
        entryFor(LEGACY, 'LegacyWidget', 'legacy_widgets'),
        false,
      );
      const LegacyWidget = await defineFrom(chunk('legacy-widget'));
      expect(
        ObjectRegistry.getClassByConstructor(LegacyWidget)?.qualifiedName,
      ).toBe(`${LEGACY}:LegacyWidget`);
    });
  });

  describe('stamping capability travels with the stored manifest', () => {
    it.each([
      [
        'an explicit manifest path',
        () =>
          ObjectRegistry.loadAllManifests({
            manifestPaths: [ws.path('manifests/explicit.json')],
          }),
        'app-ledger-explicit',
        'LedgerExplicit',
        EXPLICIT,
      ],
      [
        'auto-discovery of installed packages',
        () => ObjectRegistry.loadAllManifests(),
        'app-ledger-discovered',
        'LedgerDiscovered',
        DISCOVERED,
      ],
    ])('keeps an app class its identity beside a stamping manifest loaded through %s', async (_label, load, file, className, dependency) => {
      expect(load().objectsRegistered).toBeGreaterThanOrEqual(1);
      const Ledger = await defineFrom(chunk(file));

      expect(ObjectRegistry.getClassByConstructor(Ledger)?.qualifiedName).toBe(
        `${APP}:${className}`,
      );
      expect(
        isStub(
          ObjectRegistry.getClass(`${dependency}:${className}`)?.constructor,
        ),
      ).toBe(true);
    });

    it('treats a later legacy manifest as legacy after the registry is cleared', async () => {
      registerManifest(
        RELOADED,
        entryFor(RELOADED, 'ReloadedWidget', 'reloaded_widgets'),
      );
      ObjectRegistry.clear();
      registerManifest(
        RELOADED,
        entryFor(RELOADED, 'ReloadedWidget', 'reloaded_widgets'),
        false,
      );
      const ReloadedWidget = await defineFrom(chunk('reloaded-widget'));
      // Legacy: the bundled class adopts the package's stub, as before.
      expect(
        ObjectRegistry.getClassByConstructor(ReloadedWidget)?.qualifiedName,
      ).toBe(`${RELOADED}:ReloadedWidget`);
    });
  });
});
