/**
 * Capability classification conformance fixture (#2587).
 *
 * Proves core's emission and smrt-web's registrar agree on ONE classification
 * rule, using the real generation path (OxcScanner + ManifestAdapter +
 * ManifestGenerator + the core web-collections builders) rather than a
 * hand-typed copy of either switch — see packages/smrt-web/AGENTS.md "WebMCP
 * integration fixture" for the pattern this file follows, and
 * `@happyvertical/smrt-types` (`capability.ts`) for the documented contract
 * this fixture enforces.
 *
 * This must fail if:
 *  - core's `toolSemantics()` (packages/core/src/generators/tool-schema.ts)
 *    drifts from the documented CRUD table, or its fail-closed custom-action
 *    default drifts from the smrt-types documented rule;
 *  - smrt-web's `actionSemantics()` legacy fallback (webmcp.ts) drifts from
 *    that same table or default;
 *  - smrt-web starts recomputing classification for a canonical definition
 *    instead of trusting the emitted `effect` / `idempotent` / `openWorld`.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildWebCollectionDefinition,
  buildWebMcpToolDefinitions,
  buildWebToolDescriptors,
  selectWebCollectionEntries,
} from '../../../packages/core/src/vite-plugin/web-collections.js';
import type {
  SmrtCrudFetchers,
  SmrtWebCollectionDefinition,
  WebMcpToolDefinition,
  WebToolDescriptor,
} from './index.js';
import { registerWebMcpTools } from './webmcp.js';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'run', 'peek'],
    routes: {
      run: { method: 'POST', scope: 'item', path: 'run' },
      // Partial declaration — only `effect` is declared, `idempotent` and
      // `openWorld` are omitted. Proves per-field fail-closed defaulting
      // (#2587 codex finding): a declared 'read' effect does NOT imply
      // idempotent, so the omitted fields must resolve independently to
      // `false` / `true` rather than being inferred from `effect`.
      peek: { method: 'GET', effect: 'read' },
    },
  },
})
class CapabilityFixtureItem extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  constructor(options: { name?: string } = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }

  /**
   * Deliberately undeclared effect metadata — no `tool`/`effect` config in
   * the `@smrt()` api block above. Proves the fail-closed default: an
   * undeclared capability resolves to
   * `{ effect: 'destructive', idempotent: false, openWorld: true }`.
   */
  async run(options: { value?: string } = {}) {
    return { accepted: options.value ?? 'default' };
  }

  /**
   * Declares `effect: 'read'` only — `idempotent`/`openWorld` are left for
   * the fail-closed per-field default to resolve. See the `routes.peek`
   * config above.
   */
  async peek(options: { value?: string } = {}) {
    return { seen: options.value ?? 'default' };
  }
}

interface CapturedAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface CapturedTool {
  name: string;
  annotations?: CapturedAnnotations;
}

/**
 * The one capability table this fixture enforces (mirrors the JSDoc on
 * `CapabilityClassification` in `@happyvertical/smrt-types`). `run` is the
 * undeclared custom action, so its row IS the fail-closed default. `peek`
 * PARTIALLY declares its classification (`effect: 'read'` only), so its row
 * proves the per-field fail-closed default applies independently to the
 * omitted `idempotent`/`openWorld` fields instead of being inferred from the
 * declared `effect`.
 */
