export type BoxedPrimitiveKind = 'bigint' | 'boolean' | 'number' | 'string';

type NodeUtilTypes = {
  isBigIntObject(value: object): boolean;
  isBooleanObject(value: object): boolean;
  isBoxedPrimitive(value: object): boolean;
  isNumberObject(value: object): boolean;
  isStringObject(value: object): boolean;
};

const nodeTypes = (() => {
  const nodeProcess = (
    globalThis as typeof globalThis & {
      process?: { getBuiltinModule?: (id: string) => unknown };
    }
  ).process;
  const getBuiltinModule = nodeProcess?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return undefined;
  return (
    Reflect.apply(getBuiltinModule, nodeProcess, ['node:util']) as {
      types?: NodeUtilTypes;
    }
  ).types;
})();

export function getBoxedPrimitiveKind(
  value: object,
): BoxedPrimitiveKind | undefined {
  if (nodeTypes) {
    if (!nodeTypes.isBoxedPrimitive(value)) return undefined;
    if (nodeTypes.isNumberObject(value)) return 'number';
    if (nodeTypes.isStringObject(value)) return 'string';
    if (nodeTypes.isBooleanObject(value)) return 'boolean';
    if (nodeTypes.isBigIntObject(value)) return 'bigint';
    return undefined;
  }
  try {
    Number.prototype.valueOf.call(value);
    return 'number';
  } catch {}
  try {
    String.prototype.valueOf.call(value);
    return 'string';
  } catch {}
  try {
    Boolean.prototype.valueOf.call(value);
    return 'boolean';
  } catch {}
  try {
    BigInt.prototype.valueOf.call(value);
    return 'bigint';
  } catch {}
  return undefined;
}

export function isRawJSON(value: object): value is { rawJSON: string } {
  const nativeJSON = JSON as typeof JSON & {
    isRawJSON?: (value: unknown) => value is { rawJSON: string };
  };
  return (
    typeof nativeJSON.isRawJSON === 'function' && nativeJSON.isRawJSON(value)
  );
}
