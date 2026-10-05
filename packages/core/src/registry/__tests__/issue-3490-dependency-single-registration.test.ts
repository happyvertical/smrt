/**
 * #3490: a dependency's class is registered once, under its own package.
 *
 * An app consuming `@happyvertical/smrt-chat` (which brings
 * `@happyvertical/smrt-agents`) ended up with `AgentConfig` registered twice:
 * the real class under the app's package and a manifest stub under
 * smrt-agents. `MCPGenerator.generateTools()` then built `agentconfig_list`
 * twice and every `tools/list` on the app's `/mcp` failed. Two independent
 * paths produced the app-attributed registration:
 *
 * - `smrt app dev`: the Vite module runner reports dependency frames with a
 *   `?v=<hash>` query (`.../dist/chunks/x.js?v=030af238:151:143`). The stack
 *   walk rejected those frames and fell through to the first query-free frame
 *   below them — the app's generated `.smrt/register.js` — so every dependency
 *   class it evaluated was attributed to the app.
 * - `smrt app build`: the server bundle inlines the dependency, so the stack
 *   names the bundle's package. A class whose chunk evaluates before its
 *   package's `__smrt-register__` (smrt-agents' `AgentConfig` lives in a
 *   shared chunk the package index imports first) found no manifest stub to
 *   adopt; when the manifest then registered, it added a stub beside it.
 *
 * Invariant: a constructor occupies one registry entry, and a bundle-derived
 * identity (the stack's package in bundled output, unconfirmed by any
 * manifest or explicit registration) is provisional — the declaring package's
 * manifest adopts that registration rather than registering a second entry.
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

/** A fixture module declaring `class <name> extends <parent>`. */
function subclassModule(className: string, config: Record<string, unknown>) {
  return [
    'export function define({ smrt }, Parent) {',
    `  return smrt(${JSON.stringify(config)})(class ${className} extends Parent {});`,
    '}',
    '',
  ].join('\n');
}

const APP = '@fixture/app3490';
const AGENTS = '@fixture/agents3490';
const OTHER = '@fixture/other3490';

const entriesNamed = (className: string) =>
  [...ObjectRegistry.getAllClasses()].filter(
    ([, info]) => info.name === className,
  );

const isStub = (ctor: unknown) =>
  (ctor as { _isManifestStub?: boolean })._isManifestStub === true;

/** The dependency's inline manifest, as its `__smrt-register__` registers it. */
function registerAgentsManifest(objects: Record<string, unknown>) {
  return ObjectRegistry.registerPackageManifest({
    version: '1',
    timestamp: 0,
    packageName: AGENTS,
    objects,
  } as unknown as Parameters<typeof ObjectRegistry.registerPackageManifest>[0]);
}

function agentsEntry(className: string, tableName: string) {
  return {
    ...manifestEntry({
      className,
      packageName: AGENTS,
      // Build-time source path from the dependency's CI checkout: never the
      // file the class loads from in a consumer.
      filePath: `/home/runner/work/smrt/smrt/packages/agents/src/${className}.ts`,
      tableName,
      fields: { agentId: { type: 'text' } },
    }),
    decoratorConfig: { tableName, mcp: { include: ['list', 'get'] } },
  };
}

