/**
 * Setter-reads-hidden-field lint (#5603).
 *
 * The write rule (#5195, `FieldNotWritableError`) refuses a changed protected
 * field, and a protected field the caller cannot read is refused whatever its
 * value, so a caller never learns the stored value from an accepted-versus-
 * refused answer. A setter is application code, though: if it READS such a
 * field before deciding what to assign,
 *
 *     set label(value: string) {
 *       if (this.secretHash !== value) this.secretHash = value;
 *     }
 *
 * a caller with update permission confirms the hidden value by the 200 versus
 * 400 the branch produces. The engine does not proxy hidden-field reads inside
 * accessors (documented known limit), so the rule is on the model author:
 * **a setter must not read a field some callers cannot read.** This lint finds
 * the violation in source.
 *
 * "Hidden" here is what the scanner can see on a field declaration:
 * `@field({ sensitive: true })` or `@field({ readPermission: '...' })`, the two
 * options that withhold a field from `toPublicJSON()`.
 *
 * What counts as a read: `this.f`, `this['f']`, `this?.f`, a compound or
 * logical assignment (`this.f += 1`, `this.f ??= v`), `this.f++`, and
 * destructuring `this` (`const { f } = this`). A plain assignment to the field
 * (`this.f = v`, including as a destructuring target) is not a read; the
 * assignment trap already refuses it.
 *
 * Deliberately syntactic: aliases (`const self = this`), dynamic keys
 * (`this[name]`), calls into helpers that read the field, config options the
 * scanner cannot resolve to a literal, and fields inherited from a parent
 * declared in another file are not followed. A missed finding is a documented
 * limit; a false finding would make the gate noisy.
 */

import { parseSync } from 'oxc-parser';
import { getLineColumn } from './source-location.js';

/** One setter that reads a field some callers cannot read. */
export interface SetterHiddenReadFinding {
  /** Declaring class, e.g. `Account`. */
  className: string;
  /** Setter name. */
  setterName: string;
  /** The hidden field the setter reads. */
  fieldName: string;
  /** Why the field is hidden: `sensitive` or `readPermission`. */
  hiddenBy: 'sensitive' | 'readPermission';
  /** File passed to the lint. */
  filePath: string;
  /** 1-based line of the read, or `0` when it could not be resolved. */
  line: number;
  /** Human-readable explanation naming the rule. */
  message: string;
  /** The accepted fixes. */
  remedy: string;
}

// biome-ignore lint/suspicious/noExplicitAny: ESTree nodes are walked structurally
type Node = any;

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'range', 'parent']);
const TS_WRAPPERS = new Set([
  'TSNonNullExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
]);

