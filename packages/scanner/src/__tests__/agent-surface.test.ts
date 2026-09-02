/**
 * Agent-surface matcher (#2591).
 *
 * The contract under test has two halves and the second matters as much as the
 * first: a literal declaration is emitted with a stable identity, and anything
 * else produces a diagnostic naming `useWebMcpTool` rather than disappearing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  extractAgentSurface,
  mergeAgentSurfaces,
  scanSvelteAgentSurface,
  sourceMayDeclareAgentSurface,
} from '../agent-surface.js';
import { parseSource } from '../oxc-parser.js';
import { OxcScanner } from '../scanner.js';
import type { AgentSurface } from '../types.js';

const INTENT_IMPORT =
  "import { defineIntent } from '@happyvertical/smrt-web/intents';";
const PLAYBOOK_IMPORT =
  "import { definePlaybook } from '@happyvertical/smrt-playbooks';";

function surfaceOf(source: string, filename = 'declarations.ts'): AgentSurface {
  const result = parseSource(source, filename);
  expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
  return result.agentSurface ?? { intents: [], playbooks: [], diagnostics: [] };
}

const LITERAL_INTENT = `${INTENT_IMPORT}

export const nextPage = defineIntent({
  id: 'orders.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: false, openWorld: false },
  inputSchema: { type: 'object', properties: {} },
  target: { registry: 'dataSurface', controlId: 'next-page', kind: 'table' },
});
`;

const LITERAL_PLAYBOOK = `${PLAYBOOK_IMPORT}

export const checkout = definePlaybook({
  key: 'commerce.checkout',
  title: 'Check out this cart',
  description: 'Submit the cart and confirm the order',
  steps: [
    { kind: 'operation', model: '@happyvertical/smrt-commerce:Order', action: 'submit' },
    { kind: 'intent', id: 'orders.next_page' },
  ],
});
`;

describe('literal declarations are emitted', () => {
  it('reads a module-scope view intent and resolves its capability', () => {
    const surface = surfaceOf(LITERAL_INTENT, 'OrderTable.intents.ts');

    expect(surface.diagnostics).toEqual([]);
    expect(surface.intents).toHaveLength(1);
    expect(surface.intents[0]).toMatchObject({
      kind: 'intent',
      id: 'orders.next_page',
      description: 'Advance the orders table by one page',
      capability: { effect: 'read', idempotent: false, openWorld: false },
      hasInputSchema: true,
      planes: ['browser'],
      filePath: 'OrderTable.intents.ts',
    });
    expect(surface.intents[0].target).toEqual({
      registry: 'dataSurface',
      controlId: 'next-page',
      kind: 'table',
    });
  });

  it('applies the fail-closed rule to an undeclared capability', () => {
    const surface = surfaceOf(`${INTENT_IMPORT}
export const reveal = defineIntent({
  id: 'orders.reveal',
  description: 'Reveal the archived tab',
  target: { registry: 'control', action: 'reveal' },
});
`);

    expect(surface.intents[0].capability).toEqual({
      effect: 'destructive',
      idempotent: false,
      openWorld: true,
    });
  });

  it('reads a module-scope playbook and its steps', () => {
    const surface = surfaceOf(LITERAL_PLAYBOOK, 'checkout.playbooks.ts');

    expect(surface.diagnostics).toEqual([]);
    expect(surface.playbooks).toHaveLength(1);
    expect(surface.playbooks[0]).toMatchObject({
      kind: 'playbook',
      key: 'commerce.checkout',
      title: 'Check out this cart',
      onStepFailure: 'abort',
      enabled: true,
      planesDeclared: false,
      // An intent step makes a playbook browser-only unless server validity is
      // declared explicitly, mirroring `smrt-playbooks`.
      planes: ['browser'],
    });
    expect(surface.playbooks[0].steps).toEqual([
      {
        kind: 'operation',
        model: '@happyvertical/smrt-commerce:Order',
        action: 'submit',
      },
      { kind: 'intent', id: 'orders.next_page' },
    ]);
  });

  it('defaults an operation-only playbook to both planes', () => {
    const surface = surfaceOf(`${PLAYBOOK_IMPORT}
definePlaybook({
  key: 'commerce.archive',
  title: 'Archive an order',
  description: 'Archive one order',
  steps: [{ kind: 'operation', model: '@pkg:Order', action: 'archive' }],
});
`);

    expect(surface.playbooks[0].planes).toEqual(['browser', 'server']);
    expect(surface.playbooks[0].planesDeclared).toBe(false);
  });

  it('accepts declarations collected into a module-scope array', () => {
    // Genuinely at module scope — not in a function, class, conditional, or
    // loop, which is what the contract forbids. Reporting it as "not at module
    // scope" would be false and would leave the author nothing to act on.
    const surface = surfaceOf(`${INTENT_IMPORT}
export const intents = [
  defineIntent({
    id: 'orders.first',
    description: 'First',
    target: { registry: 'control', action: 'focus' },
  }),
  defineIntent({
    id: 'orders.second',
    description: 'Second',
    target: { registry: 'control', action: 'reveal' },
  }),
];
`);

    expect(surface.diagnostics).toEqual([]);
    expect(surface.intents.map((intent) => intent.id)).toEqual([
      'orders.first',
      'orders.second',
    ]);
  });

  it('accepts an aliased named import and a namespace import', () => {
    const aliased = surfaceOf(`
import { defineIntent as declareIntent } from '@happyvertical/smrt-web/intents';
export const a = declareIntent({
  id: 'orders.alias',
  description: 'Aliased',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(aliased.intents.map((intent) => intent.id)).toEqual([
      'orders.alias',
    ]);

    const namespaced = surfaceOf(`
import * as intents from '@happyvertical/smrt-web/intents';
export const b = intents.defineIntent({
  id: 'orders.namespaced',
  description: 'Namespaced',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(namespaced.intents.map((intent) => intent.id)).toEqual([
      'orders.namespaced',
    ]);
  });
});

describe('the callee must be the framework helper', () => {
  it('ignores a local function that merely shares the name', () => {
    const surface = surfaceOf(`
function defineIntent(config: { id: string }) {
  return config;
}
export const local = defineIntent({ id: 'not.an.intent' });
`);

    expect(surface).toEqual({ intents: [], playbooks: [], diagnostics: [] });
  });

  it('ignores `defineIntent` imported from the smrt-web package root', () => {
    // `defineIntent` ships solely from the `/intents` subpath entry so a
    // sidecar never drags in the client-data engine. Matching the root would
    // invent a specifier the package does not export.
    const surface = surfaceOf(`
import { defineIntent } from '@happyvertical/smrt-web';
export const a = defineIntent({
  id: 'orders.root',
  description: 'Imported from the wrong entry',
  target: { registry: 'control', action: 'focus' },
});
`);

    expect(surface.intents).toEqual([]);
    expect(surface.diagnostics).toEqual([]);
  });
});

describe('a declaration that is not static gets a diagnostic, never silence', () => {
  const escapeHatch = /useWebMcpTool/;

  function onlyDiagnostic(source: string) {
    const surface = surfaceOf(source);
    expect(surface.intents).toEqual([]);
    expect(surface.playbooks).toEqual([]);
    expect(surface.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of surface.diagnostics) {
      expect(diagnostic.message).toMatch(escapeHatch);
      expect(diagnostic.line).toBeGreaterThan(0);
    }
    return surface.diagnostics;
  }

  it('rejects a computed argument', () => {
    const diagnostics = onlyDiagnostic(`${INTENT_IMPORT}
const config = { id: 'orders.computed' };
export const a = defineIntent(config);
`);
    expect(diagnostics[0].code).toBe('non-literal-argument');
    expect(diagnostics[0].helper).toBe('defineIntent');
  });

  it('rejects a spread inside the literal', () => {
    const diagnostics = onlyDiagnostic(`${INTENT_IMPORT}
const base = { description: 'shared' };
export const a = defineIntent({
  ...base,
  id: 'orders.spread',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(diagnostics[0].code).toBe('non-literal-argument');
    expect(diagnostics[0].message).toContain('spread');
  });

  it('rejects a conditional value', () => {
    const diagnostics = onlyDiagnostic(`${INTENT_IMPORT}
declare const dev: boolean;
export const a = defineIntent({
  id: 'orders.conditional',
  description: dev ? 'dev' : 'prod',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(diagnostics[0].message).toContain('conditional expression');
  });

  it('rejects a template literal, interpolated or not', () => {
    const interpolated = onlyDiagnostic(
      `${INTENT_IMPORT}
declare const scope: string;
export const a = defineIntent({
  id: \`\${scope}.templated\`,
  description: 'Templated',
  target: { registry: 'control', action: 'focus' },
});
`,
    );
    expect(interpolated[0].message).toContain('template literal');
  });

  it('rejects a declaration inside a function body', () => {
    const diagnostics = onlyDiagnostic(`${PLAYBOOK_IMPORT}
export function register() {
  return definePlaybook({
    key: 'commerce.scoped',
    title: 'Scoped',
    description: 'Declared inside a function',
    steps: [{ kind: 'operation', model: '@pkg:Order', action: 'submit' }],
  });
}
`);
    expect(diagnostics[0].code).toBe('not-module-scope');
    expect(diagnostics[0].helper).toBe('definePlaybook');
  });

  it('rejects a call with the wrong number of arguments', () => {
    const diagnostics = onlyDiagnostic(`${INTENT_IMPORT}
export const a = defineIntent();
`);
    expect(diagnostics[0].code).toBe('argument-count');
  });

  it('rejects a literal that is missing a required identity field', () => {
    const diagnostics = onlyDiagnostic(`${INTENT_IMPORT}
export const a = defineIntent({
  description: 'No id at all',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(diagnostics[0].code).toBe('incomplete-declaration');
  });

  it('rejects an id `defineIntent` itself would refuse', () => {
    // The declaration types `id` as `string`, so these type-check cleanly and
    // fail only when the page loads. Emitting them would make the artifact and
    // `smrt doctor` advertise an operation that can never register.
    for (const [id, expected] of [
      ['Orders.Bad', 'lowercase'],
      ['nodot', 'lowercase'],
      ['smrt.ui.focus', 'reserved'],
    ] as const) {
      const surface = surfaceOf(`${INTENT_IMPORT}
export const a = defineIntent({
  id: '${id}',
  description: 'Invalid identity',
  target: { registry: 'control', action: 'focus' },
});
`);
      expect(surface.intents).toEqual([]);
      expect(surface.diagnostics).toHaveLength(1);
      expect(surface.diagnostics[0].code).toBe('invalid-identity');
      expect(surface.diagnostics[0].message).toContain(expected);
    }
  });

  it('rejects an intent target `defineIntent` would refuse', () => {
    const cases: Array<[string, string]> = [
      [`target: { registry: 'rest', controlId: 'x' }`, "registry 'rest'"],
      [`target: { registry: 'dataSurface' }`, 'controlId'],
      [`target: { registry: 'control', action: 'teleport' }`, 'teleport'],
      [
        `target: { registry: 'dataSurface', controlId: 'x', kind: 'grid' }`,
        "kind 'grid'",
      ],
      [
        `target: { registry: 'control', action: 'focus', url: 'https://x' }`,
        'unknown target key',
      ],
    ];
    for (const [target, expected] of cases) {
      const surface = surfaceOf(`${INTENT_IMPORT}
export const a = defineIntent({
  id: 'orders.bad_target',
  description: 'Invalid target',
  ${target},
});
`);
      expect(surface.intents).toEqual([]);
      expect(surface.diagnostics.map((d) => d.code)).toEqual([
        'invalid-identity',
      ]);
      expect(surface.diagnostics[0].message).toContain(expected);
    }
  });

  it('rejects an unknown key on an intent declaration', () => {
    // `defineIntent` hard-fails on one; dropping it silently here would let the
    // artifact disagree with what the runtime accepts.
    const surface = surfaceOf(`${INTENT_IMPORT}
export const a = defineIntent({
  id: 'orders.extra_key',
  description: 'Has an extra key',
  execute: 'nope',
  target: { registry: 'control', action: 'focus' },
});
`);
    expect(surface.intents).toEqual([]);
    expect(surface.diagnostics[0].message).toContain("unknown key 'execute'");
  });

  it('rejects playbook fields `definePlaybook` throws on, rather than repairing them', () => {
    const cases: Array<[string, string]> = [
      // Repairing this one would be worst of all: the artifact would assert
      // both planes for an author who declared none validly.
      [`planes: [],`, 'empty planes list'],
      [`planes: ['browser', 'fog'],`, "unknown plane 'fog'"],
      [`planes: 'browser',`, 'not an array'],
      [`onStepFailure: 'retry',`, "onStepFailure 'retry'"],
      [`enabled: 'yes',`, 'non-boolean'],
    ];
    for (const [field, expected] of cases) {
      const surface = surfaceOf(`${PLAYBOOK_IMPORT}
export const a = definePlaybook({
  key: 'commerce.bad',
  title: 'Bad',
  description: 'Invalid field',
  ${field}
  steps: [{ kind: 'operation', model: '@pkg:Order', action: 'submit' }],
});
`);
      expect(surface.playbooks).toEqual([]);
      expect(surface.diagnostics.map((d) => d.code)).toEqual([
        'invalid-identity',
      ]);
      expect(surface.diagnostics[0].message).toContain(expected);
    }
  });

  it('rejects a playbook step whose model is not a qualified pair', () => {
    const surface = surfaceOf(`${PLAYBOOK_IMPORT}
export const a = definePlaybook({
  key: 'commerce.unqualified',
  title: 'Unqualified',
  description: 'Model is not a qualified pair',
  steps: [{ kind: 'operation', model: 'Order', action: 'submit' }],
});
`);
    expect(surface.playbooks).toEqual([]);
    expect(surface.diagnostics[0].message).toContain('qualified pair');
  });

  it('reports a declaration written inline in a .svelte file', () => {
    const diagnostics = scanSvelteAgentSurface(
      'src/lib/OrderTable.svelte',
      `<script lang="ts">
  import { defineIntent } from '@happyvertical/smrt-web/intents';
  const intent = defineIntent({ id: 'orders.inline' });
</script>
`,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'svelte-declaration',
      helper: 'defineIntent',
      filePath: 'src/lib/OrderTable.svelte',
    });
    expect(diagnostics[0].message).toMatch(escapeHatch);
    expect(diagnostics[0].message).toContain('.ts');
  });

  it('does not flag a .svelte file that merely mentions the helper', () => {
    expect(
      scanSvelteAgentSurface(
        'src/lib/Docs.svelte',
        '<p>Use defineIntent( in a sidecar module.</p>',
      ),
    ).toEqual([]);
  });

  it('reports an aliased or loosely spaced .svelte declaration', () => {
    // Requiring the literal token `defineIntent(` would let exactly the case
    // this pass exists for slip through unremarked.
    const spaced = scanSvelteAgentSurface(
      'src/lib/Spaced.svelte',
      `<script lang="ts">
  import { defineIntent } from '@happyvertical/smrt-web/intents';
  const a = defineIntent ({ id: 'orders.spaced' });
</script>
`,
    );
    expect(spaced.map((d) => d.code)).toEqual(['svelte-declaration']);

    const aliased = scanSvelteAgentSurface(
      'src/lib/Aliased.svelte',
      `<script lang="ts">
  import { defineIntent as declare } from '@happyvertical/smrt-web/intents';
  const a = declare({ id: 'orders.aliased' });
</script>
`,
    );
    expect(aliased.map((d) => d.code)).toEqual(['svelte-declaration']);
  });

  it('does not flag a component whose own identifier merely ends in the helper name', () => {
    expect(
      scanSvelteAgentSurface(
        'src/lib/Lookalike.svelte',
        `<script lang="ts">
  import { defineIntent } from '@happyvertical/smrt-web/intents';
  const a = myDefineIntent({ id: 'orders.other' });
</script>
`,
      ),
    ).toEqual([]);
  });
});

describe('emitted identity is deterministic', () => {
  const files: Array<{ path: string; source: string }> = [
    {
      path: 'a/first.intents.ts',
      source: `${INTENT_IMPORT}
export const a = defineIntent({
  id: 'zeta.last',
  description: 'Sorts last by id',
  target: { registry: 'control', action: 'focus' },
});
`,
    },
    {
      path: 'b/second.intents.ts',
      source: `${INTENT_IMPORT}
export const b = defineIntent({
  id: 'alpha.first',
  description: 'Sorts first by id',
  target: { registry: 'control', action: 'reveal' },
});
`,
    },
    {
      path: 'c/third.playbooks.ts',
      source: `${PLAYBOOK_IMPORT}
export const c = definePlaybook({
  key: 'mid.playbook',
  title: 'Mid',
  description: 'A playbook',
  steps: [{ kind: 'operation', model: '@pkg:Order', action: 'submit' }],
});
`,
    },
  ];

  function emitIn(order: number[]): AgentSurface {
    return mergeAgentSurfaces(
      order.map((index) => surfaceOf(files[index].source, files[index].path)),
    );
  }

  it('emits identical entries for every file order', () => {
    const canonical = emitIn([0, 1, 2]);
    for (const order of [
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
      [2, 0, 1],
      [1, 2, 0],
    ]) {
      expect(emitIn(order)).toEqual(canonical);
    }
    expect(canonical.intents.map((intent) => intent.id)).toEqual([
      'alpha.first',
      'zeta.last',
    ]);
    expect(canonical.playbooks.map((playbook) => playbook.key)).toEqual([
      'mid.playbook',
    ]);
  });

  it('resolves a duplicate identity by path, not by scan order', () => {
    const duplicate = `${INTENT_IMPORT}
export const dup = defineIntent({
  id: 'alpha.first',
  description: 'A second declaration of the same id',
  target: { registry: 'control', action: 'focus' },
});
`;
    const first = surfaceOf(duplicate, 'a/one.intents.ts');
    const second = surfaceOf(duplicate, 'z/two.intents.ts');

    const forward = mergeAgentSurfaces([first, second]);
    const reverse = mergeAgentSurfaces([second, first]);

    expect(forward).toEqual(reverse);
    expect(forward.intents).toHaveLength(1);
    expect(forward.intents[0].filePath).toBe('a/one.intents.ts');
    expect(forward.diagnostics).toHaveLength(1);
    expect(forward.diagnostics[0]).toMatchObject({
      code: 'duplicate-identity',
      filePath: 'z/two.intents.ts',
    });
  });

  it('resolves a derived tool-name collision the same way, in either order', () => {
    // `intentToolName` is not injective: both of these flatten to
    // `orders_foo_bar`, and `defineIntent` rejects the second registration. Two
    // emitted entries where only one can exist would overstate the surface.
    const first = surfaceOf(
      `${INTENT_IMPORT}
export const a = defineIntent({
  id: 'orders.foo_bar',
  description: 'Underscored',
  target: { registry: 'control', action: 'focus' },
});
`,
      'a/one.intents.ts',
    );
    const second = surfaceOf(
      `${INTENT_IMPORT}
export const b = defineIntent({
  id: 'orders.foo.bar',
  description: 'Dotted',
  target: { registry: 'control', action: 'focus' },
});
`,
      'z/two.intents.ts',
    );

    const forward = mergeAgentSurfaces([first, second]);
    const reverse = mergeAgentSurfaces([second, first]);

    expect(forward).toEqual(reverse);
    expect(forward.intents.map((intent) => intent.id)).toEqual([
      'orders.foo_bar',
    ]);
    expect(forward.diagnostics).toHaveLength(1);
    expect(forward.diagnostics[0]).toMatchObject({
      code: 'duplicate-identity',
      filePath: 'z/two.intents.ts',
    });
    expect(forward.diagnostics[0].message).toContain('orders_foo_bar');
  });

  it('records source paths relative to the scan root, in POSIX form', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-'));
    try {
      const intentPath = join(root, 'src', 'lib', 'orders.intents.ts');
      mkdirSync(dirname(intentPath), { recursive: true });
      writeFileSync(intentPath, LITERAL_INTENT);
      const componentPath = join(root, 'src', 'lib', 'Inline.svelte');
      writeFileSync(
        componentPath,
        `<script lang="ts">
  import { defineIntent } from '@happyvertical/smrt-web/intents';
  const bad = defineIntent({ id: 'orders.inline' });
</script>
`,
      );

      const { results } = await new OxcScanner({
        cwd: root,
        include: ['**/*.ts'],
      }).scanAndResolve();

      expect(results.agentSurface.intents.map((i) => i.filePath)).toEqual([
        'src/lib/orders.intents.ts',
      ]);
      expect(
        results.agentSurface.diagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.filePath,
        ]),
      ).toEqual([['svelte-declaration', 'src/lib/Inline.svelte']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('scan cost', () => {
  it('skips the walk for a source that names neither helper', () => {
    expect(sourceMayDeclareAgentSurface('export const x = 1;')).toBe(false);
    expect(sourceMayDeclareAgentSurface(LITERAL_INTENT)).toBe(true);
    expect(sourceMayDeclareAgentSurface(LITERAL_PLAYBOOK)).toBe(true);
  });

  it('leaves `agentSurface` absent on a file that declares nothing', () => {
    expect(parseSource('export const x = 1;', 'plain.ts').agentSurface).toBe(
      undefined,
    );
  });

  it('exposes the extractor directly for callers holding a parsed program', () => {
    // The scanner's own path goes through `parseSource`; this asserts the
    // exported entry point stays usable on its own.
    const surface = extractAgentSurface({
      body: [],
      sourceText: '',
      filePath: 'empty.ts',
    });
    expect(surface).toEqual({ intents: [], playbooks: [], diagnostics: [] });
  });
});