describe('#3490: dependency classes register once, under their own package', () => {
  let ws: ConsumerWorkspace;
  let installedCore: string;
  let previousCwd: string;
  let restoreRegistry: () => void;
  const chunk = (name: string) =>
    ws.path(`apps/app/build/server/chunks/${name}.js`);

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
    // The production server bundle: the dependency's classes inlined into the
    // app's own output.
    ws.writeModel(
      'apps/app/build/server/chunks/agent-config.js',
      'AgentConfig',
      {
        tableName: 'agent_configs',
        mcp: { include: ['list', 'get'] },
      },
    );
    ws.writeModel(
      'apps/app/build/server/chunks/agent-document.js',
      'AgentDocument',
      {
        tableStrategy: 'sti',
        tableName: 'agent_documents',
      },
    );
    ws.write(
      'apps/app/build/server/chunks/agent-brief.js',
      subclassModule('AgentBrief', { tableStrategy: 'sti' }),
    );
    // The app's own class that shares a dependency class's simple name.
    ws.writeModel('apps/app/build/server/chunks/app-ledger.js', 'Ledger', {
      tableName: 'app_ledgers',
    });
    ws.writeModel('apps/app/build/server/chunks/app-journal.js', 'Journal', {
      tableName: 'journals',
    });
    ws.writeModel('apps/app/src/models/Register.js', 'Register', {
      tableName: 'registers',
    });
    // The installed dependency's own dist, loaded unbundled.
    ws.writeModel(
      `node_modules/.pnpm/@fixture+agents3490@1.0.0/node_modules/${AGENTS}/dist/chunks/schedule.js`,
      'AgentSchedule',
      { tableName: 'agent_schedules' },
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
    for (const pkg of [APP, AGENTS, OTHER]) getManifestCache().delete(pkg);
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

  describe('production bundle evaluates a class before its package manifest (smrt app build)', () => {
    it('adopts the bundled registration instead of adding a stub beside it', async () => {
      const AgentConfig = await defineFrom(chunk('agent-config'));
      // Bundled output: the stack names the bundle's package, provisionally.
      expect(
        ObjectRegistry.getClassByConstructor(AgentConfig)?.qualifiedName,
      ).toBe(`${APP}:AgentConfig`);

      registerAgentsManifest({
        [`${AGENTS}:AgentConfig`]: agentsEntry('AgentConfig', 'agent_configs'),
      });

      const entries = entriesNamed('AgentConfig');
      expect(entries.map(([key]) => key)).toEqual([`${AGENTS}:AgentConfig`]);
      const [[, info]] = entries;
      expect(info.constructor).toBe(AgentConfig);
      expect(isStub(info.constructor)).toBe(false);
      expect(info.packageName).toBe(AGENTS);
      expect(info.fields.has('agentId')).toBe(true);
      expect(
        ObjectRegistry.getClassByConstructor(AgentConfig)?.qualifiedName,
      ).toBe(`${AGENTS}:AgentConfig`);
      expect(ObjectRegistry.getClass(`${APP}:AgentConfig`)).toBeUndefined();
      expect(
        ObjectRegistry.getClass(`${AGENTS}:AgentConfig`)?.constructor,
      ).toBe(AgentConfig);

      // The generated catalog lists the class once.
      const tools = await new MCPGenerator().generateTools();
      expect(
        tools.filter((tool) => tool.name === 'agentconfig_list'),
      ).toHaveLength(1);
    });

    it('re-attributes an STI base and subtype, so the discriminator names the dependency', async () => {
      const AgentDocument = await defineFrom(chunk('agent-document'));
      const AgentBrief = await defineFrom(chunk('agent-brief'), AgentDocument);
      expect(
        ObjectRegistry.getClassByConstructor(AgentBrief)?.qualifiedName,
      ).toBe(`${APP}:AgentBrief`);

      registerAgentsManifest({
        [`${AGENTS}:AgentDocument`]: {
          ...agentsEntry('AgentDocument', 'agent_documents'),
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'agent_documents',
          },
        },
        [`${AGENTS}:AgentBrief`]: {
          ...agentsEntry('AgentBrief', 'agent_documents'),
          extends: 'AgentDocument',
          collection: 'agent_documents',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'agent_documents',
          },
        },
      });

      for (const [ctor, name] of [
        [AgentDocument, 'AgentDocument'],
        [AgentBrief, 'AgentBrief'],
      ] as const) {
        expect(entriesNamed(name).map(([key]) => key)).toEqual([
          `${AGENTS}:${name}`,
        ]);
        expect(ObjectRegistry.getClassByConstructor(ctor)?.constructor).toBe(
          ctor,
        );
      }
      // `_meta_type` is the qualified name registered for the instance's
      // constructor (`SmrtObject.getResolvedQualifiedName()`).
      expect(
        ObjectRegistry.getClassByConstructor(AgentBrief)?.qualifiedName,
      ).toBe(`${AGENTS}:AgentBrief`);
      expect(ObjectRegistry.getSTIBase(`${AGENTS}:AgentBrief`)).toBe(
        `${AGENTS}:AgentDocument`,
      );
    });

    it("keeps the app's own same-named class on another table (#3106)", async () => {
      const Ledger = await defineFrom(chunk('app-ledger'));
      registerAgentsManifest({
        [`${AGENTS}:Ledger`]: agentsEntry('Ledger', 'agent_ledgers'),
      });

      expect(ObjectRegistry.getClassByConstructor(Ledger)?.qualifiedName).toBe(
        `${APP}:Ledger`,
      );
      const keys = entriesNamed('Ledger').map(([key]) => key);
      expect(keys.sort()).toEqual([`${AGENTS}:Ledger`, `${APP}:Ledger`].sort());
    });

    it('never re-attributes a class its package confirmed explicitly', async () => {
      const Journal = await defineFrom(chunk('app-journal'));
      ObjectRegistry.register(Journal as never, {
        name: 'Journal',
        packageName: APP,
        tableName: 'journals',
      });
      registerAgentsManifest({
        [`${AGENTS}:Journal`]: agentsEntry('Journal', 'journals'),
      });

      expect(ObjectRegistry.getClassByConstructor(Journal)?.qualifiedName).toBe(
        `${APP}:Journal`,
      );
      expect(ObjectRegistry.getClass(`${APP}:Journal`)?.constructor).toBe(
        Journal,
      );
    });

    it('never re-attributes a class declared outside bundled output', async () => {
      const Register = await defineFrom(
        ws.path('apps/app/src/models/Register.js'),
      );
      registerAgentsManifest({
        [`${AGENTS}:Register`]: agentsEntry('Register', 'registers'),
      });

      expect(
        ObjectRegistry.getClassByConstructor(Register)?.qualifiedName,
      ).toBe(`${APP}:Register`);
    });

    it("keeps a class its own package's manifest confirmed, whatever manifest arrives later", async () => {
      const AgentSchedule = await defineFrom(
        ws.path(
          `node_modules/.pnpm/@fixture+agents3490@1.0.0/node_modules/${AGENTS}/dist/chunks/schedule.js`,
        ),
      );
      registerAgentsManifest({
        [`${AGENTS}:AgentSchedule`]: agentsEntry(
          'AgentSchedule',
          'agent_schedules',
        ),
      });
      ObjectRegistry.registerPackageManifest({
        version: '1',
        timestamp: 0,
        packageName: OTHER,
        objects: {
          [`${OTHER}:AgentSchedule`]: {
            ...agentsEntry('AgentSchedule', 'agent_schedules'),
            packageName: OTHER,
            qualifiedName: `${OTHER}:AgentSchedule`,
          },
        },
      } as unknown as Parameters<
        typeof ObjectRegistry.registerPackageManifest
      >[0]);

      expect(
        ObjectRegistry.getClassByConstructor(AgentSchedule)?.qualifiedName,
      ).toBe(`${AGENTS}:AgentSchedule`);
      expect(
        ObjectRegistry.getClass(`${AGENTS}:AgentSchedule`)?.constructor,
      ).toBe(AgentSchedule);
    });
  });
});
