/** App-local generated-definition and policy source for ObjectForm. */
import type { ResolvedObjectFieldPolicy } from '../types.js';
import type {
  ObjectFormCollectionDefinition,
  ObjectFormPolicyClient,
  ObjectFormResolvedSource,
  ObjectFormSource,
  ObjectFormWireType,
} from './types.js';

const WIRE_TYPES = new Set<ObjectFormWireType>([
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'json',
  'foreignKey',
  'crossPackageRef',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid ObjectForm source response: ${message}`);
}

/** Validate browser-safe generated definitions before accepting them into an app registry. */
export function assertObjectFormCollectionDefinition(
  definition: unknown,
): asserts definition is ObjectFormCollectionDefinition {
  if (
    !isRecord(definition) ||
    typeof definition.objectRef !== 'string' ||
    !definition.objectRef.includes(':')
  ) {
    invalid('definition must have a canonical objectRef');
  }
  if (!isRecord(definition.fields)) {
    invalid('definition fields must be an object');
  }
  for (const [name, field] of Object.entries(definition.fields)) {
    if (
      !name ||
      !isRecord(field) ||
      !WIRE_TYPES.has(field.type as ObjectFormWireType) ||
      (field.required !== undefined && typeof field.required !== 'boolean')
    ) {
      invalid(`field '${name}' is not a supported generated wire field`);
    }
  }
}

function assertResolvedPolicy(
  value: unknown,
  requestedObjectRef: string,
): asserts value is ResolvedObjectFieldPolicy {
  if (
    !isRecord(value) ||
    value.objectRef !== requestedObjectRef ||
    !isRecord(value.fields)
  ) {
    invalid(`resolveBatch did not return policy for '${requestedObjectRef}'`);
  }
  for (const [name, field] of Object.entries(value.fields)) {
    if (
      !isRecord(field) ||
      field.fieldName !== name ||
      !['basic', 'advanced', 'hidden'].includes(field.visibility as string) ||
      typeof field.required !== 'boolean' ||
      typeof field.hasDefault !== 'boolean' ||
      (field.help !== null && typeof field.help !== 'string') ||
      (field.label !== null && typeof field.label !== 'string') ||
      (field.order !== null && typeof field.order !== 'number') ||
      (field.group !== null && typeof field.group !== 'string') ||
      typeof field.locked !== 'boolean'
    ) {
      invalid(`policy field '${name}' is malformed`);
    }
  }
}

/**
 * Per-app registry that maps canonical object refs to generated web
 * collection definitions and resolves their matching policy through the
 * generated `resolveBatch` custom action. It deliberately accepts only
 * structural types so Fields stays independent of smrt-web.
 */
export class ObjectFormSourceRegistry implements ObjectFormSource {
  private readonly definitions = new Map<
    string,
    ObjectFormCollectionDefinition
  >();

  constructor(private readonly policyClient: ObjectFormPolicyClient) {}

  register(definition: ObjectFormCollectionDefinition): () => void {
    assertObjectFormCollectionDefinition(definition);
    const objectRef = definition.objectRef;
    this.definitions.set(objectRef, definition);
    return () => {
      if (this.definitions.get(objectRef) === definition) {
        this.definitions.delete(objectRef);
      }
    };
  }

  get(objectRef: string): ObjectFormCollectionDefinition | undefined {
    return this.definitions.get(objectRef);
  }

  async load(objectRef: string): Promise<ObjectFormResolvedSource> {
    const definition = this.definitions.get(objectRef);
    if (!definition) {
      throw new Error(`ObjectForm source has no definition for '${objectRef}'`);
    }

    // Generated custom action clients return Promise<any>; validate every
    // boundary before a response drives accessible controls.
    const response = await this.policyClient.resolveBatch({
      objectRefs: [objectRef],
    });
    if (!isRecord(response) || !isRecord(response.policies)) {
      invalid('resolveBatch response must contain a policies object');
    }
    const policy = response.policies[objectRef];
    assertResolvedPolicy(policy, objectRef);
    return { definition, policy };
  }
}
