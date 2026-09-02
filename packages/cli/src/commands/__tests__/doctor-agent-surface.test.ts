/**
 * `smrt doctor`'s agent-surface section (#2591).
 *
 * The claim under test is the one the epic makes: an application's complete
 * agent-addressable surface is readable from BUILD ARTIFACTS ALONE — no route
 * mounted, no server started, no application code loaded.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readAgentSurfaceReport,
  renderAgentSurfaceReport,
} from '../utilities.js';

let projectRoot: string | undefined;

afterEach(async () => {
  if (projectRoot) {
    await rm(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
});

async function writeArtifact(
  relativePath: string,
  artifact: Record<string, unknown>,
): Promise<string> {
  projectRoot = await mkdtemp(join(tmpdir(), 'smrt-doctor-agent-surface-'));
  const artifactPath = resolve(projectRoot, relativePath);
  await mkdir(resolve(artifactPath, '..'), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
  return projectRoot;
}

const ARTIFACT = {
  schemaVersion: 1,
  generatedAt: '1970-01-01T00:00:00.000Z',
  packageName: '@example/orders',
  sourceHashes: {},
  exports: [],
  dependencies: {},
  smrtDependencies: [],
  sdkDependencies: [],
  tags: [],
  risks: [],
  objects: [],
  surfaces: [
    {
      kind: 'mcp',
      name: 'orders_list',
      operation: 'list',
      objectName: 'Order',
    },
    {
      kind: 'mcp',
      name: 'orders_create',
      operation: 'create',
      objectName: 'Order',
    },
    { kind: 'api', name: 'GET /orders', operation: 'list' },
  ],
  prompts: [],
  relationshipsV2: {
    foreignKeyFields: 0,
    crossPackageRefFields: 0,
    junctionCollections: 0,
    hierarchicalObjects: 0,
    polymorphicAssociations: 0,
    uuidColumns: 0,
  },
  agentSurface: {
    intents: [
      {
        id: 'orders.next_page',
        description: 'Advance the orders table by one page',
        capability: { effect: 'read', idempotent: false, openWorld: false },
        target: { registry: 'dataSurface', controlId: 'next-page' },
        hasInputSchema: false,
        planes: ['browser'],
        sourceFile: 'src/lib/orders.intents.ts',
      },
    ],
    playbooks: [
      {
        key: 'commerce.checkout',
        title: 'Check out this cart',
        description: 'Submit the cart and confirm the order',
        steps: [
          {
            kind: 'operation',
            model: '@example/orders:Order',
            action: 'submit',
          },
          { kind: 'intent', id: 'orders.next_page' },
        ],
        planes: ['browser'],
        planesDeclared: false,
        onStepFailure: 'abort',
        enabled: true,
        sourceFile: 'src/lib/checkout.playbooks.ts',
      },
    ],
    diagnostics: [
      {
        code: 'not-module-scope',
        helper: 'defineIntent',
        message:
          '`defineIntent()` must be called at module scope. Use `useWebMcpTool` instead.',
        sourceFile: 'src/lib/late.intents.ts',
        line: 9,
      },
    ],
  },
};

describe('readAgentSurfaceReport', () => {
  it('reports model tools, intents, and playbooks from one build artifact', async () => {
    const root = await writeArtifact('.smrt/smrt-knowledge.json', ARTIFACT);

    const report = await readAgentSurfaceReport(root);

    expect(report?.source).toBe('.smrt/smrt-knowledge.json');
    // REST surfaces are not agent-addressable tools; only `mcp` entries are.
    expect(report?.modelTools.map((tool) => tool.name)).toEqual([
      'orders_create',
      'orders_list',
    ]);
    expect(report?.intents.map((intent) => intent.name)).toEqual([
      'orders.next_page',
    ]);
    expect(report?.playbooks.map((playbook) => playbook.name)).toEqual([
      'commerce.checkout',
    ]);
    expect(report?.notStatic).toEqual([
      {
        sourceFile: 'src/lib/late.intents.ts:9',
        message: expect.stringContaining('useWebMcpTool'),
      },
    ]);
  });

  it('falls back to a library build output', async () => {
    const root = await writeArtifact('dist/smrt-knowledge.json', ARTIFACT);

    expect((await readAgentSurfaceReport(root))?.source).toBe(
      'dist/smrt-knowledge.json',
    );
  });

  it('reports nothing rather than throwing when no artifact exists', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'smrt-doctor-agent-surface-'));

    expect(await readAgentSurfaceReport(projectRoot)).toBeUndefined();
  });

  it('tolerates a corrupt artifact', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'smrt-doctor-agent-surface-'));
    await mkdir(resolve(projectRoot, '.smrt'), { recursive: true });
    await writeFile(
      resolve(projectRoot, '.smrt/smrt-knowledge.json'),
      '{ not json',
    );

    expect(await readAgentSurfaceReport(projectRoot)).toBeUndefined();
  });

  it('steps over a well-formed-JSON artifact of the wrong shape', async () => {
    // Parsing is not validating. Each of these parses cleanly; none is a
    // knowledge artifact, and none may be reported as an empty surface.
    for (const body of [
      '{}',
      '{ "schemaVersion": 1 }',
      '{ "schemaVersion": 1, "surfaces": {} }',
      '{ "schemaVersion": 1, "surfaces": [], "agentSurface": { "intents": {} } }',
      '[]',
      'null',
    ]) {
      projectRoot = await mkdtemp(join(tmpdir(), 'smrt-doctor-agent-surface-'));
      await mkdir(resolve(projectRoot, '.smrt'), { recursive: true });
      await writeFile(resolve(projectRoot, '.smrt/smrt-knowledge.json'), body);

      await expect(
        readAgentSurfaceReport(projectRoot),
      ).resolves.toBeUndefined();
      await rm(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('falls through a malformed working copy to a valid build output', async () => {
    // The malformed `.smrt/` artifact must not mask the good `dist/` one.
    projectRoot = await mkdtemp(join(tmpdir(), 'smrt-doctor-agent-surface-'));
    await mkdir(resolve(projectRoot, '.smrt'), { recursive: true });
    await writeFile(resolve(projectRoot, '.smrt/smrt-knowledge.json'), '{}');
    await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
    await writeFile(
      resolve(projectRoot, 'dist/smrt-knowledge.json'),
      JSON.stringify(ARTIFACT),
    );

    const report = await readAgentSurfaceReport(projectRoot);

    expect(report?.source).toBe('dist/smrt-knowledge.json');
    expect(report?.intents.map((intent) => intent.name)).toEqual([
      'orders.next_page',
    ]);
  });
});

describe('renderAgentSurfaceReport', () => {
  it('prints the full surface with counts and identities', async () => {
    const root = await writeArtifact('.smrt/smrt-knowledge.json', ARTIFACT);
    const report = await readAgentSurfaceReport(root);

    const output = renderAgentSurfaceReport(report).join('\n');

    expect(output).toContain('Generated model tools: 2');
    expect(output).toContain('- orders_list (Order.list)');
    expect(output).toContain('Declared view intents: 1');
    expect(output).toContain(
      '- orders.next_page (read · browser · src/lib/orders.intents.ts)',
    );
    expect(output).toContain('Registered playbooks: 1');
    expect(output).toContain(
      '- commerce.checkout (2 step(s) · browser · src/lib/checkout.playbooks.ts)',
    );
    expect(output).toContain('Not statically emittable: 1');
    expect(output).toContain('useWebMcpTool');
  });

  it('says what to do when nothing has been built yet', () => {
    expect(renderAgentSurfaceReport(undefined).join('\n')).toContain(
      'run a build',
    );
  });
});
