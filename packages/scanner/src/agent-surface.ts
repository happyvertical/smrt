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

/**
 * Intent identity rules, mirrored from `defineIntent` in
 * `@happyvertical/smrt-web/intents`.
 *
 * Mirrored for the same reason the capability rule is: this package cannot
 * depend on `@happyvertical/smrt-web`. Keeping them in step matters more than
 * it looks — an emitted entry the runtime would REJECT is worse than no entry
 * at all, because `smrt doctor` and the knowledge graph would then advertise an
 * operation that can never register. If `defineIntent` tightens these, tighten
 * them here too.
 *
 * Playbook keys get no equivalent check because `definePlaybook` imposes no key
 * pattern — only uniqueness, which `mergeAgentSurfaces` already enforces.
 */
const INTENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_]*)+$/;
const INTENT_ID_MAX_LENGTH = 128;
const DESCRIPTION_MAX_LENGTH = 1024;
const RESERVED_TOOL_NAME_PREFIX = 'smrt_ui_';

/** Keys `defineIntent` accepts; anything else is a hard failure there. */
const INTENT_DECLARATION_KEYS = new Set([
  'id',
  'description',
  'inputSchema',
  'capability',
  'target',
]);
const CONTROL_TARGET_KEYS = new Set([
  'registry',
  'action',
  'formId',
  'controlId',
]);
const DATA_SURFACE_TARGET_KEYS = new Set([
  'registry',
  'controlId',
  'surfaceId',
  'kind',
]);
const CONTROL_ACTIONS = new Set([
  'focus',
  'reveal',
  'highlight',
  'explain',
  'validate',
  'stage',
  'apply',
  'discard',
  'clear',
  'undo',
]);
const DATA_SURFACE_KINDS = new Set(['table', 'list', 'report', 'custom']);

/**
 * Playbook rules, mirrored from `definePlaybook`'s normalizers in
 * `@happyvertical/smrt-playbooks`, for the same reason and with the same
 * obligation to stay in step.
 *
 * These are validated rather than repaired. Coercing an invalid `planes` to the
 * default would be worse than dropping the declaration: the artifact would
 * positively assert server validity the author never declared, which is exactly
 * the fail-open the plane rule exists to prevent.
 */
const PLAYBOOK_PLANES = new Set(['browser', 'server']);
const FAILURE_POLICIES = new Set(['abort', 'continue']);
const QUALIFIED_MODEL_PATTERN = /^\S+:\S+$/;