const EXPECTED: Record<
  'list' | 'get' | 'create' | 'update' | 'delete' | 'run' | 'peek',
  { readOnlyHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
> = {
  list: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  get: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  create: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  update: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  delete: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  run: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  peek: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
};

function stubFetchers(): SmrtCrudFetchers {
  return {
    list: async () => [],
    get: async (id: string) => ({ id }),
    create: async (data) => ({ id: 'created', ...data }),
    update: async (id, data) => ({ id, ...data }),
    delete: async () => true,
    custom: async (action, args) => ({ action, args }),
  };
}

function installModelContext(): { tools: CapturedTool[] } {
  const tools: CapturedTool[] = [];
  (globalThis as { document?: unknown }).document = {
    modelContext: {
      registerTool(tool: CapturedTool) {
        tools.push(tool);
      },
    },
  };
  return { tools };
}

describe('WebMCP capability classification conformance (#2587)', () => {
  const originalDocument = (globalThis as { document?: unknown }).document;
  let canonicalDefinitions: WebMcpToolDefinition[];
  let legacyDefinition: SmrtWebCollectionDefinition;

  beforeAll(async () => {
    // Use the same AST manifest builder that emits the production virtual web
    // module (matches webmcp-e2e.integration.test.ts). The fixture must
    // exercise generated descriptors, not a hand-typed approximation.
    const scanner = new OxcScanner({
      cwd: process.cwd(),
      include: ['src/webmcp-capability-classification.integration.test.ts'],
      exclude: [],
      followImports: true,
      baseClasses: ['SmrtObject', 'SmrtCollection'],
      includeStaticMethods: true,
    });
    const { results, resolved } = await scanner.scanAndResolve();
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@fixture/smrt-web-capability',
      typeAliases: results.typeAliases,
    });
    new ManifestGenerator().applyGenerationPasses(manifest, {
      packageName: '@fixture/smrt-web-capability',
    });

    // Ground truth: core's real classification switch (`toolSemantics()` in
    // tool-schema.ts), reached through the same builder the web virtual
    // module calls (`buildWebMcpToolDefinitions`).
    canonicalDefinitions = buildWebMcpToolDefinitions(manifest).filter(
      (definition) => definition.collection === 'capabilityfixtureitems',
    );
    expect(canonicalDefinitions.map((d) => d.action).sort()).toEqual(
      Object.keys(EXPECTED).sort(),
    );

    const entry = selectWebCollectionEntries(manifest).find(
      (candidate) => candidate.collection === 'capabilityfixtureitems',
    );
    if (!entry) {
      throw new Error('fixture collection entry was not generated');
    }
    const definition = buildWebCollectionDefinition(entry, manifest);
    // `generateWebModule` layers tool descriptors onto the definition
    // separately (core's vite-plugin/index.ts, #1764) — mirror that exact
    // composition here instead of driving the full Vite plugin.
    legacyDefinition = {
      ...definition,
      toolDescriptors: buildWebToolDescriptors(entry) as WebToolDescriptor[],
    };
    expect(
      legacyDefinition.toolDescriptors?.map((d) => d.action).sort(),
    ).toEqual(Object.keys(EXPECTED).sort());
  });

  afterEach(() => {
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  it('core emits the documented fail-closed CRUD + custom-action classification', () => {
    for (const action of Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]) {
      const definition = canonicalDefinitions.find((d) => d.action === action);
      if (!definition) throw new Error(`missing generated action ${action}`);
      expect({
        readOnlyHint: definition.effect === 'read',
        idempotentHint: definition.idempotent,
        openWorldHint: definition.openWorld,
      }).toEqual(EXPECTED[action]);
    }
  });

  it('smrt-web trusts emitted metadata for canonical definitions instead of recomputing it', async () => {
    const { tools } = installModelContext();
    // Corrupt `list`'s emitted metadata to values core's CRUD switch would
    // never produce for `list`. If smrt-web still classified canonical
    // definitions by action name (the #2587 bug), this tampered value would
    // be silently discarded and the tool would register under 'read' anyway.
    const listDefinition = canonicalDefinitions.find(
      (d) => d.action === 'list',
    );
    if (!listDefinition) throw new Error('fixture list definition missing');
    const tampered: WebMcpToolDefinition = {
      ...listDefinition,
      effect: 'destructive',
      idempotent: false,
      openWorld: true,
    };

    const excludedFromRead = registerWebMcpTools([tampered], {
      effects: ['read'],
      resolveToolFetchers: () => stubFetchers(),
    });
    await excludedFromRead.ready;
    expect(tools).toHaveLength(0);
    excludedFromRead();

    const includedAsDestructive = registerWebMcpTools([tampered], {
      effects: ['destructive'],
      resolveToolFetchers: () => stubFetchers(),
    });
    await includedAsDestructive.ready;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      untrustedContentHint: true,
    });
    includedAsDestructive();
  });

  it('legacy fallback classification agrees with core emission for every CRUD action and the undeclared custom action', async () => {
    const { tools } = installModelContext();
    // Simulate a hand-authored legacy definition carrying NO metadata
    // (#2587): strip the optional fields a generated definition would
    // otherwise carry, forcing smrt-web's actionSemantics() CRUD switch and
    // its fail-closed default for the custom action. `peek` is excluded
    // here — stripping its declared `effect` too is indistinguishable from
    // `run`'s fully undeclared case, so it is covered by the dedicated
    // partial-declaration test below instead.
    const strippedDescriptors = legacyDefinition.toolDescriptors?.map(
      (descriptor) => {
        const {
          effect: _effect,
          idempotent: _idempotent,
          openWorld: _openWorld,
          ...rest
        } = descriptor;
        return rest as WebToolDescriptor;
      },
    );
    const strippedDefinition: SmrtWebCollectionDefinition = {
      ...legacyDefinition,
      toolDescriptors: strippedDescriptors,
    };

    const registration = registerWebMcpTools([strippedDefinition], {
      effects: ['read', 'write', 'destructive'],
      resolveFetchers: () => stubFetchers(),
    });
    await registration.ready;

    const strippedActions = (
      Object.keys(EXPECTED) as (keyof typeof EXPECTED)[]
    ).filter((action) => action !== 'peek');
    for (const action of strippedActions) {
      const tool = tools.find((candidate) =>
        candidate.name.endsWith(`_${action}`),
      );
      if (!tool) {
        throw new Error(
          `legacy fallback tool for ${action} was not registered`,
        );
      }
      const actual = {
        readOnlyHint: tool.annotations?.readOnlyHint,
        idempotentHint: tool.annotations?.idempotentHint,
        openWorldHint: tool.annotations?.openWorldHint,
      };
      // Agrees with the documented smrt-types contract...
      expect(actual).toEqual(EXPECTED[action]);
      // ...AND with core's REAL emission for the same action on the same
      // fixture model, not a hand-typed copy of it.
      const canonical = canonicalDefinitions.find((d) => d.action === action);
      expect(actual).toEqual({
        readOnlyHint: canonical?.effect === 'read',
        idempotentHint: canonical?.idempotent,
        openWorldHint: canonical?.openWorld,
      });
    }

    registration();
  });

  it('legacy fallback resolves a PARTIAL declaration (effect only) with the same per-field default as core (#2587)', async () => {
    const { tools } = installModelContext();
    // `peek` declares only `effect: 'read'` (see routes.peek above). Strip
    // ONLY `idempotent`/`openWorld` — keep the declared `effect` intact, the
    // way a hand-authored legacy definition that copies just the effect
    // would look. This is codex's finding: the original fixture only proved
    // the fully-undeclared case (`run`); it never proved that an omitted
    // `idempotent`/`openWorld` resolves independently of a DECLARED effect.
    const partialDescriptors = legacyDefinition.toolDescriptors?.map(
      (descriptor) => {
        if (descriptor.action !== 'peek') return descriptor;
        const {
          idempotent: _idempotent,
          openWorld: _openWorld,
          ...rest
        } = descriptor;
        return rest as WebToolDescriptor;
      },
    );
    const partialDefinition: SmrtWebCollectionDefinition = {
      ...legacyDefinition,
      toolDescriptors: partialDescriptors,
    };

    const registration = registerWebMcpTools([partialDefinition], {
      effects: ['read', 'write', 'destructive'],
      resolveFetchers: () => stubFetchers(),
    });
    await registration.ready;

    const tool = tools.find((candidate) => candidate.name.endsWith('_peek'));
    if (!tool)
      throw new Error('legacy fallback tool for peek was not registered');
    const actual = {
      readOnlyHint: tool.annotations?.readOnlyHint,
      idempotentHint: tool.annotations?.idempotentHint,
      openWorldHint: tool.annotations?.openWorldHint,
    };
    // Agrees with the documented smrt-types contract...
    expect(actual).toEqual(EXPECTED.peek);
    // ...AND with core's REAL emission for `peek` on the same fixture model.
    const canonical = canonicalDefinitions.find((d) => d.action === 'peek');
    expect(actual).toEqual({
      readOnlyHint: canonical?.effect === 'read',
      idempotentHint: canonical?.idempotent,
      openWorldHint: canonical?.openWorld,
    });

    registration();
  });
});
