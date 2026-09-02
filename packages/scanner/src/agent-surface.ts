/**
 * Agent-surface matcher (#2591).
 *
 * The class scanner discovers `@smrt()`-decorated classes by matching
 * DECORATORS. Neither a view intent (#2588) nor a playbook (#2589) is a class,
 * so this module adds the second recognizable shape the framework emits from:
 * a **module-scope call with a single object-literal argument**.
 *
 * ```ts
 * import { defineIntent } from '@happyvertical/smrt-web/intents';
 * export const nextPage = defineIntent({ id: 'orders.next_page', ... });
 * ```
 *
 * It keeps exactly the discipline the decorator matcher keeps:
 *
 * - **structural only** — nothing is evaluated, no import is followed, no
 *   module is loaded. A value that is not spelled literally in the argument is
 *   not a value this matcher can read;
 * - **never a silent drop** — every declaration this matcher recognizes but
 *   cannot read produces a diagnostic naming `useWebMcpTool`, the documented
 *   escape hatch for a tool set that genuinely cannot be static. A declaration
 *   that vanishes from the emitted surface without a word is the failure mode
 *   this module exists to prevent;
 * - **binding-aware** — a call is matched only when its callee resolves to an
 *   import binding from the ONE accepted specifier per helper. A local helper
 *   that happens to be named `defineIntent` is not a view intent.
 *
 * Accepted import specifiers, exactly:
 *
 * | Helper | Specifier |
 * | --- | --- |
 * | `defineIntent` | `@happyvertical/smrt-web/intents` |
 * | `definePlaybook` | `@happyvertical/smrt-playbooks` |
 *
 * `defineIntent` deliberately ships ONLY from the `/intents` subpath entry, so
 * an `OrderTable.intents.ts` sidecar never drags the client-data engine into a
 * page (see `packages/smrt-web/AGENTS.md`). Recognizing the subpath and not the
 * package root is therefore part of the contract, not an omission.
 */

import { readFileSync } from 'node:fs';
import { getLineColumn } from './source-location.js';
import type {
  AgentSurface,
  AgentSurfaceCapability,
  AgentSurfaceDiagnostic,
  AgentSurfaceHelper,
  AgentSurfaceIntent,
  AgentSurfacePlaybook,
  AgentSurfacePlaybookStep,
} from './types.js';

/** Import specifier that makes a callee name mean the framework helper. */
const HELPER_SPECIFIERS: Readonly<Record<AgentSurfaceHelper, string>> = {
  defineIntent: '@happyvertical/smrt-web/intents',
  definePlaybook: '@happyvertical/smrt-playbooks',
};

const HELPER_NAMES = Object.keys(HELPER_SPECIFIERS) as AgentSurfaceHelper[];

/**
 * The sentence every "this is not static" diagnostic ends with. Named
 * explicitly because the escape hatch is the actionable half of the message: a
 * computed tool set is not a bug, it is simply the other path.
 */
const ESCAPE_HATCH =
  'A declaration the scanner cannot read without evaluating it is not emittable — ' +
  'use `useWebMcpTool` for a tool set derived from computed or fetched data.';

const MAX_LITERAL_DEPTH = 32;

// ---------------------------------------------------------------------------
// Minimal structural AST view
// ---------------------------------------------------------------------------

interface AstNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Resolve the local names bound to each helper by an accepted import.
 *
 * Handles the two forms an author actually writes: a named import (with or
 * without an alias) and a namespace import. A default import is deliberately
 * NOT accepted — neither package has a default export, so treating one as the
 * helper would be inventing a contract.
 */
function collectHelperBindings(
  body: readonly AstNode[],
): Map<string, AgentSurfaceHelper> {
  const bindings = new Map<string, AgentSurfaceHelper>();
  const namespaces = new Map<string, string>();

  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source as { value?: unknown } | undefined;
    if (!source || typeof source.value !== 'string') continue;
    const specifier = source.value;
    const specifiers = (node.specifiers as AstNode[] | undefined) ?? [];

    for (const spec of specifiers) {
      const local = (spec.local as { name?: string } | undefined)?.name;
      if (!local) continue;

      if (spec.type === 'ImportSpecifier') {
        const imported = (spec.imported as { name?: string } | undefined)?.name;
        const helper = HELPER_NAMES.find(
          (name) => name === imported && HELPER_SPECIFIERS[name] === specifier,
        );
        if (helper) bindings.set(local, helper);
        continue;
      }

      if (spec.type === 'ImportNamespaceSpecifier') {
        namespaces.set(local, specifier);
      }
    }
  }

  // Namespace imports are recorded as `local.helperName` keys so a
  // `MemberExpression` callee resolves through the same map as a plain
  // identifier.
  for (const [local, specifier] of namespaces) {
    for (const helper of HELPER_NAMES) {
      if (HELPER_SPECIFIERS[helper] === specifier) {
        bindings.set(`${local}.${helper}`, helper);
      }
    }
  }

  return bindings;
}