/** Derive the WebMCP tool name for an intent id, as `viewIntentToolName` does. */
function intentToolName(id: string): string {
  return id.replace(/[.-]/g, '_');
}

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

  // `export const intents = [defineIntent({…}), defineIntent({…})]` is a
  // plausible authoring form and is genuinely at module scope — not inside a
  // function, class, conditional, or loop, which is what the contract actually
  // forbids. Reporting it as "not at module scope" would be false and would
  // leave the author with no usable next step.
  const addInitializer = (value: unknown): void => {
    const init = unwrapTypeWrappers(value);
    if (!init) return;
    if (init.type === 'CallExpression') {
      calls.add(init);
      return;
    }
    if (init.type === 'ArrayExpression') {
      for (const element of (init.elements as unknown[]) ?? []) {
        const entry = unwrapTypeWrappers(element);
        if (entry && entry.type === 'CallExpression') calls.add(entry);
      }
    }
  };

  const addDeclaration = (declaration: unknown): void => {
    if (!isNode(declaration)) return;
    if (declaration.type !== 'VariableDeclaration') return;
    for (const declarator of (declaration.declarations as AstNode[]) ?? []) {
      addInitializer(declarator.init);
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

/**
 * Why this intent id could never register, or `undefined` when it can.
 *
 * The declaration types this against `string`, so an id that violates the
 * runtime pattern type-checks cleanly and fails only when the page loads.
 * Catching it here turns that into a build-time diagnostic.
 */
/**
 * Why this whole intent declaration could never register, or `undefined`.
 *
 * Mirrors `defineIntent`'s key allowlist, description bound, and
 * `normalizeTarget` — the closed `registry` union, the control-action union,
 * the required data-surface `controlId`, and the surface-kind union. Validating
 * only the id would still let `target: { registry: 'rest', url: … }` reach the
 * artifact verbatim, where an agent reads it as an addressable operation that
 * cannot exist.
 */
function intentDeclarationProblem(
  declaration: Record<string, unknown>,
  id: string,
  description: string,
): string | undefined {
  const identity = intentIdentityProblem(id);
  if (identity) return identity;

  for (const key of Object.keys(declaration)) {
    if (!INTENT_DECLARATION_KEYS.has(key)) {
      return `view intent '${id}' declares unknown key '${key}'. A declaration is data only — there is no field for an execute function, a URL, a route, or a fetch, and \`defineIntent\` rejects one.`;
    }
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return `view intent '${id}' has a description longer than ${DESCRIPTION_MAX_LENGTH} characters, which \`defineIntent\` rejects.`;
  }
  if (
    declaration.inputSchema !== undefined &&
    !isPlainRecord(declaration.inputSchema)
  ) {
    return `view intent '${id}' has an inputSchema that is not an object literal, which \`defineIntent\` rejects.`;
  }

  // The fail-closed default is for an OMITTED capability, not a malformed one.
  // Quietly defaulting `{ effect: 'reed' }` would emit an entry the runtime
  // refuses, and hide the typo behind a plausible-looking classification.
  const capability = declaration.capability;
  if (capability !== undefined) {
    if (!isPlainRecord(capability)) {
      return `view intent '${id}' has a capability that is not an object literal, which \`defineIntent\` rejects.`;
    }
    for (const key of Object.keys(capability)) {
      if (key !== 'effect' && key !== 'idempotent' && key !== 'openWorld') {
        return `view intent '${id}' declares unknown capability key '${key}', which \`defineIntent\` rejects.`;
      }
    }
    if (
      capability.effect !== undefined &&
      capability.effect !== 'read' &&
      capability.effect !== 'write' &&
      capability.effect !== 'destructive'
    ) {
      return `view intent '${id}' declares capability.effect '${String(capability.effect)}'; \`defineIntent\` accepts only read, write, or destructive.`;
    }
    for (const flag of ['idempotent', 'openWorld'] as const) {
      if (
        capability[flag] !== undefined &&
        typeof capability[flag] !== 'boolean'
      ) {
        return `view intent '${id}' declares a non-boolean capability.${flag}, which \`defineIntent\` rejects.`;
      }
    }
  }

  const target = declaration.target as Record<string, unknown>;
  const registry = target.registry;
  if (registry !== 'control' && registry !== 'dataSurface') {
    return `view intent '${id}' targets registry '${String(registry)}'; \`defineIntent\` accepts only 'control' or 'dataSurface'. An intent moves mounted browser state and has no path to REST.`;
  }

  const allowed =
    registry === 'control' ? CONTROL_TARGET_KEYS : DATA_SURFACE_TARGET_KEYS;
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) {
      return `view intent '${id}' declares unknown target key '${key}' for the '${registry}' registry, which \`defineIntent\` rejects.`;
    }
  }

  if (registry === 'control') {
    if (!CONTROL_ACTIONS.has(String(target.action))) {
      return `view intent '${id}' declares control action '${String(target.action)}', which is not a \`ControlInteractionRegistry\` command.`;
    }
    for (const key of ['formId', 'controlId'] as const) {
      if (target[key] !== undefined && !isNonEmptyString(target[key])) {
        return `view intent '${id}' has a non-string target.${key}.`;
      }
    }
    return undefined;
  }

  if (!isNonEmptyString(target.controlId)) {
    return `view intent '${id}' targets the dataSurface registry without a \`controlId\`, which \`defineIntent\` requires.`;
  }
  if (target.surfaceId !== undefined && !isNonEmptyString(target.surfaceId)) {
    return `view intent '${id}' has a non-string target.surfaceId.`;
  }
  if (
    target.kind !== undefined &&
    !DATA_SURFACE_KINDS.has(String(target.kind))
  ) {
    return `view intent '${id}' declares data-surface kind '${String(target.kind)}', which \`defineIntent\` rejects.`;
  }
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why this playbook declaration could never register, or `undefined`.
 *
 * Mirrors `definePlaybook`'s normalizers, which THROW on each of these rather
 * than defaulting. Repairing them here would be actively harmful for `planes`:
 * an author who wrote `planes: []` or a typo'd plane would get an emitted entry
 * claiming both planes, so the artifact would assert server validity nobody
 * declared.
 */
function playbookDeclarationProblem(
  declaration: Record<string, unknown>,
  key: string,
  steps: readonly AgentSurfacePlaybookStep[],
): string | undefined {
  if (steps.length === 0) {
    // `normalizeSteps` requires at least one step and throws. Emitting the
    // empty declaration would advertise a playbook that resolves to no plan.
    return `playbook '${key}' declares no steps; \`definePlaybook\` requires at least one.`;
  }

  const planes = declaration.planes;
  if (planes !== undefined && planes !== null) {
    if (!Array.isArray(planes)) {
      return `playbook '${key}' declares planes that are not an array, which \`definePlaybook\` rejects.`;
    }
    for (const plane of planes) {
      if (!PLAYBOOK_PLANES.has(String(plane))) {
        return `playbook '${key}' declares unknown plane '${String(plane)}'; expected 'browser' or 'server'.`;
      }
    }
    if (planes.length === 0) {
      return `playbook '${key}' declares an empty planes list; \`definePlaybook\` requires at least one, and defaulting it here would assert a validity the author never declared.`;
    }
  }

  const onStepFailure = declaration.onStepFailure;
  if (
    onStepFailure !== undefined &&
    !FAILURE_POLICIES.has(String(onStepFailure))
  ) {
    return `playbook '${key}' declares onStepFailure '${String(onStepFailure)}'; \`definePlaybook\` accepts only 'abort' or 'continue'.`;
  }

  const enabled = declaration.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return `playbook '${key}' declares a non-boolean \`enabled\`, which \`definePlaybook\` rejects rather than coercing — a truthy '"false"' would otherwise read as enabled.`;
  }

  for (const step of (declaration.steps as unknown[]) ?? []) {
    const record = step as Record<string, unknown>;
    if (
      record.kind === 'operation' &&
      !QUALIFIED_MODEL_PATTERN.test(String(record.model))
    ) {
      return `playbook '${key}' has a step whose model '${String(record.model)}' is not a qualified pair such as '@happyvertical/smrt-commerce:Order'.`;
    }
  }
  return undefined;
}