/** Cheap pre-filter: a file without all three words cannot produce a finding. */
export function sourceMayContainSetterHiddenRead(source: string): boolean {
  return (
    /\bset\s*[\w$#['"`]/.test(source) &&
    /\bthis\b/.test(source) &&
    /\b(?:sensitive|readPermission)\b/.test(source)
  );
}

function unwrap(node: Node): Node {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

function keyName(key: Node, computed: boolean): string | undefined {
  if (!key) return undefined;
  if (!computed && key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** `this.f` / `this['f']` -> `f`; anything else -> undefined. */
function thisMemberName(node: Node): string | undefined {
  const target = unwrap(node);
  if (target?.type !== 'MemberExpression') return undefined;
  if (unwrap(target.object)?.type !== 'ThisExpression') return undefined;
  return keyName(target.property, target.computed);
}

function objectProperty(object: Node, name: string): Node | undefined {
  for (const prop of object.properties ?? []) {
    if (prop.type !== 'Property') continue;
    if (keyName(prop.key, prop.computed) === name) return prop;
  }
  return undefined;
}

/** Why a field declaration is hidden from some callers, if it is. */
function hiddenBy(member: Node): 'sensitive' | 'readPermission' | undefined {
  for (const decorator of member.decorators ?? []) {
    const call = decorator.expression;
    if (call?.type !== 'CallExpression') continue;
    if (call.callee?.type !== 'Identifier' || call.callee.name !== 'field') {
      continue;
    }
    const config = call.arguments?.[0];
    if (config?.type !== 'ObjectExpression') continue;
    const sensitive = objectProperty(config, 'sensitive');
    if (
      sensitive?.value?.type === 'Literal' &&
      sensitive.value.value === true
    ) {
      return 'sensitive';
    }
    const permission = objectProperty(config, 'readPermission');
    if (
      permission?.value?.type === 'Literal' &&
      typeof permission.value.value === 'string' &&
      permission.value.value !== ''
    ) {
      return 'readPermission';
    }
  }
  return undefined;
}

interface Read {
  field: string;
  start: number;
}

/**
 * Collect reads of `this.<hidden>` in a setter body. Nested non-arrow
 * functions and classes rebind `this`, so they are not entered.
 */
function collectReads(body: Node, hidden: ReadonlySet<string>): Read[] {
  const reads: Read[] = [];

  const visitTarget = (node: Node): void => {
    const target = unwrap(node);
    if (!target) return;
    switch (target.type) {
      case 'MemberExpression': {
        // `this.f = v` is a write; `this.f.x = v` and `a[this.f] = v` read.
        if (thisMemberName(target) === undefined) {
          visit(target.object);
          if (target.computed) visit(target.property);
        }
        return;
      }
      case 'ArrayPattern':
        for (const element of target.elements ?? []) visitTarget(element);
        return;
      case 'ObjectPattern':
        for (const prop of target.properties ?? []) {
          if (prop.type === 'RestElement') visitTarget(prop.argument);
          else {
            if (prop.computed) visit(prop.key);
            visitTarget(prop.value);
          }
        }
        return;
      case 'RestElement':
        visitTarget(target.argument);
        return;
      case 'AssignmentPattern':
        visitTarget(target.left);
        visit(target.right);
        return;
      default:
        return;
    }
  };

  /** Keys read out of `this` by an object pattern (`const { f } = this`). */
  const visitThisPattern = (pattern: Node): void => {
    for (const prop of pattern?.properties ?? []) {
      if (prop.type !== 'Property') continue;
      const name = keyName(prop.key, prop.computed);
      if (name !== undefined && hidden.has(name)) {
        reads.push({ field: name, start: prop.start });
      }
    }
  };

  const visit = (node: Node): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.type !== 'string') return;
    switch (node.type) {
      case 'FunctionExpression':
      case 'FunctionDeclaration':
      case 'ClassExpression':
      case 'ClassDeclaration':
        return;
      case 'AssignmentExpression':
        if (node.operator === '=') {
          visitTarget(node.left);
          if (
            unwrap(node.right)?.type === 'ThisExpression' &&
            unwrap(node.left)?.type === 'ObjectPattern'
          ) {
            visitThisPattern(unwrap(node.left));
          }
          visit(node.right);
          return;
        }
        break;
      case 'ForOfStatement':
      case 'ForInStatement':
        // `for (this.f of xs)` assigns the field; the iterable and body read.
        if (node.left?.type === 'VariableDeclaration') visit(node.left);
        else visitTarget(node.left);
        visit(node.right);
        visit(node.body);
        return;
      case 'VariableDeclarator':
        if (
          unwrap(node.init)?.type === 'ThisExpression' &&
          node.id?.type === 'ObjectPattern'
        ) {
          visitThisPattern(node.id);
        }
        break;
      case 'MemberExpression': {
        const name = thisMemberName(node);
        if (name !== undefined && hidden.has(name)) {
          reads.push({ field: name, start: node.start });
          return;
        }
        break;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!SKIP_KEYS.has(key)) visit(value);
    }
  };

  visit(body);
  return reads;
}

/**
 * Report every setter on a class whose body reads one of that class's hidden
 * fields (`@field({ sensitive: true })` or `@field({ readPermission })`).
 *
 * @param sourceText - Contents of one TypeScript file.
 * @param filePath - Path used in findings and to pick the parser language.
 * @returns One finding per (setter, field) pair, in source order.
 */
export function lintSetterHiddenReads(
  sourceText: string,
  filePath = 'model.ts',
): SetterHiddenReadFinding[] {
  const parsed = parseSync(filePath, sourceText, {
    lang: filePath.endsWith('.tsx') ? 'tsx' : 'ts',
    preserveParens: false,
  });
  const findings: SetterHiddenReadFinding[] = [];

  const visitClass = (cls: Node): void => {
    const hidden = new Map<string, 'sensitive' | 'readPermission'>();
    for (const member of cls.body?.body ?? []) {
      if (member.type !== 'PropertyDefinition' || member.static) continue;
      const name = keyName(member.key, member.computed);
      const reason = name === undefined ? undefined : hiddenBy(member);
      if (name !== undefined && reason) hidden.set(name, reason);
    }
    if (hidden.size === 0) return;
    for (const member of cls.body.body) {
      if (
        member.type !== 'MethodDefinition' ||
        member.kind !== 'set' ||
        member.static
      ) {
        continue;
      }
      const setterName = keyName(member.key, member.computed) ?? '<computed>';
      const seen = new Set<string>();
      for (const read of collectReads(
        member.value?.body,
        new Set(hidden.keys()),
      )) {
        if (seen.has(read.field)) continue;
        seen.add(read.field);
        const reason = hidden.get(read.field) as 'sensitive' | 'readPermission';
        const className = cls.id?.name ?? '<anonymous>';
        findings.push({
          className,
          setterName,
          fieldName: read.field,
          hiddenBy: reason,
          filePath,
          line: getLineColumn(sourceText, read.start)?.line ?? 0,
          message:
            `${className}.${setterName} (setter) reads ${read.field}, a ` +
            `${reason === 'sensitive' ? 'sensitive' : 'readPermission'} ` +
            'field some callers cannot read. A caller with update permission ' +
            'can confirm the hidden value by whether the write is accepted or ' +
            'refused; the engine does not proxy hidden-field reads in accessors.',
          remedy:
            `Do not read ${read.field} in the setter: assign it ` +
            'unconditionally, or move the branch into a method that is not ' +
            'reachable through a caller-writable key.',
        });
      }
    }
  };

  const walk = (node: Node): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.type !== 'string') return;
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      visitClass(node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (!SKIP_KEYS.has(key)) walk(value);
    }
  };
  walk(parsed.program);
  return findings;
}
