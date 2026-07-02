import { createHash } from 'node:crypto';
import {
  SMRT_MOBILE_CONTRACT_SCHEMA_VERSION,
  SMRT_MOBILE_CONTRACT_VERSION,
} from './contract-version.js';
import { kotlinStringLiteral } from './identifiers.js';
import type {
  MobileContract,
  MobileContractField,
  MobileContractObject,
  MobileContractOptions,
  SmrtManifestField,
  SmrtManifestObject,
} from './types.js';

/**
 * SMRT manifest field type → Kotlin type. Decimals cross the wire as
 * `DecimalString` (string-encoded, no float precision loss); timestamps as
 * nullable `Instant`; JSON payloads as `JsonObject`.
 */
const KOTLIN_TYPE_BY_MANIFEST_TYPE: Record<string, string> = {
  id: 'String',
  text: 'String',
  status: 'String',
  foreignKey: 'String',
  crossPackageRef: 'String',
  // 64-bit: SMRT INTEGER columns hold values like byte sizes and epoch
  // millis that overflow a 32-bit Int at decode time.
  integer: 'Long',
  decimal: 'DecimalString?',
  boolean: 'Boolean',
  datetime: 'Instant?',
  json: 'JsonObject',
};

/**
 * Relationship declarations, not scalar columns — an object row's wire
 * payload does not carry them, so they are excluded from DTO projection.
 */
const RELATION_FIELD_TYPES = new Set(['oneToMany', 'manyToMany', 'hasMany']);

const SWIFT_TYPE_BY_KOTLIN_TYPE: Record<string, string> = {
  String: 'String',
  // Explicit Int64: Swift Int is 32-bit on watchOS arm64_32/armv7k, and the
  // whole point of Long is byte-size/epoch values that overflow 32 bits.
  Long: 'Int64',
  Boolean: 'Bool',
  'Instant?': 'String?',
  'DecimalString?': 'String?',
  // Raw JSON string on the Swift side — Swift DTOs are plain structs (no
  // Codable) per the reporter seed; apps parse as needed.
  JsonObject: 'String',
  'List<String>': '[String]',
};

/** Name-based fallbacks for manifest fields that carry no `type`. */
const BOOLEAN_FIELD_NAMES = new Set([
  'required',
  'safetyCritical',
  'hasSafetyCriticalFallback',
]);
const INTEGER_FIELD_NAMES = new Set([
  'version',
  'sortOrder',
  'precision',
  'pageStart',
  'pageEnd',
  'replayOrder',
  'clientRevision',
  'serverRevision',
]);
const STRING_LIST_FIELD_NAMES = new Set([
  'ruleIds',
  'systemIds',
  'supportedLocales',
  'targetLocales',
  'requestedLocales',
  'includedLocales',
]);

export function buildMobileContract(
  options: MobileContractOptions,
): MobileContract {
  const { manifests, allowlist, kotlinPackage, sourceLabel = '' } = options;
  const candidates = manifests.flatMap(listObjects);

  const objects: MobileContractObject[] = [];
  const seenQualifiedNames = new Set<string>();
  for (const entry of allowlist) {
    const matches = candidates.filter(
      (object) => object.name === entry || object.qualifiedName === entry,
    );
    if (matches.length === 0) {
      throw new Error(`mobile allowlist references missing object: ${entry}`);
    }
    if (matches.length > 1) {
      const found = matches
        .map((match) => match.qualifiedName ?? match.name)
        .join(', ');
      throw new Error(
        `mobile allowlist entry "${entry}" is ambiguous (${found}) — use the qualified name`,
      );
    }
    const qualifiedName = matches[0].qualifiedName ?? matches[0].name;
    if (seenQualifiedNames.has(qualifiedName)) {
      // The same object listed under two spellings (short + qualified) is
      // redundant, not a collision — project it once.
      continue;
    }
    seenQualifiedNames.add(qualifiedName);
    objects.push(toMobileObject(matches[0]));
  }

  const dtoNameOwners = new Map<string, string>();
  for (const object of objects) {
    const prior = dtoNameOwners.get(object.dtoName);
    if (prior) {
      throw new Error(
        `mobile allowlist produces duplicate DTO name "${object.dtoName}" ` +
          `(${prior} and ${object.qualifiedName}) — generated files would ` +
          'overwrite each other; allowlisted objects need unique short names',
      );
    }
    dtoNameOwners.set(object.dtoName, object.qualifiedName);
  }

  const sourceHash = createHash('sha256')
    .update(JSON.stringify({ allowlist, objects }))
    .digest('hex');

  return {
    schemaVersion: SMRT_MOBILE_CONTRACT_SCHEMA_VERSION,
    contractVersion: SMRT_MOBILE_CONTRACT_VERSION,
    sourceLabel,
    sourceHash,
    objectAllowlist: [...allowlist],
    objectCount: objects.length,
    kotlin: { packageName: kotlinPackage },
    typeMappings: { ...KOTLIN_TYPE_BY_MANIFEST_TYPE },
    objects,
  };
}

