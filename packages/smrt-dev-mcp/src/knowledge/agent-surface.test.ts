/**
 * `dev:knowledge-check` over the emitted agent surface (#2591).
 *
 * Emission is only worth anything if the artifact is trustworthy, so the check
 * has to answer two questions: are the entries well formed, and is the artifact
 * still current with respect to the modules that declared them.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKnowledgeIndex,
  checkKnowledgeFreshness,
  renderKnowledgeIndexMarkdown,
} from './index.js';

const INTENT_SOURCE = 'src/lib/orders.intents.ts';
const PLAYBOOK_SOURCE = 'src/lib/checkout.playbooks.ts';

/**
 * Real declarations, not placeholders: the freshness check re-derives the
 * declaration set from source and compares it to the artifact, so these bodies
 * must actually declare the identities the artifact claims.
 */
const INTENT_BODY = `import { defineIntent } from '@happyvertical/smrt-web/intents';

export const nextPage = defineIntent({
  id: 'orders.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: true, openWorld: false },
  target: { registry: 'dataSurface', controlId: 'next-page' },
});
`;

const PLAYBOOK_BODY = `import { definePlaybook } from '@happyvertical/smrt-playbooks';

export const checkout = definePlaybook({
  key: 'commerce.checkout',
  title: 'Check out this cart',
  description: 'Submit the cart and confirm the order',
  steps: [
    {
      kind: 'operation',
      model: '@happyvertical/smrt-demo:Order',
      action: 'submit',
    },
  ],
});
`;

let rootDir: string;
let packageDir: string;

function agentSurface() {
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
            model: '@happyvertical/smrt-demo:Order',
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
    diagnostics: [] as Array<Record<string, unknown>>,
  };
}

async function sha256(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex');
}

async function writeArtifact(
  surface: ReturnType<typeof agentSurface> | undefined,
  hashes: Record<string, string>,
): Promise<void> {
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(
    join(packageDir, 'dist', 'smrt-knowledge.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: '1970-01-01T00:00:00.000Z',
        packageName: '@happyvertical/smrt-demo',
        packageVersion: '1.0.0',
        sourceHashes: hashes,
        exports: ['.'],
        dependencies: {},
        smrtDependencies: [],
        sdkDependencies: [],
        tags: [],
        risks: [],
        objects: [],
        surfaces: [],
        prompts: [],
        relationshipsV2: {
          foreignKeyFields: 0,
          crossPackageRefFields: 0,
          junctionCollections: 0,
          hierarchicalObjects: 0,
          polymorphicAssociations: 0,
          uuidColumns: 0,
        },
        ...(surface ? { agentSurface: surface } : {}),
      },
      null,
      2,
    ),
  );
}

async function currentHashes(): Promise<Record<string, string>> {
  return {
    [`agentSurface:${INTENT_SOURCE}`]: await sha256(INTENT_BODY),
    [`agentSurface:${PLAYBOOK_SOURCE}`]: await sha256(PLAYBOOK_BODY),
  };
}

