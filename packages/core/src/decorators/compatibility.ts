type DecoratorMetadataStore = Record<PropertyKey, unknown>;

const PENDING_FIELD_DECORATORS_KEY = Symbol.for(
  '@happyvertical/smrt-core/pending-field-decorators',
);
const standardDecoratorRegistrations = new WeakMap<
  Function,
  WeakSet<(className: string) => void>
>();

type PendingDecoratorRegistration = {
  register: (className: string) => void;
};

export type LegacyPropertyDecoratorTarget = {
  constructor?: Function & {
    name?: string;
  };
};

export type CompatiblePropertyDecoratorContext<This, Value> =
  | string
  | symbol
  | ClassFieldDecoratorContext<This, Value>;

export interface CompatiblePropertyDecorator<This = unknown, Value = unknown> {
  (target: object, propertyKey: string | symbol): void;
  (value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
}

/**
 * A method decorator that works under BOTH decorator implementations, the same
 * way {@link CompatiblePropertyDecorator} does for class fields.
 *
 * Legacy (TypeScript `experimentalDecorators`, and the Oxc legacy mode this
 * repo builds with) calls `(target, propertyKey, descriptor)`, where `target`
 * is the prototype for an instance method and the constructor for a static
 * one. TC39 standard decorators call `(value, context)`. Returning `void` from
 * either leaves the method untouched, which is all a metadata-only decorator
 * needs (#2686).
 */
/**
 * The constraint `ClassMethodDecoratorContext<This, Value>` imposes on its
 * `Value`, restated so this module's own generics can satisfy it. Any narrower
 * spelling (`...args: never`, `unknown[]`) is rejected by the lib type, and a
 * method decorator has to accept every method signature anyway.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors the lib's own `ClassMethodDecoratorContext` constraint; a narrower type does not satisfy it. Same rationale as `SmrtObjectConstructor` in registry/types.ts. S4 #1579.
type AnyMethodOf<This> = (this: This, ...args: any) => any;

// biome-ignore lint/suspicious/noExplicitAny: see AnyMethodOf above. S4 #1579.
type AnyMethod = (this: any, ...args: any) => any;

export type CompatibleMethodDecoratorContext<
  This,
  Value extends AnyMethodOf<This>,
> = string | symbol | ClassMethodDecoratorContext<This, Value>;

export interface CompatibleMethodDecorator<
  This = unknown,
  Value extends AnyMethodOf<This> = AnyMethod,
> {
  (
    target: object,
    propertyKey: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void;
  (value: Value, context: ClassMethodDecoratorContext<This, Value>): void;
}

function getDecoratorConstructor(target: unknown): Function | undefined {
  if (typeof target === 'function') {
    return target;
  }

  if (target && typeof target === 'object') {
    return (target as LegacyPropertyDecoratorTarget).constructor;
  }

  return undefined;
}

function markStandardDecoratorRegistration(
  target: unknown,
  register: (className: string) => void,
): boolean {
  const ctor = getDecoratorConstructor(target);
  if (!ctor) {
    return false;
  }

  const registeredCallbacks =
    standardDecoratorRegistrations.get(ctor) ?? new WeakSet();
  if (registeredCallbacks.has(register)) {
    return false;
  }

  registeredCallbacks.add(register);
  standardDecoratorRegistrations.set(ctor, registeredCallbacks);
  return true;
}

function getDecoratorMetadata(
  contextOrMetadata:
    | ClassFieldDecoratorContext<unknown, unknown>
    | ClassMethodDecoratorContext<unknown, AnyMethod>
    | ClassDecoratorContext
    | DecoratorMetadataStore
    | undefined,
): DecoratorMetadataStore | undefined {
  if (!contextOrMetadata || typeof contextOrMetadata !== 'object') {
    return undefined;
  }

  if ('metadata' in contextOrMetadata) {
    const { metadata } = contextOrMetadata as {
      metadata?: DecoratorMetadataStore;
    };
    return metadata && typeof metadata === 'object' ? metadata : undefined;
  }

  return contextOrMetadata;
}

function getClassDecoratorMetadata(
  target: Function,
  decoratorContext?: ClassDecoratorContext,
): DecoratorMetadataStore | undefined {
  const metadataFromContext = getDecoratorMetadata(decoratorContext);
  if (metadataFromContext) {
    return metadataFromContext;
  }

  const metadataSymbol = (Symbol as typeof Symbol & { metadata?: symbol })
    .metadata;
  if (!metadataSymbol) {
    return undefined;
  }

  const metadata = (target as unknown as Record<PropertyKey, unknown>)[
    metadataSymbol
  ];
  return metadata && typeof metadata === 'object'
    ? (metadata as DecoratorMetadataStore)
    : undefined;
}

function queuePendingFieldDecorator(
  metadata: DecoratorMetadataStore,
  register: (className: string) => void,
): void {
  const pendingDecorators =
    (metadata[PENDING_FIELD_DECORATORS_KEY] as
      | PendingDecoratorRegistration[]
      | undefined) ?? [];

  pendingDecorators.push({ register });
  metadata[PENDING_FIELD_DECORATORS_KEY] = pendingDecorators;
}

export function resolveDecoratorClassName(target: unknown): string | undefined {
  if (typeof target === 'function') {
    return target.name;
  }

  if (target && typeof target === 'object') {
    return (target as LegacyPropertyDecoratorTarget).constructor?.name;
  }

  return undefined;
}

export function applyPendingDecoratorRegistrations(
  target: Function,
  decoratorContext?: ClassDecoratorContext,
): void {
  const metadata = getClassDecoratorMetadata(target, decoratorContext);
  if (!metadata) {
    return;
  }

  const pendingDecorators = metadata[PENDING_FIELD_DECORATORS_KEY] as
    | PendingDecoratorRegistration[]
    | undefined;
  if (!pendingDecorators || pendingDecorators.length === 0) {
    return;
  }

  for (const { register } of pendingDecorators) {
    if (!markStandardDecoratorRegistration(target, register)) {
      continue;
    }

    register(target.name);
  }

  Reflect.deleteProperty(metadata, PENDING_FIELD_DECORATORS_KEY);
}

/**
 * Register a method decorator's metadata under the decorated class's name,
 * under whichever decorator implementation is running.
 *
 * The class-field twin below is the model, but the two cannot share one
 * function: their legacy signatures differ (a method decorator receives a
 * property descriptor as a third argument), and a static method's legacy
 * `target` is the CONSTRUCTOR while an instance method's is the prototype —
 * `resolveDecoratorClassName` already handles both, which is why the class
 * name resolution is shared even though the entry point is not.
 *
 * Metadata-only: nothing is wrapped and nothing is returned, so the decorated
 * method keeps its identity and remains directly callable (#2686).
 */
export function registerCompatibleMethodDecorator<
  This,
  Value extends AnyMethodOf<This>,
>(
  targetOrValue: LegacyPropertyDecoratorTarget | Value | undefined,
  propertyKeyOrContext: CompatibleMethodDecoratorContext<This, Value>,
  registerMethodDecorator: (className: string, methodName: string) => void,
): void {
  if (
    typeof propertyKeyOrContext === 'string' ||
    typeof propertyKeyOrContext === 'symbol'
  ) {
    const className = resolveDecoratorClassName(targetOrValue);
    if (className) {
      registerMethodDecorator(className, String(propertyKeyOrContext));
    }
    return;
  }

  const context = propertyKeyOrContext;
  const methodName = String(context.name);
  const register = (className: string) =>
    registerMethodDecorator(className, methodName);
  const metadata = getDecoratorMetadata(context);

  if (metadata) {
    queuePendingFieldDecorator(metadata, register);
    return;
  }

  context.addInitializer?.(function registerSmrtMethodDecorator(this: unknown) {
    // A static method's initializer runs with the constructor as `this`; an
    // instance method's runs with the instance. `resolveDecoratorClassName`
    // reads the constructor in the latter case, so both land on the same name.
    if (!markStandardDecoratorRegistration(this, register)) {
      return;
    }

    const className = resolveDecoratorClassName(this);
    if (className) {
      register(className);
    }
  });
}

export function registerCompatibleFieldDecorator<This, Value>(
  targetOrValue: LegacyPropertyDecoratorTarget | undefined,
  propertyKeyOrContext: CompatiblePropertyDecoratorContext<This, Value>,
  registerFieldDecorator: (className: string, propertyKey: string) => void,
): void {
  if (
    typeof propertyKeyOrContext === 'string' ||
    typeof propertyKeyOrContext === 'symbol'
  ) {
    const className = resolveDecoratorClassName(targetOrValue);
    if (className) {
      registerFieldDecorator(className, String(propertyKeyOrContext));
    }
    return;
  }

  const context = propertyKeyOrContext;
  const propertyKey = String(context.name);
  const register = (className: string) =>
    registerFieldDecorator(className, propertyKey);
  const metadata = getDecoratorMetadata(context);

  if (metadata) {
    queuePendingFieldDecorator(metadata, register);
    return;
  }

  context.addInitializer?.(function registerSmrtDecorator() {
    if (!markStandardDecoratorRegistration(this, register)) {
      return;
    }

    const className = resolveDecoratorClassName(this);
    if (className) {
      register(className);
    }
  });
}
