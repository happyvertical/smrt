/**
 * End-to-end agent-surface emission (#2591): real sources → real scan →
 * knowledge artifact.
 *
 * The unit tests either side of this seam pass fabricated data across it. What
 * they cannot catch is the seam itself: the scanner owns its own copy of the
 * capability vocabulary (core depends on it, so it cannot import back), and
 * `toKnowledgeAgentSurface` is the ONE place the two shapes are reconciled — it
 * drops `kind` and renames `filePath` to `sourceFile`. A silent mismatch there
 * would produce an artifact that is well-formed and wrong.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxcScanner } from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDomainKnowledgeManifest } from '../knowledge.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { toKnowledgeAgentSurface } from './index.js';

let rootDir: string;

const INTENTS = `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const nextPage = defineIntent({
  id: 'orders.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: true, openWorld: false },
  target: { registry: 'dataSurface', controlId: 'next-page', kind: 'table' },
});
`;

const PLAYBOOKS = `import { definePlaybook } from '@happyvertical/smrt-playbooks';

export const checkout = definePlaybook({
  key: 'commerce.checkout',
  title: 'Check out this cart',
  description: 'Submit the cart and confirm the order',
  steps: [
    { kind: 'operation', model: '@example/orders:Order', action: 'submit' },
  ],
});
`;

const NOT_STATIC = `import { defineIntent } from '@happyvertical/smrt-web/intents';

export function register() {
  return defineIntent({
    id: 'orders.scoped',
    description: 'Declared inside a function',
    target: { registry: 'control', action: 'focus' },
  });
}
`;

function emptyManifest(): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 1,
    packageName: '@example/orders',
    packageVersion: '1.0.0',
    objects: {},
  };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-e2e-'));
  mkdirSync(join(rootDir, 'src', 'lib'), { recursive: true });
  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify({ name: '@example/orders', version: '1.0.0' }),
  );
  writeFileSync(join(rootDir, 'src/lib/orders.intents.ts'), INTENTS);
  writeFileSync(join(rootDir, 'src/lib/checkout.playbooks.ts'), PLAYBOOKS);
  writeFileSync(join(rootDir, 'src/lib/late.intents.ts'), NOT_STATIC);
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

async function emit() {
  const { results } = await new OxcScanner({
    cwd: rootDir,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  return buildDomainKnowledgeManifest({
    manifest: emptyManifest(),
    rootDir,
    manifestPath: join(rootDir, '.smrt', 'manifest.json'),
    agentSurface: toKnowledgeAgentSurface(results.agentSurface),
  });
}

describe('agent surface, source to artifact', () => {
  it('carries a declared intent through the scanner into the artifact', async () => {
    const artifact = await emit();

    expect(artifact.agentSurface?.intents).toEqual([
      {
        id: 'orders.next_page',
        description: 'Advance the orders table by one page',
        capability: { effect: 'read', idempotent: true, openWorld: false },
        target: {
          registry: 'dataSurface',
          controlId: 'next-page',
          kind: 'table',
        },
        hasInputSchema: false,
        planes: ['browser'],
        // The rename the seam performs: the scanner calls this `filePath`.
        sourceFile: 'src/lib/orders.intents.ts',
      },
    ]);
    // `kind: 'intent'` is the scanner's discriminant and must not survive into
    // the artifact, where the containing array already says what these are.
    expect(artifact.agentSurface?.intents[0]).not.toHaveProperty('kind');
  });

  it('carries a declared playbook through with its steps and derived planes', async () => {
    const artifact = await emit();

    expect(artifact.agentSurface?.playbooks).toEqual([
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
        ],
        planes: ['browser', 'server'],
        planesDeclared: false,
        onStepFailure: 'abort',
        enabled: true,
        sourceFile: 'src/lib/checkout.playbooks.ts',
      },
    ]);
  });

  it('carries the diagnostic for the declaration it could not read', async () => {
    const artifact = await emit();

    expect(artifact.agentSurface?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'not-module-scope',
        helper: 'defineIntent',
        sourceFile: 'src/lib/late.intents.ts',
      }),
    ]);
    expect(artifact.agentSurface?.diagnostics[0].message).toContain(
      'useWebMcpTool',
    );
  });

  it('hashes each declaring module so the artifact goes stale on an edit', async () => {
    const before = await emit();
    writeFileSync(
      join(rootDir, 'src/lib/orders.intents.ts'),
      INTENTS.replace('one page', 'two pages'),
    );
    const after = await emit();

    const key = 'agentSurface:src/lib/orders.intents.ts';
    expect(before.sourceHashes[key]).toBeDefined();
    expect(after.sourceHashes[key]).not.toBe(before.sourceHashes[key]);
  });

  it('emits nothing at all for a project that declares nothing', async () => {
    rmSync(join(rootDir, 'src/lib/orders.intents.ts'));
    rmSync(join(rootDir, 'src/lib/checkout.playbooks.ts'));
    rmSync(join(rootDir, 'src/lib/late.intents.ts'));

    const artifact = await emit();

    expect(artifact.agentSurface).toBeUndefined();
    expect(
      Object.keys(artifact.sourceHashes).filter((key) =>
        key.startsWith('agentSurface:'),
      ),
    ).toEqual([]);
  });
});