beforeEach(async () => {
  rootDir = join(tmpdir(), `smrt-agent-surface-check-${Date.now()}`);
  packageDir = join(rootDir, 'packages', 'demo');
  await mkdir(join(packageDir, 'src', 'lib'), { recursive: true });
  await writeFile(
    join(rootDir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@happyvertical/smrt-demo',
      version: '1.0.0',
      type: 'module',
      author: 'HappyVertical',
      files: ['dist', 'AGENTS.md', 'CLAUDE.md'],
      exports: { '.': { import: './dist/index.js' } },
    }),
  );
  await writeFile(join(packageDir, 'AGENTS.md'), '# Demo\n\nGuidance.\n');
  await writeFile(join(packageDir, 'CLAUDE.md'), '@AGENTS.md\n');
  await writeFile(join(packageDir, INTENT_SOURCE), INTENT_BODY);
  await writeFile(join(packageDir, PLAYBOOK_SOURCE), PLAYBOOK_BODY);
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('the agent surface reaches the knowledge index', () => {
  it('lifts declared intents and playbooks onto the package entry', async () => {
    await writeArtifact(agentSurface(), await currentHashes());

    const index = await buildKnowledgeIndex({ rootDir });
    const pkg = index.packages.find(
      (entry) => entry.name === '@happyvertical/smrt-demo',
    );

    expect(pkg?.agentSurface?.intents.map((intent) => intent.id)).toEqual([
      'orders.next_page',
    ]);
    expect(pkg?.agentSurface?.playbooks.map((book) => book.key)).toEqual([
      'commerce.checkout',
    ]);
    expect(renderKnowledgeIndexMarkdown(index)).toContain(
      '- view intents: orders.next_page',
    );
  });

  it('renders no agent-surface lines for a package that declares none', async () => {
    await writeArtifact(undefined, {});

    const markdown = renderKnowledgeIndexMarkdown(
      await buildKnowledgeIndex({ rootDir }),
    );

    expect(markdown).not.toContain('view intents');
    expect(markdown).not.toContain('playbooks');
  });
});

describe('dev:knowledge-check validates the emitted surface', () => {
  it('passes on a current artifact', async () => {
    await writeArtifact(agentSurface(), await currentHashes());

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(
      result.issues.filter((issue) => issue.code.startsWith('agent-surface')),
    ).toEqual([]);
    expect(
      result.issues.filter(
        (issue) =>
          issue.code === 'stale-domain-knowledge' &&
          issue.packageName === '@happyvertical/smrt-demo',
      ),
    ).toEqual([]);
  });

  it('fails when a declaring module changed after the artifact was written', async () => {
    await writeArtifact(agentSurface(), await currentHashes());
    // Edit the declaration without removing it, so this exercises the hash
    // signal rather than the declaration-set comparison.
    await writeFile(
      join(packageDir, INTENT_SOURCE),
      INTENT_BODY.replace('one page', 'two pages'),
    );

    // `stale-*` findings are warnings by default and errors under `--strict`,
    // which is the mode CI and Lefthook run. Asserting both keeps this entry
    // on exactly the same footing as every other authored source.
    const lenient = await checkKnowledgeFreshness({ rootDir });
    expect(
      lenient.issues.filter((issue) => issue.code === 'stale-domain-knowledge'),
    ).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: `${INTENT_SOURCE} changed since smrt-knowledge.json was generated`,
      }),
    ]);

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });

    expect(strict.ok).toBe(false);
    expect(
      strict.issues.filter((issue) => issue.code === 'stale-domain-knowledge'),
    ).toEqual([expect.objectContaining({ severity: 'error' })]);
  });

  it('fails when a NEW declaration was added after the artifact was written', async () => {
    // The hash signal cannot see this on its own: a brand-new sidecar has no
    // recorded hash to mismatch, the runtime manifest never carries intents,
    // and AGENTS.md is untouched — so every other freshness signal stays green
    // while the artifact silently omits a real operation.
    await writeArtifact(agentSurface(), await currentHashes());
    await writeFile(
      join(packageDir, 'src/lib/extra.intents.ts'),
      INTENT_BODY.replace('orders.next_page', 'orders.brand_new').replace(
        'nextPage',
        'brandNew',
      ),
    );

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });
    const drift = strict.issues.filter(
      (issue) => issue.code === 'stale-agent-surface',
    );

    expect(strict.ok).toBe(false);
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('orders.brand_new');
    expect(drift[0].message).toContain('missing from smrt-knowledge.json');
  });

  it('fails when the artifact still advertises a removed declaration', async () => {
    await writeArtifact(agentSurface(), await currentHashes());
    await rm(join(packageDir, PLAYBOOK_SOURCE));

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });
    const drift = strict.issues.filter(
      (issue) => issue.code === 'stale-agent-surface',
    );

    expect(strict.ok).toBe(false);
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('commerce.checkout');
    expect(drift[0].message).toContain('no longer present in source');
  });

  it('does not report drift for a declaration the emitter never sees', async () => {
    // A fixture intent in a test file is excluded from the build, so counting
    // it as declared would raise an error no rebuild could ever clear.
    await writeArtifact(agentSurface(), await currentHashes());
    await mkdir(join(packageDir, 'src/lib/__tests__'), { recursive: true });
    await writeFile(
      join(packageDir, 'src/lib/fixture.test.ts'),
      INTENT_BODY.replace('orders.next_page', 'orders.only_in_a_test'),
    );
    await writeFile(
      join(packageDir, 'src/lib/__tests__/fixture.intents.ts'),
      INTENT_BODY.replace('orders.next_page', 'orders.only_in_tests_dir'),
    );

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });

    expect(
      strict.issues.filter((issue) => issue.code === 'stale-agent-surface'),
    ).toEqual([]);
  });

  it('never reports the dropped loser of a tool-name collision as a missing identity', async () => {
    // The merge drops it deliberately and the artifact is the merged result, so
    // comparing raw per-file declarations would call the drop "missing" — an
    // error no rebuild could clear. The collision DOES add a diagnostic, which
    // is real drift, so the artifact is correctly stale for that reason alone.
    // Named so the ARTIFACT's own entry is the path-ordered winner.
    await writeArtifact(agentSurface(), await currentHashes());
    await writeFile(
      join(packageDir, 'src/lib/zz-collides.intents.ts'),
      INTENT_BODY.replace('orders.next_page', 'orders.next.page'),
    );

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });
    const drift = strict.issues.filter(
      (issue) => issue.code === 'stale-agent-surface',
    );

    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('duplicate-identity diagnostic');
    // Crucially, NOT reported as a missing view intent.
    expect(drift[0].message).not.toContain('view intent:');
  });

  it('fails when a new sidecar adds ONLY a non-static declaration', async () => {
    // It contributes no identity and has no prior hash, so without comparing
    // diagnostics too, "a diagnostic, never silence" would quietly become
    // "a diagnostic, until the artifact goes stale".
    await writeArtifact(agentSurface(), await currentHashes());
    await writeFile(
      join(packageDir, 'src/lib/computed.intents.ts'),
      `import { defineIntent } from '@happyvertical/smrt-web/intents';
const config = { id: 'orders.computed' };
export const a = defineIntent(config);
`,
    );

    const strict = await checkKnowledgeFreshness({ rootDir, strict: true });
    const drift = strict.issues.filter(
      (issue) => issue.code === 'stale-agent-surface',
    );

    expect(strict.ok).toBe(false);
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain('non-literal-argument diagnostic');
    expect(drift[0].message).toContain('computed.intents.ts');
  });

  it('fails when a declaring module is gone', async () => {
    await writeArtifact(agentSurface(), await currentHashes());
    await rm(join(packageDir, PLAYBOOK_SOURCE));

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'domain-knowledge-source-missing' &&
          issue.message.includes(PLAYBOOK_SOURCE),
      ),
    ).toBe(true);
  });

  it('rejects a duplicate or missing identity', async () => {
    const surface = agentSurface();
    surface.intents.push({ ...surface.intents[0] });
    surface.playbooks.push({ ...surface.playbooks[0], key: '' });
    await writeArtifact(surface, await currentHashes());

    const result = await checkKnowledgeFreshness({ rootDir });
    const codes = result.issues.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain('agent-surface-duplicate-identity');
    expect(codes).toContain('agent-surface-missing-identity');
  });

  it('rejects a playbook with no steps', async () => {
    const surface = agentSurface();
    surface.playbooks[0].steps = [];
    await writeArtifact(surface, await currentHashes());

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(result.issues.map((issue) => issue.code)).toContain(
      'agent-surface-empty-playbook',
    );
  });

  it('fails on a real cross-file duplicate, which arrives as a diagnostic', async () => {
    // The scanner's merge already dropped the loser, so the identity loop can
    // never see two entries — the diagnostic is the only signal there is, and
    // reporting it as a "not static" warning would make the duplicate error
    // unreachable for the case it exists to catch.
    const surface = agentSurface();
    surface.diagnostics.push({
      code: 'duplicate-identity',
      helper: 'defineIntent',
      message:
        'view intent `orders.next_page` is declared in both `a.ts` and `b.ts`.',
      sourceFile: INTENT_SOURCE,
    });
    await writeArtifact(surface, await currentHashes());

    const result = await checkKnowledgeFreshness({ rootDir });
    const duplicate = result.issues.find(
      (issue) => issue.code === 'agent-surface-duplicate-identity',
    );

    expect(duplicate?.severity).toBe('error');
    expect(result.ok).toBe(false);
  });

  it('warns — never stays silent — about a non-static declaration', async () => {
    const surface = agentSurface();
    surface.diagnostics.push({
      code: 'not-module-scope',
      helper: 'defineIntent',
      message:
        '`defineIntent()` must be called at module scope. Use `useWebMcpTool` for a computed tool set.',
      sourceFile: INTENT_SOURCE,
      line: 9,
    });
    await writeArtifact(surface, await currentHashes());

    const result = await checkKnowledgeFreshness({ rootDir });
    const warning = result.issues.find(
      (issue) => issue.code === 'agent-surface-not-static',
    );

    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toContain('useWebMcpTool');
    expect(warning?.message).toContain(`${INTENT_SOURCE}:9`);
  });
});
