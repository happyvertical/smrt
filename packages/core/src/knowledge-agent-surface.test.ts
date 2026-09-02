/**
 * Agent-surface emission into the domain-knowledge artifact (#2591).
 *
 * The artifact is the agent/developer contract, so the questions here are:
 * does a declared surface reach it, does an edit to a declaring module mark it
 * stale, and does a package that declares nothing keep emitting exactly the
 * bytes it emitted before this field existed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DomainKnowledgeAgentSurface } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_SURFACE_HASH_PREFIX,
  buildDomainKnowledgeManifest,
} from './knowledge.js';
import type { SmartObjectManifest } from './scanner/types.js';

const INTENT_SOURCE = 'src/lib/orders.intents.ts';
const PLAYBOOK_SOURCE = 'src/lib/checkout.playbooks.ts';

function agentSurface(): DomainKnowledgeAgentSurface {
  return {
    intents: [
      {
        id: 'orders.next_page',
        description: 'Advance the orders table by one page',
        capability: { effect: 'read', idempotent: false, openWorld: false },
        target: { registry: 'dataSurface', controlId: 'next-page' },
        hasInputSchema: false,
        planes: ['browser'],
        sourceFile: INTENT_SOURCE,
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
        ],
        planes: ['browser', 'server'],
        planesDeclared: false,
        onStepFailure: 'abort',
        enabled: true,
        sourceFile: PLAYBOOK_SOURCE,
      },
    ],
    diagnostics: [
      {
        code: 'not-module-scope',
        helper: 'defineIntent',
        message:
          '`defineIntent()` must be called at module scope … use `useWebMcpTool` …',
        sourceFile: INTENT_SOURCE,
        line: 12,
      },
    ],
  };
}

function manifest(): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 1,
    packageName: '@example/orders',
    packageVersion: '1.0.0',
    objects: {},
  };
}

describe('agent surface in the domain-knowledge artifact', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-knowledge-'));
    mkdirSync(join(rootDir, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@example/orders', version: '1.0.0' }),
    );
    writeFileSync(join(rootDir, INTENT_SOURCE), 'export const a = 1;\n');
    writeFileSync(join(rootDir, PLAYBOOK_SOURCE), 'export const b = 1;\n');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  function build(surface?: DomainKnowledgeAgentSurface) {
    return buildDomainKnowledgeManifest({
      manifest: manifest(),
      rootDir,
      manifestPath: join(rootDir, '.smrt', 'manifest.json'),
      agentSurface: surface,
    });
  }

  it('emits declared intents and playbooks with their identities', () => {
    const artifact = build(agentSurface());

    expect(artifact.agentSurface?.intents).toEqual([
      expect.objectContaining({
        id: 'orders.next_page',
        capability: { effect: 'read', idempotent: false, openWorld: false },
        sourceFile: INTENT_SOURCE,
      }),
    ]);
    expect(artifact.agentSurface?.playbooks).toEqual([
      expect.objectContaining({
        key: 'commerce.checkout',
        planes: ['browser', 'server'],
        sourceFile: PLAYBOOK_SOURCE,
      }),
    ]);
  });

  it('keeps the diagnostic for a declaration it could not emit', () => {
    const artifact = build(agentSurface());

    expect(artifact.agentSurface?.diagnostics).toHaveLength(1);
    expect(artifact.agentSurface?.diagnostics[0].message).toContain(
      'useWebMcpTool',
    );
  });

  it('hashes every declaring module so an edit marks the artifact stale', () => {
    const before = build(agentSurface());
    const intentKey = `${AGENT_SURFACE_HASH_PREFIX}${INTENT_SOURCE}`;
    const playbookKey = `${AGENT_SURFACE_HASH_PREFIX}${PLAYBOOK_SOURCE}`;

    expect(Object.keys(before.sourceHashes)).toEqual(
      expect.arrayContaining([intentKey, playbookKey]),
    );

    writeFileSync(join(rootDir, INTENT_SOURCE), 'export const a = 2;\n');
    const after = build(agentSurface());

    expect(after.sourceHashes[intentKey]).not.toBe(
      before.sourceHashes[intentKey],
    );
    expect(after.sourceHashes[playbookKey]).toBe(
      before.sourceHashes[playbookKey],
    );
  });

  it('omits the field entirely when a package declares nothing', () => {
    // Additive to schema version 1 in practice, not just on paper: an artifact
    // for a package with no declarations must stay byte-identical to what it
    // emitted before this field existed.
    const none = build(undefined);
    const empty = build({ intents: [], playbooks: [], diagnostics: [] });

    expect(none.agentSurface).toBeUndefined();
    expect(empty.agentSurface).toBeUndefined();
    expect(
      Object.keys(none.sourceHashes).filter((key) =>
        key.startsWith(AGENT_SURFACE_HASH_PREFIX),
      ),
    ).toEqual([]);
    expect(JSON.stringify({ ...none, generatedAt: '' })).toBe(
      JSON.stringify({ ...empty, generatedAt: '' }),
    );
  });
});
