import {
  createQualifiedName,
  isQualifiedName,
  ObjectRegistry,
  parseQualifiedName,
  type SmartObjectConfig,
} from '@happyvertical/smrt-core';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '@happyvertical/smrt-core/manifest';
import type {
  FeatureDefinitionSeed,
  FeatureMetadata,
  FeatureTargetConstructor,
} from './types.js';

export type RegistryEntryLike = {
  name: string;
  qualifiedName?: string;
  packageName?: string;
  config: SmartObjectConfig;
  visibility?: string;
};

export function createFeatureKey(
  qualifiedClassName: string,
  localId: string,
): string {
  if (!isQualifiedName(qualifiedClassName)) {
    throw new Error(
      `Feature keys require a qualified class name. Received "${qualifiedClassName}".`,
    );
  }

  if (!localId) {
    throw new Error('Feature localId is required.');
  }

  if (localId.includes('#')) {
    throw new Error(
      `Feature localId "${localId}" cannot contain "#". This character is reserved for canonical feature keys.`,
    );
  }

  return `${qualifiedClassName}#${localId}`;
}

export function parseFeatureKey(featureKey: string): {
  qualifiedClassName: string;
  localId: string;
} {
  const separatorIndex = featureKey.lastIndexOf('#');
  if (separatorIndex <= 0 || separatorIndex === featureKey.length - 1) {
    throw new Error(
      `Invalid feature key "${featureKey}". Expected format "<qualifiedClassName>#<localId>".`,
    );
  }

  const qualifiedClassName = featureKey.slice(0, separatorIndex);
  const localId = featureKey.slice(separatorIndex + 1);

  if (!isQualifiedName(qualifiedClassName)) {
    throw new Error(
      `Invalid feature key "${featureKey}". "${qualifiedClassName}" is not a qualified class name.`,
    );
  }

  return { qualifiedClassName, localId };
}

export function serializeFeatureMetadata(
  metadata: FeatureMetadata | string | null | undefined,
): string {
  if (!metadata) {
    return '';
  }

  if (typeof metadata === 'string') {
    const parsed = parseFeatureMetadataString(metadata);
    return JSON.stringify(parsed);
  }

  if (!isFeatureMetadataRecord(metadata)) {
    throw new Error(
      'Feature metadata must be a plain object or a JSON string representing a plain object.',
    );
  }

  return JSON.stringify(metadata);
}

export function parseFeatureMetadata(
  metadata: string | null | undefined,
): FeatureMetadata {
  if (!metadata) {
    return {};
  }

  try {
    return parseFeatureMetadataString(metadata);
  } catch {
    return {};
  }
}

function parseFeatureMetadataString(metadata: string): FeatureMetadata {
  let parsed: unknown;

  try {
    parsed = JSON.parse(metadata);
  } catch (error) {
    throw new Error(
      'Feature metadata must be a plain object or a JSON string representing a plain object.',
      { cause: error },
    );
  }

  if (!isFeatureMetadataRecord(parsed)) {
    throw new Error(
      'Feature metadata must be a plain object or a JSON string representing a plain object.',
    );
  }

  return parsed;
}

function isFeatureMetadataRecord(value: unknown): value is FeatureMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function getQualifiedClassNameFromRegistry(
  registration: RegistryEntryLike,
): string | null {
  if (
    registration.qualifiedName &&
    isQualifiedName(registration.qualifiedName)
  ) {
    return registration.qualifiedName;
  }

  if (registration.packageName) {
    return createQualifiedName(registration.packageName, registration.name);
  }

  return null;
}

export function getPackageNameFromRegistry(
  registration: RegistryEntryLike,
): string | null {
  if (registration.packageName) {
    return registration.packageName;
  }

  const qualifiedClassName = getQualifiedClassNameFromRegistry(registration);
  if (!qualifiedClassName) {
    return null;
  }

  return parseQualifiedName(qualifiedClassName).packageName;
}

export function extractFeatureSeedsFromRegistryEntry(
  registration: RegistryEntryLike,
): FeatureDefinitionSeed[] {
  if (registration.visibility === 'test') {
    return [];
  }

  const qualifiedClassName = getQualifiedClassNameFromRegistry(registration);
  if (!qualifiedClassName) {
    return [];
  }

  const featureConfig = registration.config.features;
  if (!featureConfig) {
    return [];
  }

  const packageName =
    registration.packageName ||
    parseQualifiedName(qualifiedClassName).packageName;

  return Object.entries(featureConfig).map(([localId, feature]) => ({
    featureKey: createFeatureKey(qualifiedClassName, localId),
    packageName,
    qualifiedClassName,
    className: registration.name,
    localId,
    defaultEnabled: feature.defaultEnabled,
    label: feature.label,
    description: feature.description,
    metadata: feature.metadata,
    visibility: registration.visibility,
  }));
}