/** Resolve a callee expression to the helper it names, if any. */
function resolveCallee(
  callee: unknown,
  bindings: ReadonlyMap<string, AgentSurfaceHelper>,
): AgentSurfaceHelper | undefined {
  if (!isNode(callee)) return undefined;
  if (callee.type === 'Identifier') {
    return bindings.get(String(callee.name));
  }
  if (callee.type === 'MemberExpression' && callee.computed !== true) {
    const object = callee.object;
    const property = callee.property;
    if (
      isNode(object) &&
      object.type === 'Identifier' &&
      isNode(property) &&
      property.type === 'Identifier'
    ) {
      return bindings.get(`${String(object.name)}.${String(property.name)}`);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Literal extraction
// ---------------------------------------------------------------------------

interface LiteralFailure {
  reason: string;
  start?: number;
}

/**
 * Read an expression as pure JSON data, or record why it cannot be read.
 *
 * Deliberately narrower than the decorator-config extractor: that one resolves
 * spreads against module-scope constants because a dropped `@smrt({ ...CFG })`
 * key would silently reopen an exposure surface. Here the requirement runs the
 * other way — the emitted entry must be exactly what an author can see in one
 * object literal — so a spread, an identifier reference, a call, a template
 * literal, and a conditional are all refused rather than partially resolved.
 */
function readLiteral(
  node: unknown,
  failures: LiteralFailure[],
  path: string,
  depth = 0,
): unknown {
  if (!isNode(node)) {
    failures.push({ reason: `${path} is not a readable expression` });
    return undefined;
  }
  if (depth > MAX_LITERAL_DEPTH) {
    failures.push({
      reason: `${path} nests deeper than ${MAX_LITERAL_DEPTH} levels`,
      start: node.start,
    });
    return undefined;
  }

  switch (node.type) {
    case 'Literal': {
      const value = node.value;
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        typeof value === 'number'
      ) {
        return value;
      }
      failures.push({
        reason: `${path} is not a JSON literal`,
        start: node.start,
      });
      return undefined;
    }

    case 'UnaryExpression': {
      const argument = node.argument;
      if (
        node.operator === '-' &&
        isNode(argument) &&
        argument.type === 'Literal' &&
        typeof argument.value === 'number'
      ) {
        return -argument.value;
      }
      failures.push({
        reason: `${path} is a computed unary expression`,
        start: node.start,
      });
      return undefined;
    }

    case 'ArrayExpression': {
      const elements = (node.elements as unknown[] | undefined) ?? [];
      const result: unknown[] = [];
      elements.forEach((element, index) => {
        if (isNode(element) && element.type === 'SpreadElement') {
          failures.push({
            reason: `${path}[${index}] is a spread`,
            start: element.start,
          });
          return;
        }
        if (element === null) {
          failures.push({ reason: `${path}[${index}] is an array hole` });
          return;
        }
        result.push(
          readLiteral(element, failures, `${path}[${index}]`, depth + 1),
        );
      });
      return result;
    }

    case 'ObjectExpression': {
      const properties = (node.properties as AstNode[] | undefined) ?? [];
      const result: Record<string, unknown> = {};
      for (const property of properties) {
        if (property.type === 'SpreadElement') {
          failures.push({
            reason: `${path} contains a spread`,
            start: property.start,
          });
          continue;
        }
        if (property.type !== 'Property') {
          failures.push({
            reason: `${path} contains an unsupported member`,
            start: property.start,
          });
          continue;
        }
        if (property.computed === true || property.shorthand === true) {
          failures.push({
            reason: `${path} contains a ${
              property.computed === true ? 'computed' : 'shorthand'
            } key`,
            start: property.start,
          });
          continue;
        }
        const key = readPropertyKey(property.key);
        if (key === undefined) {
          failures.push({
            reason: `${path} contains a non-literal key`,
            start: property.start,
          });
          continue;
        }
        if (!isSafeKey(key)) {
          failures.push({
            reason: `${path}.${key} uses a reserved prototype key`,
            start: property.start,
          });
          continue;
        }
        result[key] = readLiteral(
          property.value,
          failures,
          `${path}.${key}`,
          depth + 1,
        );
      }
      return result;
    }

    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return readLiteral(node.expression, failures, path, depth);

    case 'Identifier': {
      const name = String(node.name);
      if (name === 'undefined') return undefined;
      failures.push({
        reason: `${path} references the identifier \`${name}\``,
        start: node.start,
      });
      return undefined;
    }

    case 'TemplateLiteral':
      failures.push({
        reason: `${path} is a template literal`,
        start: node.start,
      });
      return undefined;

    case 'ConditionalExpression':
      failures.push({
        reason: `${path} is a conditional expression`,
        start: node.start,
      });
      return undefined;

    default:
      failures.push({
        reason: `${path} is a computed \`${node.type}\``,
        start: node.start,
      });
      return undefined;
  }
}

function readPropertyKey(key: unknown): string | undefined {
  if (!isNode(key)) return undefined;
  if (key.type === 'Identifier') return String(key.name);
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** Prototype-pollution guard, mirroring the class parser's `isSafeObjectKey`. */
function isSafeKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

// ---------------------------------------------------------------------------
// Call discovery
// ---------------------------------------------------------------------------

interface MatchedCall {
  helper: AgentSurfaceHelper;
  node: AstNode;
  moduleScope: boolean;
}

function unwrapTypeWrappers(node: unknown): AstNode | undefined {
  let current = node;
  while (
    isNode(current) &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return isNode(current) ? current : undefined;
}

/**
 * Collect the CallExpression nodes that sit directly at module scope, in the
 * three positions a declaration is actually written:
 * `definePlaybook({...});`, `const x = defineIntent({...})`, and
 * `export default defineIntent({...})`.
 */
function collectModuleScopeCalls(body: readonly AstNode[]): Set<AstNode> {
  const calls = new Set<AstNode>();

  const addDeclaration = (declaration: unknown): void => {
    if (!isNode(declaration)) return;
    if (declaration.type !== 'VariableDeclaration') return;
    for (const declarator of (declaration.declarations as AstNode[]) ?? []) {
      const init = unwrapTypeWrappers(declarator.init);
      if (init && init.type === 'CallExpression') calls.add(init);
    }
  };

  for (const statement of body) {
    if (statement.type === 'ExpressionStatement') {
      const expression = unwrapTypeWrappers(statement.expression);
      if (expression && expression.type === 'CallExpression') {
        calls.add(expression);
      }
      continue;
    }
    if (statement.type === 'VariableDeclaration') {
      addDeclaration(statement);
      continue;
    }
    if (statement.type === 'ExportNamedDeclaration') {
      addDeclaration(statement.declaration);
      continue;
    }
    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = unwrapTypeWrappers(statement.declaration);
      if (declaration && declaration.type === 'CallExpression') {
        calls.add(declaration);
      }
    }
  }

  return calls;
}

/**
 * Walk the whole program for helper calls.
 *
 * The walk is deliberately exhaustive rather than module-scope-only: a
 * declaration written inside a function is not emittable, and finding it is the
 * only way to say so instead of dropping it in silence.
 */
function collectMatchedCalls(
  body: readonly AstNode[],
  bindings: ReadonlyMap<string, AgentSurfaceHelper>,
): MatchedCall[] {
  const moduleScope = collectModuleScopeCalls(body);
  const matches: MatchedCall[] = [];
  const seen = new Set<AstNode>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isNode(value) || seen.has(value)) return;
    seen.add(value);
    if (value.type === 'CallExpression') {
      const helper = resolveCallee(value.callee, bindings);
      if (helper) {
        matches.push({
          helper,
          node: value,
          moduleScope: moduleScope.has(value),
        });
      }
    }
    for (const key of Object.keys(value)) {
      if (key === 'type' || key === 'loc' || key === 'range') continue;
      visit(value[key]);
    }
  };

  visit(body as unknown);
  // Source order keeps diagnostics readable; emitted identity is sorted in
  // `mergeAgentSurfaces` and never depends on this order.
  matches.sort((a, b) => (a.node.start ?? 0) - (b.node.start ?? 0));
  return matches;
}

// ---------------------------------------------------------------------------
// Declaration normalization
// ---------------------------------------------------------------------------

/**
 * Resolve a partial capability declaration through the ONE fail-closed rule
 * (#2587, `@happyvertical/smrt-types` `CapabilityClassification`): an
 * undeclared capability is `destructive`, non-idempotent, open-world.
 *
 * Mirrored structurally rather than imported: this package carries no
 * `@happyvertical/*` dependency, because core depends on it and the cycle would
 * close. `smrt-web` mirrors the same contract for the same reason.
 */
function resolveCapability(declared: unknown): AgentSurfaceCapability {
  const value =
    typeof declared === 'object' && declared !== null
      ? (declared as Record<string, unknown>)
      : {};
  const effect = value.effect;
  return {
    effect:
      effect === 'read' || effect === 'write' || effect === 'destructive'
        ? effect
        : 'destructive',
    idempotent: value.idempotent === true,
    openWorld: value.openWorld !== false,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeSteps(
  value: unknown,
): AgentSurfacePlaybookStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: AgentSurfacePlaybookStep[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const step = entry as Record<string, unknown>;
    if (step.kind === 'operation') {
      const model = readString(step.model);
      const action = readString(step.action);
      if (!model || !action) return undefined;
      steps.push({ kind: 'operation', model, action });
      continue;
    }
    if (step.kind === 'intent') {
      const id = readString(step.id);
      if (!id) return undefined;
      steps.push({ kind: 'intent', id });
      continue;
    }
    return undefined;
  }
  return steps;
}

function normalizePlanes(value: unknown): Array<'browser' | 'server'> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is 'browser' | 'server' =>
        entry === 'browser' || entry === 'server',
    )
    .sort();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExtractAgentSurfaceOptions {
  /** Program body from an OXC parse. */
  body: readonly unknown[];
  /** Full source text, used for diagnostic line/column. */
  sourceText: string;
  /** Path recorded on every emitted entry and diagnostic. */
  filePath: string;
}

/**
 * Fast pre-check: a file that names neither helper cannot declare either, so
 * the AST walk is skipped entirely. Callers use it to keep the matcher off the
 * hot path of a large scan.
 */
export function sourceMayDeclareAgentSurface(sourceText: string): boolean {
  return HELPER_NAMES.some((helper) => sourceText.includes(helper));
}

/**
 * Match `defineIntent(...)` / `definePlaybook(...)` declarations in one parsed
 * module.
 *
 * @returns Emittable entries plus a diagnostic for every recognized call that
 *   is not emittable. A recognized call always produces exactly one of the two.
 */
export function extractAgentSurface(
  options: ExtractAgentSurfaceOptions,
): AgentSurface {
  const { sourceText, filePath } = options;
  const body = (options.body as AstNode[]).filter(isNode);
  const intents: AgentSurfaceIntent[] = [];
  const playbooks: AgentSurfacePlaybook[] = [];
  const diagnostics: AgentSurfaceDiagnostic[] = [];

  const bindings = collectHelperBindings(body);
  if (bindings.size === 0) return { intents, playbooks, diagnostics };

  const report = (
    code: AgentSurfaceDiagnostic['code'],
    helper: AgentSurfaceHelper,
    message: string,
    start?: number,
  ): void => {
    const loc =
      start === undefined ? undefined : getLineColumn(sourceText, start);
    diagnostics.push({
      code,
      helper,
      message,
      filePath,
      line: loc?.line,
      column: loc?.column,
    });
  };

  for (const match of collectMatchedCalls(body, bindings)) {
    const { helper, node } = match;

    if (!match.moduleScope) {
      report(
        'not-module-scope',
        helper,
        `\`${helper}()\` must be called at module scope to be emitted into the manifest and knowledge graph. ${ESCAPE_HATCH}`,
        node.start,
      );
      continue;
    }

    const args = (node.arguments as unknown[] | undefined) ?? [];
    if (args.length !== 1) {
      report(
        'argument-count',
        helper,
        `\`${helper}()\` takes exactly one object-literal argument; found ${args.length}. ${ESCAPE_HATCH}`,
        node.start,
      );
      continue;
    }

    const argument = unwrapTypeWrappers(args[0]);
    if (!argument || argument.type !== 'ObjectExpression') {
      report(
        'non-literal-argument',
        helper,
        `\`${helper}()\` must be called with an object literal, not a ${
          argument?.type ?? 'unknown expression'
        }. ${ESCAPE_HATCH}`,
        (argument ?? node).start,
      );
      continue;
    }

    const failures: LiteralFailure[] = [];
    const declaration = readLiteral(argument, failures, helper) as
      | Record<string, unknown>
      | undefined;

    if (failures.length > 0) {
      for (const failure of failures) {
        report(
          'non-literal-argument',
          helper,
          `${failure.reason}. ${ESCAPE_HATCH}`,
          failure.start ?? node.start,
        );
      }
      continue;
    }
    if (!declaration) continue;

    if (helper === 'defineIntent') {
      const id = readString(declaration.id);
      const description = readString(declaration.description);
      const target = declaration.target;
      if (
        !id ||
        !description ||
        typeof target !== 'object' ||
        target === null ||
        Array.isArray(target)
      ) {
        report(
          'incomplete-declaration',
          helper,
          'a view intent needs a literal `id`, `description`, and `target` to be emitted. ' +
            ESCAPE_HATCH,
          node.start,
        );
        continue;
      }
      intents.push({
        kind: 'intent',
        id,
        description,
        capability: resolveCapability(declaration.capability),
        target: target as Record<string, unknown>,
        hasInputSchema:
          typeof declaration.inputSchema === 'object' &&
          declaration.inputSchema !== null,
        // An intent moves mounted browser state, so it is browser-valid only.
        // A server-side agent reaches one through the #2446 command/ack bridge,
        // which the referencing playbook must declare explicitly.
        planes: ['browser'],
        filePath,
      });
      continue;
    }

    const key = readString(declaration.key);
    const title = readString(declaration.title);
    const description = readString(declaration.description);
    const steps = normalizeSteps(declaration.steps);
    if (!key || !title || !description || !steps) {
      report(
        'incomplete-declaration',
        helper,
        'a playbook needs a literal `key`, `title`, `description`, and a `steps` array of ' +
          '`{ kind: "operation", model, action }` / `{ kind: "intent", id }` members to be ' +
          `emitted. ${ESCAPE_HATCH}`,
        node.start,
      );
      continue;
    }
    const declaredPlanes = normalizePlanes(declaration.planes);
    playbooks.push({
      kind: 'playbook',
      key,
      title,
      description,
      steps,
      // Mirrors `smrt-playbooks`: silence means browser-only as soon as any
      // step is a view intent, because server validity for one rides the #2446
      // command/ack bridge and must be declared explicitly.
      planes:
        declaredPlanes.length > 0
          ? declaredPlanes
          : steps.some((step) => step.kind === 'intent')
            ? ['browser']
            : ['browser', 'server'],
      planesDeclared: declaredPlanes.length > 0,
      onStepFailure:
        declaration.onStepFailure === 'continue' ? 'continue' : 'abort',
      enabled: declaration.enabled !== false,
      filePath,
    });
  }

  return { intents, playbooks, diagnostics };
}

/**
 * Report `defineIntent` / `definePlaybook` written inside a `.svelte` file.
 *
 * The scanner walks `.ts` and `.tsx` only, so such a declaration is invisible
 * to every emitter — which is exactly why it must not be invisible to the
 * author. The check is textual on purpose: a Svelte template is not a
 * TypeScript program, and reaching for a Svelte compiler here would buy
 * nothing, since the answer is "move it to a `.ts` sidecar" regardless of what
 * the declaration says.
 *
 * Both the accepted import specifier and the call token must appear, so an
 * unrelated component that merely mentions the word is not flagged.
 */
export function scanSvelteAgentSurface(
  filePath: string,
  sourceText?: string,
): AgentSurfaceDiagnostic[] {
  let text: string;
  try {
    text = sourceText ?? readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const diagnostics: AgentSurfaceDiagnostic[] = [];
  for (const helper of HELPER_NAMES) {
    const callIndex = text.indexOf(`${helper}(`);
    if (callIndex === -1) continue;
    if (!text.includes(HELPER_SPECIFIERS[helper])) continue;
    const loc = getLineColumn(text, callIndex);
    const sidecar = helper === 'defineIntent' ? 'intents' : 'playbooks';
    diagnostics.push({
      code: 'svelte-declaration',
      helper,
      message:
        `\`${helper}()\` is called in a .svelte file, which the scanner never reads, so this ` +
        'declaration can never reach the manifest or knowledge graph. Move it to a `.ts` ' +
        `sidecar (\`Foo.${sidecar}.ts\`) and import it from the component. ${ESCAPE_HATCH}`,
      filePath,
      line: loc?.line,
      column: loc?.column,
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge per-file results into ONE deterministic surface.
 *
 * Emission must not depend on the order the file system happened to hand files
 * to the scanner — a cross-profile parity snapshot that churns on directory
 * order proves nothing. So identity is total and content-derived:
 *
 * - an intent is identified by its `id`, a playbook by its `key`;
 * - entries sort by that identity, then by the recorded source path;
 * - when two files declare the same identity, the entry from the
 *   lexicographically smaller path wins and the other is reported as a
 *   `duplicate-identity` diagnostic — a rule that gives the same answer for
 *   every input order, which "first one scanned wins" does not;
 * - diagnostics sort by path, then line, column, code, and message.
 *
 * `relativize` maps an absolute scan path to the stable path recorded in the
 * artifact; callers pass the package root's relativizer so a checked-in
 * artifact never carries a machine-specific absolute path.
 */
export function mergeAgentSurfaces(
  surfaces: readonly AgentSurface[],
  relativize: (filePath: string) => string = (filePath) => filePath,
): AgentSurface {
  const diagnostics: AgentSurfaceDiagnostic[] = [];
  const intents = new Map<string, AgentSurfaceIntent>();
  const playbooks = new Map<string, AgentSurfacePlaybook>();

  const claim = <T extends { filePath: string }>(
    bucket: Map<string, T>,
    identity: string,
    entry: T,
    helper: AgentSurfaceHelper,
    label: string,
  ): void => {
    const existing = bucket.get(identity);
    if (!existing) {
      bucket.set(identity, entry);
      return;
    }
    const [winner, loser] =
      entry.filePath < existing.filePath
        ? [entry, existing]
        : [existing, entry];
    bucket.set(identity, winner);
    diagnostics.push({
      code: 'duplicate-identity',
      helper,
      message:
        `${label} \`${identity}\` is declared in both \`${winner.filePath}\` and ` +
        `\`${loser.filePath}\`. Identity must be unique across the project; the declaration in ` +
        'the first path is emitted and this one is dropped.',
      filePath: loser.filePath,
    });
  };

  for (const surface of surfaces) {
    for (const intent of surface.intents) {
      claim(
        intents,
        intent.id,
        { ...intent, filePath: relativize(intent.filePath) },
        'defineIntent',
        'view intent',
      );
    }
    for (const playbook of surface.playbooks) {
      claim(
        playbooks,
        playbook.key,
        { ...playbook, filePath: relativize(playbook.filePath) },
        'definePlaybook',
        'playbook',
      );
    }
    for (const diagnostic of surface.diagnostics) {
      diagnostics.push({
        ...diagnostic,
        filePath: relativize(diagnostic.filePath),
      });
    }
  }

  return {
    intents: [...intents.values()].sort(
      (a, b) =>
        compareStrings(a.id, b.id) || compareStrings(a.filePath, b.filePath),
    ),
    playbooks: [...playbooks.values()].sort(
      (a, b) =>
        compareStrings(a.key, b.key) || compareStrings(a.filePath, b.filePath),
    ),
    diagnostics: diagnostics.sort(
      (a, b) =>
        compareStrings(a.filePath, b.filePath) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.column ?? 0) - (b.column ?? 0) ||
        compareStrings(a.code, b.code) ||
        compareStrings(a.message, b.message),
    ),
  };
}

/** An empty surface, for callers that skipped the scan. */
export function emptyAgentSurface(): AgentSurface {
  return { intents: [], playbooks: [], diagnostics: [] };
}