function intentIdentityProblem(id: string): string | undefined {
  if (id.length > INTENT_ID_MAX_LENGTH) {
    return `intent id '${id}' is longer than ${INTENT_ID_MAX_LENGTH} characters, which \`defineIntent\` rejects.`;
  }
  if (!INTENT_ID_PATTERN.test(id)) {
    return `intent id '${id}' must be lowercase and namespaced with at least one dot, e.g. 'orders.filter_by_status' — \`defineIntent\` rejects it as written, so emitting it would advertise an operation that can never register.`;
  }
  if (intentToolName(id).startsWith(RESERVED_TOOL_NAME_PREFIX)) {
    return `intent id '${id}' resolves into the reserved '${RESERVED_TOOL_NAME_PREFIX}' namespace of the six fixed UI tools, which \`defineIntent\` rejects.`;
  }
  return undefined;
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
      const problem = intentDeclarationProblem(declaration, id, description);
      if (problem) {
        // Emitting this would advertise, in the artifact and in `smrt doctor`,
        // an operation `defineIntent` refuses to register at runtime.
        report('invalid-identity', helper, problem, node.start);
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
    const playbookProblem = playbookDeclarationProblem(declaration, key, steps);
    if (playbookProblem) {
      report('invalid-identity', helper, playbookProblem, node.start);
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
/**
 * Offset of a call to `helper` — or to a local name the file aliased it to — in
 * a Svelte component, or `undefined` when there is none.
 *
 * Textual, but not naively so. Requiring the literal token `defineIntent(`
 * would miss `defineIntent ({...})` and, worse, miss
 * `import { defineIntent as declare }` followed by `declare({...})` — which is
 * the exact silent omission this whole pass exists to prevent. So the local
 * names bound by the file's own import statement are resolved first, and
 * whitespace before the parenthesis is allowed.
 */
function svelteCallOffset(
  text: string,
  helper: AgentSurfaceHelper,
): number | undefined {
  const names = new Set<string>([helper]);

  // `import { defineIntent as declare, x } from '<specifier>'` — capture the
  // brace group for this helper's specifier and read the local name out of it.
  const importPattern = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*['"\`]${escapeRegExp(
      HELPER_SPECIFIERS[helper],
    )}['"\`]`,
    'g',
  );
  for (const match of text.matchAll(importPattern)) {
    for (const clause of match[1].split(',')) {
      const alias = clause.trim().match(/^(\w+)\s+as\s+(\w+)$/);
      if (alias && alias[1] === helper) {
        names.add(alias[2]);
      }
    }
  }

  let earliest: number | undefined;
  for (const name of names) {
    // A word boundary before the name keeps `myDefineIntent(` from matching.
    const call = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, 'g');
    for (const match of text.matchAll(call)) {
      if (
        match.index !== undefined &&
        (earliest === undefined || match.index < earliest)
      ) {
        earliest = match.index;
      }
    }
  }
  return earliest;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    if (!text.includes(HELPER_SPECIFIERS[helper])) continue;
    const callIndex = svelteCallOffset(text, helper);
    if (callIndex === undefined) continue;
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

  // `intentToolName` is not injective — `orders.foo_bar` and `orders.foo.bar`
  // both flatten to `orders_foo_bar` — and `defineIntent` rejects the second
  // registration of a colliding pair. Emitting both would overstate the usable
  // surface with two entries only one of which can ever exist, so the collision
  // is resolved by the same path-ordered rule as a duplicate identity.
  const sortedIntents = [...intents.values()].sort(
    (a, b) =>
      compareStrings(a.id, b.id) || compareStrings(a.filePath, b.filePath),
  );
  const byToolName = new Map<string, AgentSurfaceIntent>();
  const survivingIntents: AgentSurfaceIntent[] = [];
  for (const intent of sortedIntents) {
    const toolName = intentToolName(intent.id);
    const claimed = byToolName.get(toolName);
    if (!claimed) {
      byToolName.set(toolName, intent);
      survivingIntents.push(intent);
      continue;
    }
    const [winner, loser] =
      intent.filePath < claimed.filePath
        ? [intent, claimed]
        : [claimed, intent];
    byToolName.set(toolName, winner);
    if (winner !== claimed) {
      survivingIntents[survivingIntents.indexOf(claimed)] = winner;
    }
    diagnostics.push({
      code: 'duplicate-identity',
      helper: 'defineIntent',
      message:
        `view intents \`${winner.id}\` and \`${loser.id}\` both derive the WebMCP tool name ` +
        `\`${toolName}\`, which \`defineIntent\` rejects at registration. The declaration in ` +
        `\`${winner.filePath}\` is emitted and the one in \`${loser.filePath}\` is dropped.`,
      filePath: loser.filePath,
    });
  }

  return {
    intents: survivingIntents.sort(
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
