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
  checkAgentSurfaceToolNames,
  extractAgentSurface,
  isAgentSurfaceSourcePath,
  isPrunedAgentSurfacePath,
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

  it('rejects a malformed capability instead of quietly defaulting it', () => {
    // The fail-closed default is for an OMITTED capability, not a typo'd one.
    // Defaulting `{ effect: 'reed' }` would emit an entry the runtime refuses
    // and hide the typo behind a plausible-looking classification.
    for (const [capability, expected] of [
      [`{ effect: 'reed' }`, "capability.effect 'reed'"],
      [`{ effect: 'read', retries: 2 }`, "unknown capability key 'retries'"],
      [`{ idempotent: 'yes' }`, 'non-boolean capability.idempotent'],
    ] as const) {
      const surface = surfaceOf(`${INTENT_IMPORT}
export const a = defineIntent({
  id: 'orders.bad_capability',
  description: 'Malformed capability',
  capability: ${capability},
  target: { registry: 'control', action: 'focus' },
});
`);
      expect(surface.intents).toEqual([]);
      expect(surface.diagnostics[0].message).toContain(expected);
    }
  });

  it('rejects a playbook with an empty step list', () => {
    const surface = surfaceOf(`${PLAYBOOK_IMPORT}
export const a = definePlaybook({
  key: 'commerce.nothing',
  title: 'Nothing',
  description: 'No steps at all',
  steps: [],
});
`);
    expect(surface.playbooks).toEqual([]);
    expect(surface.diagnostics[0].message).toContain('declares no steps');
  });

  it('rejects a whitespace-only identifier the runtime would refuse', () => {
    // The runtime normalizers reject these with `trim() === ''`, so treating
    // whitespace as present would emit a playbook that throws at registration.
    const surface = surfaceOf(`${PLAYBOOK_IMPORT}
export const a = definePlaybook({
  key: '   ',
  title: 'Blank key',
  description: 'Whitespace is not an identifier',
  steps: [{ kind: 'operation', model: '@pkg:Order', action: 'submit' }],
});
`);
    expect(surface.playbooks).toEqual([]);
    expect(surface.diagnostics[0].code).toBe('incomplete-declaration');

    const blankAction = surfaceOf(`${PLAYBOOK_IMPORT}
export const b = definePlaybook({
  key: 'commerce.blank_action',
  title: 'Blank action',
  description: 'Step action is whitespace',
  steps: [{ kind: 'operation', model: '@pkg:Order', action: '  ' }],
});
`);
    expect(blankAction.playbooks).toEqual([]);
  });

  it('rejects a target identifier outside `assertIdentifier` bounds', () => {
    const tooLong = surfaceOf(`${INTENT_IMPORT}
export const a = defineIntent({
  id: 'orders.long_control',
  description: 'controlId past the identifier bound',
  target: { registry: 'control', action: 'focus', controlId: '${'x'.repeat(257)}' },
});
`);
    expect(tooLong.intents).toEqual([]);
    expect(tooLong.diagnostics[0].message).toContain('256 characters');

    const controlChar = surfaceOf(`${INTENT_IMPORT}
export const b = defineIntent({
  id: 'orders.control_char',
  description: 'formId carries a control character',
  target: { registry: 'control', action: 'focus', formId: 'a\\u0007b' },
});
`);
    expect(controlChar.intents).toEqual([]);
    expect(controlChar.diagnostics[0].message).toContain('control character');
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

  it('finds sidecars OUTSIDE the class-scan include glob', async () => {
    // The shipped SvelteKit template scans `src/lib/objects/**/*.ts` for its
    // models, but an intent sidecar lives beside the component that uses it.
    // Binding declaration discovery to the class glob made those declarations
    // vanish from every artifact with no diagnostic at all.
    const root = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-glob-'));
    try {
      mkdirSync(join(root, 'src', 'lib', 'objects'), { recursive: true });
      mkdirSync(join(root, 'src', 'lib', 'agent'), { recursive: true });
      writeFileSync(
        join(root, 'src', 'lib', 'objects', 'Order.ts'),
        'export class Order {}\n',
      );
      writeFileSync(
        join(root, 'src', 'lib', 'agent', 'orders.intents.ts'),
        LITERAL_INTENT,
      );
      writeFileSync(
        join(root, 'src', 'lib', 'agent', 'checkout.playbooks.ts'),
        LITERAL_PLAYBOOK,
      );

      const { results } = await new OxcScanner({
        cwd: root,
        // Deliberately narrow, exactly as the template configures it.
        include: ['src/lib/objects/**/*.ts'],
      }).scanAndResolve();

      expect(results.agentSurface.intents.map((i) => i.id)).toEqual([
        'orders.next_page',
      ]);
      expect(results.agentSurface.playbooks.map((p) => p.key)).toEqual([
        'commerce.checkout',
      ]);
      expect(results.agentSurface.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never reads build output, even when the caller narrows `exclude`', async () => {
    // A caller's `exclude` REPLACES the scanner defaults, and every real caller
    // passes one narrower than them — the Vite plugin sends only test globs
    // plus node_modules. A transpiling build keeps both the import specifier
    // and the module-scope call in its output, so `dist/` matches this matcher
    // exactly; and because `dist` sorts before `src`, it would WIN the
    // duplicate tie and become the recorded source of the declaration.
    const root = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-dist-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'dist'), { recursive: true });
      mkdirSync(join(root, 'src', '__tests__'), { recursive: true });
      writeFileSync(join(root, 'src', 'orders.intents.ts'), LITERAL_INTENT);
      writeFileSync(join(root, 'dist', 'orders.intents.js'), LITERAL_INTENT);
      writeFileSync(
        join(root, 'src', '__tests__', 'fixture.intents.ts'),
        LITERAL_PLAYBOOK,
      );

      const { results } = await new OxcScanner({
        cwd: root,
        include: ['src/**/*.ts'],
        // Exactly what the Vite plugin passes.
        exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
      }).scanAndResolve();

      expect(results.agentSurface.intents.map((i) => i.filePath)).toEqual([
        'src/orders.intents.ts',
      ]);
      // Neither the transpiled copy nor the test fixture may appear, and
      // neither may raise a duplicate-identity diagnostic.
      expect(results.agentSurface.playbooks).toEqual([]);
      expect(results.agentSurface.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('measures pruned directories relative to the root, not absolutely', async () => {
    // A checkout that merely LIVES under `build/` — a container with
    // `WORKDIR /build`, a clone in `~/build/…` — must not disable the feature.
    // Matching these segments against the absolute path would drop every
    // declaration with no diagnostic, and the freshness check would agree,
    // so the artifact would ship an empty surface and doctor would call it
    // healthy. This is the trap `discovery.ts` rewrites globs to avoid.
    const parent = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-abs-'));
    const root = join(parent, 'build', 'app');
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'orders.intents.ts'), LITERAL_INTENT);

      const { results } = await new OxcScanner({
        cwd: root,
        include: ['src/**/*.ts'],
      }).scanAndResolve();

      expect(results.agentSurface.intents.map((i) => i.id)).toEqual([
        'orders.next_page',
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('answers the prune question directly, not only through discovery', () => {
    // The scanner-level tests below drive `OxcScanner`, where
    // `discoverSourceFiles` already drops several of these by glob before the
    // predicate is consulted — so they cannot pin the predicate itself. The
    // CHECKER enumerates files directly and has only this function to go on,
    // which is exactly where every emitter/checker disagreement came from.
    const root = '/repo/app';
    const accepted = 'src/lib/orders.intents.ts';
    expect(isAgentSurfaceSourcePath(`${root}/${accepted}`, root)).toBe(true);

    for (const rejected of [
      'src/.generated/orders.intents.ts',
      'src/.orders.intents.ts',
      'dist/orders.intents.js',
      'build/orders.intents.js',
      'coverage/orders.intents.js',
      'src/__tests__/fixture.intents.ts',
      'src/__typechecks__/fixture.intents.ts',
      'node_modules/pkg/orders.intents.js',
      'src/orders.intents.test.ts',
      'src/orders.intents.spec.ts',
      'src/orders.intents.d.ts',
      'src/orders.intents.svelte',
    ]) {
      expect(isAgentSurfaceSourcePath(`${root}/${rejected}`, root)).toBe(false);
    }

    // A `.svelte` path can never go through the source predicate, so the prune
    // half is what its two callers share.
    expect(
      isPrunedAgentSurfacePath(`${root}/src/lib/Inline.svelte`, root),
    ).toBe(false);
    for (const pruned of [
      'src/.generated/Inline.svelte',
      'src/__tests__/Inline.svelte',
      'build/Inline.svelte',
    ]) {
      expect(isPrunedAgentSurfacePath(`${root}/${pruned}`, root)).toBe(true);
    }

    // The root itself living under a pruned name must not reject everything —
    // segments are measured relative to it.
    expect(
      isAgentSurfaceSourcePath(
        '/build/app/src/orders.intents.ts',
        '/build/app',
      ),
    ).toBe(true);
  });

  it('ignores hidden paths, the way discovery already does', async () => {
    // `discoverSourceFiles` ignores `**/.*` unconditionally, so the emitter
    // never reads these. The shared predicate has to say so too, or the
    // freshness walk — which enumerates files directly rather than globbing —
    // counts a declaration the emitter skipped.
    const root = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-dot-'));
    try {
      mkdirSync(join(root, 'src', '.generated'), { recursive: true });
      writeFileSync(
        join(root, 'src', '.generated', 'orders.intents.ts'),
        LITERAL_INTENT,
      );

      const { results } = await new OxcScanner({
        cwd: root,
        include: ['src/**/*.ts'],
      }).scanAndResolve();

      expect(results.agentSurface.intents).toEqual([]);
      expect(results.agentSurface.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never counts a declaration twice when both passes cover the file', async () => {
    // The class glob and the declaration glob overlap by default; a file
    // visited by both must not collide with itself.
    const root = mkdtempSync(join(tmpdir(), 'smrt-agent-surface-overlap-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'orders.intents.ts'), LITERAL_INTENT);

      const { results } = await new OxcScanner({
        cwd: root,
        include: ['src/**/*.ts'],
      }).scanAndResolve();

      expect(results.agentSurface.intents).toHaveLength(1);
      expect(results.agentSurface.diagnostics).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('collisions with names this pass does not own (#2725)', () => {
  /**
   * A merged surface holding exactly the intents named, each in its own file.
   *
   * `checkAgentSurfaceToolNames` runs on the MERGED result on purpose: the
   * intent-vs-intent losers are already gone by then, so a dropped declaration
   * can never also be reported as colliding with a generated tool.
   */
  function surfaceWithIntents(...ids: string[]): AgentSurface {
    return mergeAgentSurfaces(
      ids.map((id, index) =>
        surfaceOf(
          `${INTENT_IMPORT}
export const intent${index} = defineIntent({
  id: '${id}',
  description: 'Declared intent',
  target: { registry: 'control', action: 'focus' },
});
`,
          `src/lib/intent-${index}.intents.ts`,
        ),
      ),
    );
  }

  it('reports an intent that lands on a generated model tool name', () => {
    // The flagship case: `product.list` flattens to `product_list`, which is
    // exactly `${className.toLowerCase()}_${action}` for a `Product` exposing
    // `list`. Nothing compared them before, so `smrt doctor` listed both as
    // present under one name.
    const surface = surfaceWithIntents('product.list');

    const diagnostics = checkAgentSurfaceToolNames(surface, {
      generatedToolNames: [
        { name: 'product_list', declaredBy: 'Product.list' },
        { name: 'product_get', declaredBy: 'Product.get' },
      ],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'tool-name-collision',
      helper: 'defineIntent',
      filePath: 'src/lib/intent-0.intents.ts',
    });
    expect(diagnostics[0].message).toContain('`product.list`');
    expect(diagnostics[0].message).toContain('`product_list`');
    expect(diagnostics[0].message).toContain('`Product.list`');
    expect(diagnostics[0].message).toContain('namespace');
  });

  it('states the runtime precondition the generated-tool collision assumes', () => {
    // A build cannot see the provider's `namespace` or `effects` policy, and a
    // `namespace` prefixes generated tools while leaving intents alone — so for
    // a namespaced app there is no collision and this notice is wrong every
    // time it fires. Asserting it flatly would recommend the remedy that app
    // had already applied and leave renaming a correct intent as the only
    // clearing action. The caller CAN pass namespaced names when it knows them;
    // when it cannot, the message has to carry the condition.
    const [diagnostic] = checkAgentSurfaceToolNames(
      surfaceWithIntents('product.list'),
      { generatedToolNames: [{ name: 'product_list' }] },
    );

    expect(diagnostic.message).toContain('with no WebMCP `namespace`');
    expect(diagnostic.message).toContain('`effects`');
    expect(diagnostic.message).toContain('disregard this');
    // And it names the runtime outcome the lock (#2613) actually produces, so
    // an author who ignores the notice knows what to look for at mount.
    expect(diagnostic.message).toContain('WebMcpToolNameCollisionError');
  });

  it('emits the colliding intent rather than dropping it', () => {
    // The asymmetry with intent-vs-intent, asserted rather than described.
    // `defineIntent` REJECTS a second colliding intent, so only one can exist
    // and the merge drops the loser; it accepts this id, the declaration is
    // real, and which registration survives is a runtime question. Dropping it
    // would make the emitted surface disagree with the source.
    const surface = surfaceWithIntents('product.list');

    checkAgentSurfaceToolNames(surface, {
      generatedToolNames: [
        { name: 'product_list', declaredBy: 'Product.list' },
      ],
    });

    expect(surface.intents.map((intent) => intent.id)).toEqual([
      'product.list',
    ]);
    expect(surface.diagnostics).toEqual([]);
  });

  it('does NOT report an action the exposure policy leaves unexposed', () => {
    // The reason the comparison takes NAMES and not classes: a `Report` that
    // excludes `list` never registers `report_list`, so `report.list` is free.
    // Comparing against every verb a class could expose would invent this one.
    const surface = surfaceWithIntents('product.list', 'report.list');

    const diagnostics = checkAgentSurfaceToolNames(surface, {
      generatedToolNames: [
        { name: 'product_list', declaredBy: 'Product.list' },
        { name: 'report_get', declaredBy: 'Report.get' },
      ],
    });

    expect(diagnostics.map((diagnostic) => diagnostic.filePath)).toEqual([
      'src/lib/intent-0.intents.ts',
    ]);
    expect(diagnostics[0].message).toContain('`product.list`');
  });

  it('reports nothing when no generated names are supplied', () => {
    expect(
      checkAgentSurfaceToolNames(surfaceWithIntents('product.list')),
    ).toEqual([]);
  });

  it('reports an intent that lands on a fixed UI tool under the CONFIGURED prefix', () => {
    // `defineIntent` reserves only the literal `smrt_ui_`, so this id is
    // accepted and the intent really registers — and then collides with the
    // six fixed UI tools of an app whose `ui.prefix` is `agent_ui_`.
    const surface = surfaceWithIntents('agent.ui.list_form_controls');

    const diagnostics = checkAgentSurfaceToolNames(surface, {
      uiToolPrefixes: ['agent_ui_'],
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: 'tool-name-collision',
      helper: 'defineIntent',
      filePath: 'src/lib/intent-0.intents.ts',
    });
    expect(diagnostics[0].message).toContain('`agent_ui_list_form_controls`');
    expect(diagnostics[0].message).toContain('`agent_ui_`');
    expect(diagnostics[0].message).toContain('ui.prefix');
    expect(diagnostics[0].message).toContain('WebMcpToolNameCollisionError');
  });

  it('covers all six fixed UI tools, and nothing that merely resembles them', () => {
    const suffixes = [
      'list_form_controls',
      'inspect_form_control',
      'execute_form_control',
      'list_data_surfaces',
      'inspect_data_surface',
      'execute_data_surface_control',
    ];
    for (const suffix of suffixes) {
      expect(
        checkAgentSurfaceToolNames(surfaceWithIntents(`agent.ui.${suffix}`), {
          uiToolPrefixes: ['agent_ui_'],
        }),
      ).toHaveLength(1);
    }
    // Not a fixed UI tool name at all.
    expect(
      checkAgentSurfaceToolNames(surfaceWithIntents('agent.ui.list_forms'), {
        uiToolPrefixes: ['agent_ui_'],
      }),
    ).toEqual([]);
  });

  it('never fires under the DEFAULT prefix, where it could only be wrong', () => {
    // The reason the prefixes are supplied rather than derived from the name.
    // Deriving would flag every one of these — `orders_`, `admin_`, `` and a
    // 65-character remainder are all prefixes SOME app could configure — while
    // under the default `smrt_ui_` not one of them is a fixed UI tool. The only
    // name that would be is already rejected by `intentIdentityProblem`, so a
    // derived rule has no true positive here at all, and every diagnostic it
    // emitted for a default-configured app would be false.
    const shadowShaped = [
      'orders.list_data_surfaces',
      'admin.inspect_form_control',
      'list.form_controls',
      `${'a'.repeat(64)}.list_form_controls`,
    ];

    for (const id of shadowShaped) {
      expect(checkAgentSurfaceToolNames(surfaceWithIntents(id))).toEqual([]);
    }
  });

  it('ignores a prefix `registerWebMcpUiTools` would itself reject', () => {
    // Such a prefix mounts no UI tools, so it owns no names. Skipped rather
    // than thrown: an advisory pass must not fail a build over its own input.
    const surface = surfaceWithIntents('agent.ui.list_form_controls');

    expect(
      checkAgentSurfaceToolNames(surface, {
        uiToolPrefixes: ['1_bad_start', '', 'a'.repeat(65)],
      }),
    ).toEqual([]);
  });

  it('leaves `smrt_ui_*` to the hard identity failure, and does not double-report it', () => {
    // The issue asked whether an intent under `smrt_ui_*` should become legal
    // for an app that moved its UI tools elsewhere. It must not:
    // `defineIntent` rejects such an id UNCONDITIONALLY
    // (`RESERVED_TOOL_NAME_PREFIX` in `packages/smrt-web/src/intents.ts`),
    // wherever the UI tools live. Accepting it here would emit an entry the
    // runtime refuses to construct — an advertised operation that can never
    // register, which is worse than no entry at all. So it stays an
    // `invalid-identity` failure, and this pass must not also describe it as
    // an advisory collision: one id, one answer.
    const rejected = surfaceOf(
      `${INTENT_IMPORT}
export const shadow = defineIntent({
  id: 'smrt.ui.list_form_controls',
  description: 'Shadows a fixed UI tool',
  target: { registry: 'control', action: 'focus' },
});
`,
      'src/lib/shadow.intents.ts',
    );
    const merged = mergeAgentSurfaces([rejected]);

    expect(merged.intents).toEqual([]);
    expect(merged.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'invalid-identity',
    ]);
    expect(merged.diagnostics[0].message).toContain('smrt_ui_');
    expect(
      checkAgentSurfaceToolNames(merged, { uiToolPrefixes: ['smrt_ui_'] }),
    ).toEqual([]);
  });

  it('reports both collisions for one intent, in a stable order', () => {
    // A single name can be taken twice over. Emission must not depend on the
    // order the caller happened to hand names in, for the same reason
    // `mergeAgentSurfaces` sorts: a churning artifact proves nothing.
    const surface = surfaceWithIntents(
      'agent.ui.list_form_controls',
      'product.list',
    );
    const names = [
      { name: 'product_list', declaredBy: 'Product.list' },
      {
        name: 'agent_ui_list_form_controls',
        declaredBy: 'AgentUi.listFormControls',
      },
    ];

    const forward = checkAgentSurfaceToolNames(surface, {
      generatedToolNames: names,
      uiToolPrefixes: ['agent_ui_'],
    });
    const reverse = checkAgentSurfaceToolNames(surface, {
      generatedToolNames: [...names].reverse(),
      uiToolPrefixes: ['agent_ui_'],
    });

    expect(forward).toEqual(reverse);
    expect(forward.map((diagnostic) => diagnostic.filePath)).toEqual([
      'src/lib/intent-0.intents.ts',
      'src/lib/intent-0.intents.ts',
      'src/lib/intent-1.intents.ts',
    ]);
  });

  it('names the generated tool generically when the caller gives no owner', () => {
    const diagnostics = checkAgentSurfaceToolNames(
      surfaceWithIntents('product.list'),
      { generatedToolNames: [{ name: 'product_list' }] },
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('a generated model action');
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
