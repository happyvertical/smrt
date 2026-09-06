/**
 * Acceptance coverage for issue #2725 — a declared intent whose derived WebMCP
 * tool name is also claimed by a generated model tool.
 * https://github.com/happyvertical/smrt/issues/2725
 *
 * The rule lives in the scanner, which owns `intentToolName`. The INPUT lives
 * here, because only core resolves the exposure policy: `selectWebMcpToolEntries`
 * decides which actions a class actually exposes, and
 * `buildWebMcpToolDefinitions` is the function that emits the runtime
 * `webMcpToolDefinitions`. Passing anything else — every CRUD verb, say — would
 * report collisions against tools that never register.
 *
 * So this test drives the real seam end to end: real sources, a real scan, a
 * real manifest, and `collectAgentSurfaceToolNameCollisions` — the exact
 * function `scanWithOxc` calls. A unit test either side of the seam cannot see
 * whether the names being compared are the ones the build will emit.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAgentSurfaceToolNames,
  ManifestAdapter,
  OxcScanner,
} from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../scanner/index.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { collectAgentSurfaceToolNameCollisions } from './index.js';
import { buildWebMcpToolDefinitions } from './web-collections.js';

let rootDir: string;

/**
 * `Product` exposes the default CRUD set, so the build registers
 * `product_list`. `Report` excludes `list`, so it never registers
 * `report_list` — the difference the exposure policy makes, in one manifest.
 */
const OBJECTS = `import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt()
export class Product extends SmrtObject {
  sku = '';
}

@smrt({ api: { exclude: ['list'] } })
export class Report extends SmrtObject {
  title = '';
}
`;

const INTENTS = `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const productList = defineIntent({
  id: 'product.list',
  description: 'Show the products table',
  target: { registry: 'dataSurface', controlId: 'products', kind: 'table' },
});

export const reportList = defineIntent({
  id: 'report.list',
  description: 'Show the reports table',
  target: { registry: 'dataSurface', controlId: 'reports', kind: 'table' },
});

export const uiShadow = defineIntent({
  id: 'agent.ui.list_form_controls',
  description: 'Shadows a fixed UI tool under a custom prefix',
  target: { registry: 'control', action: 'focus' },
});
`;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'smrt-2725-'));
  mkdirSync(join(rootDir, 'src', 'lib', 'objects'), { recursive: true });
  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: '@example/shop', version: '1.0.0' }),
  );
  writeFileSync(join(rootDir, 'src/lib/objects/models.ts'), OBJECTS);
  writeFileSync(join(rootDir, 'src/lib/shop.intents.ts'), INTENTS);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/** Scan and build the manifest the way `scanWithOxc` does. */
async function scan(): Promise<{
  manifest: SmartObjectManifest;
  surface: NonNullable<
    Awaited<ReturnType<OxcScanner['scanAndResolve']>>['results']['agentSurface']
  >;
}> {
  const { results, resolved } = await new OxcScanner({
    cwd: rootDir,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: '@example/shop',
    packageVersion: '1.0.0',
    typeAliases: results.typeAliases,
  });
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: '@example/shop',
  });
  expect(results.agentSurface).toBeDefined();
  return {
    manifest,
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    surface: results.agentSurface!,
  };
}

/** Exactly what `scanWithOxc` computes, through the same exported function. */
function collisionsFor(
  surface: Awaited<ReturnType<typeof scan>>['surface'],
  manifest: SmartObjectManifest,
  uiToolPrefixes?: readonly string[],
) {
  return collectAgentSurfaceToolNameCollisions({
    surface,
    manifest,
    checkAgentSurfaceToolNames,
    ...(uiToolPrefixes ? { uiToolPrefixes } : {}),
  });
}

describe('#2725 declared intents vs the names the build already registers', () => {
  it('reports the intent that lands on a generated model tool, and only it', async () => {
    const { manifest, surface } = await scan();

    // The exposure policy, stated as evidence rather than assumed: `Product`
    // registers `product_list`; `Report` excludes `list` and does not.
    const names = buildWebMcpToolDefinitions(manifest).map(
      (definition) => definition.name,
    );
    expect(names).toContain('product_list');
    expect(names).not.toContain('report_list');

    const generatedCollisions = collisionsFor(surface, manifest).filter(
      (diagnostic) => diagnostic.message.includes('generated model tool'),
    );

    expect(generatedCollisions).toHaveLength(1);
    expect(generatedCollisions[0].code).toBe('tool-name-collision');
    expect(generatedCollisions[0].message).toContain('`product.list`');
    // `declaredBy` reaches the message from the manifest, not from the scanner.
    expect(generatedCollisions[0].message).toContain('`Product.list`');
    // `report.list` is free precisely because the policy closed `Report.list`.
    expect(generatedCollisions[0].message).not.toContain('report');
  });

  it('records the collision against the declaring module, as `sourceFile`', async () => {
    // The scanner emits `filePath`; the knowledge artifact records
    // `sourceFile`. Core is the one place the two shapes are reconciled, and a
    // diagnostic that lost its location would be unactionable.
    const { manifest, surface } = await scan();

    const collisions = collisionsFor(surface, manifest, ['agent_ui_']);

    expect(collisions.length).toBeGreaterThan(0);
    for (const diagnostic of collisions) {
      expect(diagnostic.sourceFile).toBe('src/lib/shop.intents.ts');
      expect(diagnostic).not.toHaveProperty('filePath');
    }
  });

  it('reports the intent that lands on a fixed UI tool under the configured prefix', async () => {
    const { manifest, surface } = await scan();

    const uiCollisions = collisionsFor(surface, manifest, ['agent_ui_']).filter(
      (diagnostic) => diagnostic.message.includes('ui.prefix'),
    );

    expect(uiCollisions).toHaveLength(1);
    expect(uiCollisions[0].message).toContain('`agent_ui_list_form_controls`');
    expect(uiCollisions[0].message).toContain('`agent_ui_`');
  });

  it('reports no UI collision for the default prefix the plugin leaves in place', async () => {
    // What a real build produces: `scanWithOxc` passes no `uiToolPrefixes`,
    // because `ui.prefix` is a runtime `<Provider>` prop no artifact records.
    // `agent.ui.list_form_controls` is a fixed UI tool ONLY for an app that
    // configured `agent_ui_`, so under the default it is a correct intent and
    // must not be reported.
    const { manifest, surface } = await scan();

    expect(
      collisionsFor(surface, manifest).filter((diagnostic) =>
        diagnostic.message.includes('ui.prefix'),
      ),
    ).toEqual([]);
  });

  it('keeps every declared intent emitted — the report is advisory', async () => {
    // The build-time report must not contradict the source. `defineIntent`
    // accepts all three ids, so all three belong in the artifact; at mount a
    // colliding pair simply registers under one name with one shadowing the
    // other, which is why the notice is advisory rather than a drop.
    const { surface } = await scan();

    expect(surface.intents.map((intent) => intent.id).sort()).toEqual([
      'agent.ui.list_form_controls',
      'product.list',
      'report.list',
    ]);
  });
});
