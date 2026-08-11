import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, parse, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

const CONFIG_NAMES = [
  'smrt.config.js',
  'smrt.config.mjs',
  'smrt.config.cjs',
  'smrt.config.ts',
  'smrt.config.mts',
  'smrt.config.cts',
  'smrt.config.json',
] as const;
const MAX_CONFIG_BYTES = 1_000_000;

type Node = Record<string, unknown>;

/**
 * Read only the database fields needed by runtime diagnostics. Source config is
 * parsed as data and is never imported or evaluated.
 */
export async function loadStaticRuntimeConfig(
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const configPath = await findConfig(resolve(rootDir));
  if (!configPath) return {};

  const fileStat = await stat(configPath);
  if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) {
    throw new Error('SMRT config is not a bounded regular file.');
  }
  const source = await readFile(configPath, 'utf8');
  if (extname(configPath) === '.json') return JSON.parse(source);

  const parsed = parseSync(configPath, source, {
    lang: /\.(?:ts|mts|cts)$/.test(configPath) ? 'ts' : 'js',
    preserveParens: false,
  });
  if (parsed.errors.length > 0) {
    throw new Error('SMRT config could not be parsed statically.');
  }

  const body = parsed.program.body as unknown as Node[];
  const variables = collectVariables(body);
  const root = findExport(body);
  if (!root) throw new Error('SMRT config has no static default export.');

  const database = getObjectPath(
    root,
    ['packages', 'cli', 'database'],
    variables,
    new Set(),
  );
  if (!database) return {};

  const typeNode = getObjectProperty(database, 'type', variables, new Set());
  const urlNode = getObjectProperty(database, 'url', variables, new Set());
  const type = evaluateStringProperty(database, 'type', variables, env);
  const url = evaluateStringProperty(database, 'url', variables, env);
  if ((typeNode && !type) || (urlNode && !url)) {
    throw new Error('SMRT database config is not statically readable.');
  }
  if (!type && !url) {
    throw new Error('SMRT database config is not statically readable.');
  }
  return { packages: { cli: { database: { type, url } } } };
}

async function findConfig(start: string): Promise<string | null> {
  let directory = start;
  try {
    if (!(await stat(directory)).isDirectory()) directory = dirname(directory);
  } catch {
    directory = dirname(directory);
  }

  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(directory, name);
      try {
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        // Continue the same deterministic search order as smrt-config.
      }
    }
    const parent = dirname(directory);
    if (parent === directory || directory === parse(directory).root)
      return null;
    directory = parent;
  }
}

function collectVariables(body: Node[]): Map<string, Node> {
  const variables = new Map<string, Node>();
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of (statement.declarations as Node[]) ?? []) {
      const id = declaration.id as Node | undefined;
      const init = declaration.init as Node | undefined;
      if (id?.type === 'Identifier' && typeof id.name === 'string' && init) {
        variables.set(id.name, init);
      }
    }
  }
  return variables;
}

function findExport(body: Node[]): Node | null {
  for (const statement of body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      return unwrap(statement.declaration as Node);
    }
    if (statement.type !== 'ExpressionStatement') continue;
    const expression = unwrap(statement.expression as Node);
    if (
      expression.type === 'AssignmentExpression' &&
      isModuleExports(expression.left as Node)
    ) {
      return unwrap(expression.right as Node);
    }
  }
  return null;
}

function isModuleExports(node: Node): boolean {
  const expression = unwrap(node);
  if (expression.type !== 'MemberExpression') return false;
  const object = expression.object as Node;
  const property = expression.property as Node;
  return (
    object?.type === 'Identifier' &&
    object.name === 'module' &&
    property?.type === 'Identifier' &&
    property.name === 'exports'
  );
}

function getObjectPath(
  input: Node,
  path: string[],
  variables: Map<string, Node>,
  seen: Set<string>,
): Node | null {
  let node = resolveReference(unwrapConfigCall(unwrap(input)), variables, seen);
  for (const segment of path) {
    const property = getObjectProperty(node, segment, variables, seen);
    if (!property) return null;
    node = resolveReference(unwrap(property), variables, seen);
  }
  return unwrap(node);
}

