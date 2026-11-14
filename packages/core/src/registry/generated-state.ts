/** Generated-class state and targeted parent subscriptions, never a registry sweep. */
import {
  GeneratedFieldError,
  generatedExpression,
} from '../generated-fields.js';
import { ObjectRegistry } from '../registry.js';
import { recordRegistryDiagnostic } from './diagnostics.js';
import { getEffectiveFieldsSync } from './inheritance-resolver.js';
import { findClass, findClassStrict } from './name-resolver.js';
import { getClasses, getInheritanceCache } from './shared-state.js';
import type { RegisteredClass, RegisteredField } from './types.js';

export interface GeneratedClassState {
  fields: Map<string, RegisteredField>;
  declaredFields?: Set<string>;
  error?: GeneratedFieldError;
  pendingConstructor?: Function;
  pendingName?: string;
}
interface State {
  declarations: Map<string, RegisteredClass>;
  pendingConstructors: Map<Function, Set<RegisteredClass>>;
  pendingNames: Map<string, Set<RegisteredClass>>;
  childrenConstructors: Map<Function, Set<RegisteredClass>>;
  childrenNames: Map<string, Set<RegisteredClass>>;
}
declare global {
  var __smrtGeneratedClassState: State | undefined;
}
function state(): State {
  globalThis.__smrtGeneratedClassState ??= {
    declarations: new Map(),
    pendingConstructors: new Map(),
    pendingNames: new Map(),
    childrenConstructors: new Map(),
    childrenNames: new Map(),
  };
  return globalThis.__smrtGeneratedClassState;
}
export function clearGeneratedClassState(): void {
  globalThis.__smrtGeneratedClassState = undefined;
}
export function snapshotGeneratedClassState(): () => void {
  const current = state();
  const clone = <K>(map: Map<K, Set<RegisteredClass>>) =>
    new Map([...map].map(([key, value]) => [key, new Set(value)]));
  const saved: State = {
    declarations: new Map(current.declarations),
    pendingConstructors: clone(current.pendingConstructors),
    pendingNames: clone(current.pendingNames),
    childrenConstructors: clone(current.childrenConstructors),
    childrenNames: clone(current.childrenNames),
  };
  return () => {
    globalThis.__smrtGeneratedClassState = saved;
  };
}
export function generatedClasses(): ReadonlyMap<string, RegisteredClass> {
  return state().declarations;
}
/** Track feature declarations during the field-map writes registration already performs. */
export class GeneratedFieldMap extends Map<string, RegisteredField> {
  #generatedCount = 0;
  constructor(fields?: Iterable<readonly [string, RegisteredField]>) {
    super();
    if (fields) for (const [name, field] of fields) this.set(name, field);
  }
  get hasGenerated(): boolean {
    return this.#generatedCount > 0;
  }
  override set(name: string, field: RegisteredField): this {
    if (generatedExpression(this.get(name)) !== undefined)
      this.#generatedCount--;
    if (generatedExpression(field) !== undefined) this.#generatedCount++;
    return super.set(name, field);
  }
  override delete(name: string): boolean {
    if (generatedExpression(this.get(name)) !== undefined)
      this.#generatedCount--;
    return super.delete(name);
  }
  override clear(): void {
    super.clear();
    this.#generatedCount = 0;
  }
}
export function declaresGeneratedFields(entry: RegisteredClass): boolean {
  return (entry.fields as GeneratedFieldMap).hasGenerated === true;
}
const keyOf = (entry: RegisteredClass) => entry.qualifiedName ?? entry.name;
function parentName(entry: RegisteredClass): string | undefined {
  const name = entry.extends;
  if (!name || ['SmrtObject', 'SmrtClass', 'SmrtCollection'].includes(name))
    return undefined;
  return name.includes(':') || !entry.packageName
    ? name
    : `${entry.packageName}:${name}`;
}
function parentConstructor(
  entry: RegisteredClass,
): typeof import('../object.js').SmrtObject | undefined {
  if (entry.generatedParentConstructor) return entry.generatedParentConstructor;
  if (
    (entry.constructor as { _isManifestStub?: boolean })._isManifestStub ||
    !parentName(entry)
  )
    return undefined;
  return Object.getPrototypeOf(entry.constructor);
}
function parent(entry: RegisteredClass): RegisteredClass | undefined {
  if (entry.generatedParentConstructor)
    return ObjectRegistry.getClassByConstructor(
      entry.generatedParentConstructor,
    );
  const ctor = parentConstructor(entry);
  return (
    (ctor ? ObjectRegistry.getClassByConstructor(ctor) : undefined) ??
    (entry.extends
      ? findClassStrict(entry.extends, entry.packageName)
      : undefined)
  );
}
function add<K>(
  map: Map<K, Set<RegisteredClass>>,
  key: K,
  entry: RegisteredClass,
): void {
  const entries = map.get(key) ?? new Set();
  entries.add(entry);
  map.set(key, entries);
}
function unsubscribe(entry: RegisteredClass): void {
  const own = entry.generatedFields;
  if (!own) return;
  const data = state();
  if (own.pendingConstructor) {
    const waiting = data.pendingConstructors.get(own.pendingConstructor);
    waiting?.delete(entry);
    if (!waiting?.size) data.pendingConstructors.delete(own.pendingConstructor);
  }
  if (own.pendingName) {
    const waiting = data.pendingNames.get(own.pendingName);
    waiting?.delete(entry);
    if (!waiting?.size) data.pendingNames.delete(own.pendingName);
  }
  delete own.pendingConstructor;
  delete own.pendingName;
}
function awaitMissingParent(entry: RegisteredClass): void {
  let current: RegisteredClass | undefined = entry;
  const seen = new Set<RegisteredClass>();
  while (current && !seen.has(current) && parentName(current)) {
    seen.add(current);
    const ancestor = parent(current);
    if (!ancestor) {
      const ctor = parentConstructor(current);
      if (ctor) {
        entry.generatedFields!.pendingConstructor = ctor;
        add(state().pendingConstructors, ctor, entry);
      } else {
        const name = parentName(current)!;
        entry.generatedFields!.pendingName = name;
        add(state().pendingNames, name, entry);
      }
      return;
    }
    current = ancestor;
  }
}
function refresh(entry: RegisteredClass, seen: Set<RegisteredClass>): void {
  if (seen.has(entry) || getClasses().get(keyOf(entry)) !== entry) return;
  seen.add(entry);
  const own = entry.generatedFields;
  if (!own) return;
  unsubscribe(entry);
  // Only the subscribed class's caches can contain the earlier incomplete chain.
  entry.inheritanceChain = undefined;
  entry.inheritedFields = undefined;
  entry.inheritedMethods = undefined;
  getInheritanceCache().delete(keyOf(entry));
  getInheritanceCache().delete(entry.name);
  try {
    ObjectRegistry.validateGeneratedRegistration(
      entry,
      own.declaredFields,
      true,
    );
    const effective = getEffectiveFieldsSync(entry);
    own.fields = new Map(
      [...effective].filter(
        ([, field]) => generatedExpression(field) !== undefined,
      ),
    );
    delete own.error;
  } catch (error) {
    own.error =
      error instanceof GeneratedFieldError
        ? error
        : new GeneratedFieldError(
            `${keyOf(entry)}: ${error instanceof Error ? error.message : String(error)}`,
          );
    try {
      awaitMissingParent(entry);
    } catch {
      // Ambiguous ancestry remains quarantined; registering an unrelated parent must succeed.
    }
    recordRegistryDiagnostic('warn', own.error.code, own.error.message, {
      className: keyOf(entry),
      usable: false,
    });
  }
}
/** Drop only this registration's subscriptions when a transactional edit restores it. */
export function forgetGeneratedClass(entry: RegisteredClass): void {
  unsubscribe(entry);
  const data = state();
  if (data.declarations.get(keyOf(entry)) === entry)
    data.declarations.delete(keyOf(entry));
  const ctor = parentConstructor(entry);
  const name = parentName(entry);
  if (ctor) data.childrenConstructors.get(ctor)?.delete(entry);
  else if (name) data.childrenNames.get(name)?.delete(entry);
}
/** One record per class which declares OR inherits generated fields. */
export function recordGeneratedClass(
  entry: RegisteredClass,
  declaredFields?: Iterable<string>,
): void {
  const data = state();
  forgetGeneratedClass(entry);
  const ctor = parentConstructor(entry);
  const name = parentName(entry);
  if (ctor) add(data.childrenConstructors, ctor, entry);
  else if (name) add(data.childrenNames, name, entry);
  let inherited: GeneratedClassState | undefined;
  // No ancestry walk: a direct parent's own feature record is an O(1) lookup.
  if (ctor)
    inherited = ObjectRegistry.getClassByConstructor(ctor)?.generatedFields;
  else if (name) inherited = findClass(name)?.generatedFields;
  if (!declaresGeneratedFields(entry) && !inherited) {
    data.declarations.delete(keyOf(entry));
    delete entry.generatedFields;
    return;
  }
  entry.generatedFields = {
    fields: new Map(),
    ...(declaredFields ? { declaredFields: new Set(declaredFields) } : {}),
  };
  data.declarations.set(keyOf(entry), entry);
  refresh(entry, new Set());
}
/** O(1) for a parent with no pending/feature-bearing descendants. */
export function refreshGeneratedChildren(
  entry: RegisteredClass,
  visited?: Set<RegisteredClass>,
): void {
  const data = state();
  const key = keyOf(entry);
  const byConstructor = data.pendingConstructors.get(entry.constructor);
  const byKey = data.pendingNames.get(key);
  const byName = data.pendingNames.get(entry.name);
  if (
    !entry.generatedFields &&
    !byConstructor?.size &&
    !byKey?.size &&
    !byName?.size
  )
    return;
  visited ??= new Set();
  if (visited.has(entry)) return;
  visited.add(entry);
  const waiting = new Set([
    ...(byConstructor ?? []),
    ...(byKey ?? []),
    ...(byName ?? []),
  ]);
  if (entry.generatedFields) {
    for (const child of data.childrenConstructors.get(entry.constructor) ?? [])
      waiting.add(child);
    for (const child of data.childrenNames.get(key) ?? []) waiting.add(child);
  }
  if (!waiting.size) return;
  // Bind every direct constructor first so deeper pending descendants see the
  // complete chain, independent of registration order.
  for (const child of waiting) {
    if (getClasses().get(keyOf(child)) !== child) {
      waiting.delete(child);
      continue;
    }
    if (child.generatedParentConstructor === entry.constructor) {
      child.extends = key;
      delete child.generatedParentConstructor;
    }
  }
  const seen = new Set<RegisteredClass>();
  for (const child of waiting) {
    if (!child.generatedFields) recordGeneratedClass(child);
    refresh(child, seen);
    refreshGeneratedChildren(child, visited);
  }
}
