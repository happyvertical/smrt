function hasOwnDefinedValue(
  source: Record<string, any> | undefined,
  key: string,
) {
  return !!source && Object.hasOwn(source, key) && source[key] !== undefined;
}

function readExistingFieldMeta(
  existingField: any,
  key: 'required' | 'default' | 'description',
) {
  if (hasOwnDefinedValue(existingField, key)) {
    return existingField[key];
  }

  if (hasOwnDefinedValue(existingField?._meta, key)) {
    return existingField._meta[key];
  }

  return undefined;
}

function readManifestFieldMeta(
  fieldDef: any,
  key: 'required' | 'default' | 'description',
) {
  if (hasOwnDefinedValue(fieldDef, key)) {
    return fieldDef[key];
  }

  if (hasOwnDefinedValue(fieldDef?._meta, key)) {
    return fieldDef._meta[key];
  }

  return undefined;
}

function assignDefinedMeta(
  target: Record<string, any>,
  source: Record<string, any> | undefined,
) {
  if (!source) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

export function createFieldFromManifest(fieldDef: any): any {
  const meta: Record<string, any> = {};

  assignDefinedMeta(meta, fieldDef?._meta);

  for (const key of ['required', 'default', 'description'] as const) {
    const value = readManifestFieldMeta(fieldDef, key);
    if (value !== undefined) {
      meta[key] = value;
    }
  }

  return {
    type: fieldDef.type,
    _meta: meta,
  };
}

export function mergeManifestField(existingField: any, fieldDef: any): any {
  const hasTenancyMarker =
    existingField.__tenancy?.isTenantIdField ||
    existingField._meta?.__tenancy?.isTenantIdField;

  const nextMeta: Record<string, any> = {
    ...(existingField._meta || {}),
  };

  assignDefinedMeta(nextMeta, fieldDef?._meta);

  for (const key of ['required', 'default', 'description'] as const) {
    const manifestValue = readManifestFieldMeta(fieldDef, key);
    if (manifestValue !== undefined) {
      nextMeta[key] = manifestValue;
      continue;
    }

    const existingValue = readExistingFieldMeta(existingField, key);
    if (existingValue !== undefined && nextMeta[key] === undefined) {
      nextMeta[key] = existingValue;
    }
  }

  return {
    ...existingField,
    type:
      !hasTenancyMarker && fieldDef.type ? fieldDef.type : existingField.type,
    _meta: nextMeta,
  };
}

export function manifestFieldDiffers(
  existingField: any,
  fieldDef: any,
): boolean {
  const mergedField = mergeManifestField(existingField, fieldDef);

  return (
    mergedField.type !== existingField.type ||
    JSON.stringify(mergedField._meta || {}) !==
      JSON.stringify(existingField._meta || {})
  );
}
