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
