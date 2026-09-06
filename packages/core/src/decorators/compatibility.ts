type DecoratorMetadataStore = Record<PropertyKey, unknown>;

const PENDING_FIELD_DECORATORS_KEY = Symbol.for(
  '@happyvertical/smrt-core/pending-field-decorators',
);
const standardDecoratorRegistrations = new WeakMap<
  Function,
  WeakSet<(ctor: Function) => void>
>();

type PendingDecoratorRegistration = {
  register: (ctor: Function) => void;
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
  register: (ctor: Function) => void,
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
  register: (ctor: Function) => void,
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

    register(target);
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
 * `getDecoratorConstructor` already handles both, which is why the receiver
 * resolution is shared even though the entry point is not.
 *
 * Registration is keyed by the CONSTRUCTOR, not by its name: two packages may
 * legitimately declare a class with the same simple name (`Account` exists in
 * both `smrt-ledgers` and `smrt-messages`), and the kernel forbids inferring
 * ownership from simple names. A name-keyed store would let one package's
 * `@method({ expose: false })` withhold the other's identically-named action.
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
  registerMethodDecorator: (
    ctor: Function,
    methodName: string,
    isStatic: boolean,
  ) => void,
): void {
  if (
    typeof propertyKeyOrContext === 'string' ||
    typeof propertyKeyOrContext === 'symbol'
  ) {
    // Legacy decorators hand a STATIC method its constructor and an instance
    // method its prototype. That distinction IS the method's receiver, and
    // nothing downstream can recover it in an unscanned runtime, so capture it
    // here (#2686).
    const ctor = getDecoratorConstructor(targetOrValue);
    if (ctor) {
      registerMethodDecorator(
        ctor,
        String(propertyKeyOrContext),
        typeof targetOrValue === 'function',
      );
    }
    return;
  }

  const context = propertyKeyOrContext;
  const methodName = String(context.name);
  // Standard decorators state the receiver outright.
  const isStatic = context.static === true;
  const register = (ctor: Function) =>
    registerMethodDecorator(ctor, methodName, isStatic);
  const metadata = getDecoratorMetadata(context);

  if (metadata) {
    queuePendingFieldDecorator(metadata, register);
    return;
  }

  context.addInitializer?.(function registerSmrtMethodDecorator(this: unknown) {
    // A static method's initializer runs with the constructor as `this`; an
    // instance method's runs with the instance. `getDecoratorConstructor`
    // reads the constructor in the latter case, so both land on the same class.
    if (!markStandardDecoratorRegistration(this, register)) {
      return;
    }

    const ctor = getDecoratorConstructor(this);
    if (ctor) {
      register(ctor);
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
  // The shared queue passes the CONSTRUCTOR (the method arm needs an identity a
  // simple name cannot provide); field registration keeps its name-keyed store,
  // so it derives the name here.
  const register = (ctor: Function) => {
    if (ctor.name) registerFieldDecorator(ctor.name, propertyKey);
  };
  const metadata = getDecoratorMetadata(context);

  if (metadata) {
    queuePendingFieldDecorator(metadata, register);
    return;
  }

  context.addInitializer?.(function registerSmrtDecorator() {
    if (!markStandardDecoratorRegistration(this, register)) {
      return;
    }

    const ctor = getDecoratorConstructor(this);
    if (ctor) {
      register(ctor);
    }
  });
}