function getObjectProperty(
  input: Node,
  key: string,
  variables: Map<string, Node>,
  seen: Set<string>,
): Node | null {
  const node = resolveReference(
    unwrapConfigCall(unwrap(input)),
    variables,
    seen,
  );
  if (node.type !== 'ObjectExpression') return null;
  const properties = (node.properties as Node[]) ?? [];
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index];
    if (property.type === 'SpreadElement') {
      const spread = getObjectProperty(
        property.argument as Node,
        key,
        variables,
        seen,
      );
      if (spread) return spread;
      continue;
    }
    if (property.type !== 'Property' || property.computed === true) continue;
    const propertyKey = property.key as Node;
    const name =
      propertyKey.type === 'Identifier'
        ? propertyKey.name
        : propertyKey.type === 'Literal'
          ? propertyKey.value
          : undefined;
    if (name === key) return property.value as Node;
  }
  return null;
}

function evaluateStringProperty(
  object: Node,
  key: string,
  variables: Map<string, Node>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = getObjectProperty(object, key, variables, new Set());
  const evaluated = value
    ? evaluateScalar(value, variables, env, new Set())
    : undefined;
  return typeof evaluated === 'string' && evaluated.trim()
    ? evaluated.trim()
    : undefined;
}

function evaluateScalar(
  input: Node,
  variables: Map<string, Node>,
  env: NodeJS.ProcessEnv,
  seen: Set<string>,
): unknown {
  const node = unwrap(input);
  if (node.type === 'Literal') return node.value;
  if (node.type === 'Identifier' && typeof node.name === 'string') {
    if (node.name === 'undefined') return undefined;
    if (seen.has(node.name)) return undefined;
    const value = variables.get(node.name);
    if (!value) return undefined;
    const nextSeen = new Set(seen).add(node.name);
    return evaluateScalar(value, variables, env, nextSeen);
  }
  if (node.type === 'MemberExpression') return readEnvironment(node, env);
  if (node.type === 'LogicalExpression') {
    const left = evaluateScalar(node.left as Node, variables, env, seen);
    if (node.operator === '??') {
      return left ?? evaluateScalar(node.right as Node, variables, env, seen);
    }
    if (node.operator === '||') {
      return left || evaluateScalar(node.right as Node, variables, env, seen);
    }
    if (node.operator === '&&') {
      return left && evaluateScalar(node.right as Node, variables, env, seen);
    }
  }
  if (node.type === 'ConditionalExpression') {
    return evaluateScalar(node.test as Node, variables, env, seen)
      ? evaluateScalar(node.consequent as Node, variables, env, seen)
      : evaluateScalar(node.alternate as Node, variables, env, seen);
  }
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  ) {
    const quasi = (node.quasis as Node[])?.[0];
    const value = quasi?.value as Node | undefined;
    return value?.cooked ?? value?.raw;
  }
  return undefined;
}

function readEnvironment(
  input: Node,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const node = unwrap(input);
  if (node.type !== 'MemberExpression') return undefined;
  const object = unwrap(node.object as Node);
  const property = node.property as Node;
  if (object.type !== 'MemberExpression') return undefined;
  const processNode = object.object as Node;
  const envNode = object.property as Node;
  if (
    processNode?.type !== 'Identifier' ||
    processNode.name !== 'process' ||
    envNode?.type !== 'Identifier' ||
    envNode.name !== 'env'
  ) {
    return undefined;
  }
  const key =
    property?.type === 'Identifier'
      ? property.name
      : property?.type === 'Literal'
        ? property.value
        : undefined;
  return typeof key === 'string' ? env[key] : undefined;
}

function resolveReference(
  input: Node,
  variables: Map<string, Node>,
  seen: Set<string>,
): Node {
  const node = unwrap(input);
  if (node.type !== 'Identifier' || typeof node.name !== 'string') return node;
  if (seen.has(node.name)) return node;
  const value = variables.get(node.name);
  if (!value) return node;
  seen.add(node.name);
  return resolveReference(value, variables, seen);
}

function unwrapConfigCall(input: Node): Node {
  const node = unwrap(input);
  if (node.type !== 'CallExpression') return node;
  const callee = node.callee as Node;
  const args = node.arguments as Node[];
  return callee?.type === 'Identifier' &&
    callee.name === 'defineConfig' &&
    args?.length === 1
    ? unwrap(args[0])
    : node;
}

function unwrap(input: Node): Node {
  let node = input;
  while (
    node &&
    (node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'ParenthesizedExpression')
  ) {
    node = node.expression as Node;
  }
  return node;
}