export function extractFeatureSeedsFromManifest(
  manifest: SmartObjectManifest,
): FeatureDefinitionSeed[] {
  const seeds: FeatureDefinitionSeed[] = [];

  for (const [objectKey, objectDef] of Object.entries(manifest.objects)) {
    seeds.push(...extractFeatureSeedsFromManifestObject(objectKey, objectDef));
  }

  return seeds;
}

export function extractTouchedPackagesFromManifest(
  manifest: SmartObjectManifest,
): Set<string> {
  const packages = new Set<string>();

  if (manifest.packageName) {
    packages.add(manifest.packageName);
  }

  for (const [objectKey, objectDef] of Object.entries(manifest.objects)) {
    if (objectDef.visibility === 'test') {
      continue;
    }

    if (objectDef.packageName) {
      packages.add(objectDef.packageName);
      continue;
    }

    const qualifiedClassName = resolveManifestQualifiedClassName(
      objectKey,
      objectDef,
    );
    if (qualifiedClassName) {
      packages.add(parseQualifiedName(qualifiedClassName).packageName);
    }
  }

  return packages;
}

function extractFeatureSeedsFromManifestObject(
  objectKey: string,
  objectDef: SmartObjectDefinition,
): FeatureDefinitionSeed[] {
  if (objectDef.visibility === 'test') {
    return [];
  }

  const features = objectDef.decoratorConfig.features;
  if (!features) {
    return [];
  }

  const qualifiedClassName = resolveManifestQualifiedClassName(
    objectKey,
    objectDef,
  );
  if (!qualifiedClassName) {
    return [];
  }

  const packageName =
    objectDef.packageName || parseQualifiedName(qualifiedClassName).packageName;

  return Object.entries(features).map(([localId, feature]) => ({
    featureKey: createFeatureKey(qualifiedClassName, localId),
    packageName,
    qualifiedClassName,
    className: objectDef.className,
    localId,
    defaultEnabled: feature.defaultEnabled,
    label: feature.label,
    description: feature.description,
    metadata:
      feature.metadata && typeof feature.metadata === 'object'
        ? (feature.metadata as FeatureMetadata)
        : undefined,
    visibility: objectDef.visibility,
  }));
}

function resolveManifestQualifiedClassName(
  objectKey: string,
  objectDef: SmartObjectDefinition,
): string | null {
  if (objectDef.qualifiedName && isQualifiedName(objectDef.qualifiedName)) {
    return objectDef.qualifiedName;
  }

  if (isQualifiedName(objectKey)) {
    return objectKey;
  }

  if (objectDef.packageName) {
    return createQualifiedName(objectDef.packageName, objectDef.className);
  }

  return null;
}

export function resolveFeatureKeyForTarget(
  classOrInstance: object | FeatureTargetConstructor,
  localId: string,
): {
  featureKey: string;
  defaultEnabled: boolean;
} {
  const ctor: FeatureTargetConstructor =
    typeof classOrInstance === 'function'
      ? (classOrInstance as FeatureTargetConstructor)
      : (classOrInstance.constructor as FeatureTargetConstructor);

  const registration = ObjectRegistry.getClassByConstructor(ctor);
  if (!registration) {
    throw new Error(
      `Cannot resolve feature "${localId}" because ${ctor?.name || 'the target class'} is not registered with @smrt().`,
    );
  }

  const qualifiedClassName = getQualifiedClassNameFromRegistry(registration);
  if (!qualifiedClassName) {
    throw new Error(
      `Cannot resolve feature "${localId}" for ${registration.name} because the class has no qualified package identity.`,
    );
  }

  const feature = registration.config.features?.[localId];
  if (!feature) {
    throw new Error(
      `Feature "${localId}" is not declared on ${qualifiedClassName}.`,
    );
  }

  return {
    featureKey: createFeatureKey(qualifiedClassName, localId),
    defaultEnabled: feature.defaultEnabled,
  };
}

export function findFeatureDefaultInRegistry(
  featureKey: string,
): boolean | undefined {
  const { qualifiedClassName, localId } = parseFeatureKey(featureKey);
  const registration =
    ObjectRegistry.getClassByQualifiedName(qualifiedClassName) ||
    ObjectRegistry.getClass(qualifiedClassName);

  const feature = registration?.config.features?.[localId];
  return feature?.defaultEnabled;
}
