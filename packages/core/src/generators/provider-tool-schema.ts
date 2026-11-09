import type { ToolJsonSchema } from './tool-schema.js';

/**
 * Prepare a generated tool's input schema for a model provider's function
 * calling (OpenAI, Anthropic and others), which accept a narrower JSON Schema
 * than MCP does.
 *
 * Generated MCP schemas are valid draft 2020-12, but providers reject some of
 * their shapes. A generated `<model>_get` tool declares
 * `anyOf: [{ required: ['id'] }, { required: ['slug'] }]` at the top level, and
 * both OpenAI ("schema must have type 'object' and not have
 * 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level") and Anthropic
 * ("input_schema does not support oneOf, allOf, or anyOf at the top level")
 * answer 400 for the whole request when any one tool carries it. One bad tool
 * then breaks every model call. This helper returns a self-contained schema:
 *
 * - local `$ref`s into `$defs` are inlined (a cycle becomes an open `{}`) and
 *   `$defs` and `$schema` are dropped;
 * - a top-level `anyOf` / `oneOf` / `allOf` / `not` / `enum` / `const` is
 *   removed. When it only listed `required` alternatives, they are kept as a
 *   sentence in the description ("Provide one of: id, slug.").
 *
 * The input is not modified. MCP clients keep the original schema.
 */
export function toProviderToolSchema(schema: unknown): ToolJsonSchema {
  const root =
    schema && typeof schema === 'object' && !Array.isArray(schema)
      ? (schema as ToolJsonSchema)
      : {};
  const defs = (
    root.$defs && typeof root.$defs === 'object' ? root.$defs : {}
  ) as Record<string, unknown>;

  const inline = (node: unknown, trail: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => inline(n, trail));
    if (!node || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === 'string') {
      const name = ref.startsWith('#/$defs/') ? ref.slice(8) : undefined;
      if (
        name === undefined ||
        !Object.hasOwn(defs, name) ||
        trail.includes(name)
      )
        return {};
      const { $ref: _ref, ...rest } = obj;
      const target = inline(defs[name], [...trail, name]) as Record<
        string,
        unknown
      >;
      return { ...target, ...(inline(rest, trail) as Record<string, unknown>) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$defs' || key === '$schema') continue;
      out[key] = inline(value, trail);
    }
    return out;
  };

  const flat = inline(root, []) as Record<string, unknown>;
  const alternatives = flat.anyOf ?? flat.oneOf;
  const names = Array.isArray(alternatives)
    ? alternatives.flatMap((alt) =>
        alt &&
        typeof alt === 'object' &&
        Array.isArray((alt as { required?: unknown }).required)
          ? ((alt as { required: unknown[] }).required.filter(
              (x) => typeof x === 'string',
            ) as string[])
          : [],
      )
    : [];
  for (const key of ['anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const'])
    delete flat[key];
  if (names.length > 0) {
    const note = `Provide one of: ${names.join(', ')}.`;
    flat.description =
      typeof flat.description === 'string'
        ? `${flat.description} ${note}`
        : note;
  }
  return {
    ...flat,
    type: 'object',
    properties:
      flat.properties && typeof flat.properties === 'object'
        ? flat.properties
        : {},
  };
}