function listObjects(manifest: {
  objects: Record<string, SmrtManifestObject> | SmrtManifestObject[];
}): SmrtManifestObject[] {
  return Array.isArray(manifest.objects)
    ? manifest.objects
    : Object.values(manifest.objects);
}

function toMobileObject(object: SmrtManifestObject): MobileContractObject {
  const fieldEntries = Object.entries(object.fields ?? {});
  const fields: MobileContractField[] = [];

  if (!fieldEntries.some(([name]) => name === 'id')) {
    fields.push({
      name: 'id',
      kotlinType: 'String',
      swiftType: 'String',
      nullable: false,
      kotlinDefault: null,
    });
  }

  for (const [name, meta] of fieldEntries) {
    if (meta.type && RELATION_FIELD_TYPES.has(meta.type)) {
      continue;
    }
    fields.push(mapField(name, meta));
  }

  return {
    name: object.name,
    qualifiedName: object.qualifiedName ?? object.name,
    dtoName: `${object.name}Dto`,
    tableName: object.schema?.tableName ?? null,
    hasTenantId: fieldEntries.some(([name]) => name === 'tenantId'),
    fields,
  };
}

function mapField(name: string, meta: SmrtManifestField): MobileContractField {
  const kotlinType = kotlinTypeFor(name, meta);
  return {
    name,
    kotlinType,
    swiftType: SWIFT_TYPE_BY_KOTLIN_TYPE[kotlinType] ?? 'String',
    nullable: kotlinType.endsWith('?'),
    kotlinDefault: name === 'id' ? null : kotlinDefaultFor(kotlinType, meta),
  };
}

function kotlinTypeFor(name: string, meta: SmrtManifestField): string {
  if (name === 'id') return 'String';
  if (meta.type && KOTLIN_TYPE_BY_MANIFEST_TYPE[meta.type]) {
    return KOTLIN_TYPE_BY_MANIFEST_TYPE[meta.type];
  }
  // Typeless manifest entries: fall back to the name heuristics the amaru
  // seed codegen used.
  if (STRING_LIST_FIELD_NAMES.has(name)) return 'List<String>';
  if (name.endsWith('Json')) return 'JsonObject';
  if (BOOLEAN_FIELD_NAMES.has(name)) return 'Boolean';
  if (INTEGER_FIELD_NAMES.has(name)) return 'Long';
  if (name.endsWith('At') || name.endsWith('On') || name.endsWith('_at'))
    return 'Instant?';
  return 'String';
}

function kotlinDefaultFor(kotlinType: string, meta: SmrtManifestField): string {
  // Current SMRT manifests carry the typed value in `default`; amaru-era
  // manifests carried a (possibly quoted) string in `defaultValue`.
  const declared =
    meta.default !== undefined ? meta.default : meta.defaultValue;
  switch (kotlinType) {
    case 'JsonObject':
      return 'JsonObject(emptyMap())';
    case 'List<String>':
      return 'emptyList()';
    case 'Boolean':
      return declared === true || declared === 'true' ? 'true' : 'false';
    case 'Long':
      return integerDefault(declared);
    case 'Instant?':
    case 'DecimalString?':
      return 'null';
    default:
      return stringDefault(declared);
  }
}

function integerDefault(defaultValue: unknown): string {
  const parsed = Number(String(defaultValue ?? '').replace(/['"]/g, ''));
  return Number.isFinite(parsed) && String(defaultValue ?? '').trim() !== ''
    ? String(Math.trunc(parsed))
    : '0';
}

function stringDefault(defaultValue: unknown): string {
  if (
    defaultValue === undefined ||
    defaultValue === null ||
    defaultValue === 'null'
  ) {
    return '""';
  }

  const text = String(defaultValue).trim();
  if (text === '') {
    return '""';
  }
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'string' ? kotlinStringLiteral(parsed) : '""';
    } catch {
      return '""';
    }
  }

  const singleQuoted = text.match(/^'([^']*)'$/);
  if (singleQuoted) {
    return kotlinStringLiteral(singleQuoted[1]);
  }

  // A raw (unquoted) string value — the shape current SMRT manifests emit.
  return kotlinStringLiteral(text);
}
