/**
 * Harden SMRT Class Tool (#4936, rule 3 of #4920)
 *
 * Suggests a hardening for a smrt class an app uses and, only when asked,
 * writes it into the app's code as a same-named subclass that overrides the
 * fields. The app owns its data shape: the override is code, and the build and
 * `smrt db:migrate` turn it into constraints.
 *
 * This tool never touches a database. It reads one installed package manifest
 * (JSON, to check the class and field names) and writes one source file under
 * the project directory. It imports no database client and has no function
 * that builds SQL; `harden-smrt-class.test.ts` pins that.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type PropertyType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json';

interface FieldOverride {
  /** Field name on the smrt class. */
  name: string;
  /** Needed when the installed manifest is not available to read the type from. */
  type?: PropertyType;
  /** `true` hardens, `false` loosens. */
  required?: boolean;
  /** Longest allowed text, for a `text` field. */
  maxLength?: number;
  /** Default value source text is not accepted; hardening states options only. */
  description?: string;
}

export interface HardenSmrtClassArgs {
  /** The smrt class the app uses (for example `Customer`). */
  className: string;
  /** The package that exports it (for example `@happyvertical/smrt-crm`). */
  importFrom: string;
  overrides: FieldOverride[];
  /** Project root. Default: the current directory. */
  directory?: string;
  /** Where the subclass goes, relative to `directory`. Default `src/models/<ClassName>.ts`. */
  outputPath?: string;
  /** Write the file. Default `false`: only return the suggestion. */
  write?: boolean;
}

interface ManifestField {
  type?: string;
  required?: boolean;
  _meta?: { requiredFor?: string; [key: string]: unknown };
}

const TYPE_MAPPING: Record<
  PropertyType,
  { tsType: string; initializer: string }
> = {
  text: { tsType: 'string', initializer: "''" },
  integer: { tsType: 'number', initializer: '0' },
  decimal: { tsType: 'number', initializer: '0.0' },
  boolean: { tsType: 'boolean', initializer: 'false' },
  datetime: { tsType: 'Date', initializer: 'new Date()' },
  json: { tsType: 'any', initializer: '{}' },
};

const MANIFEST_TYPE_TO_PROPERTY: Record<string, PropertyType> = {
  text: 'text',
  integer: 'integer',
  decimal: 'decimal',
  boolean: 'boolean',
  datetime: 'datetime',
  json: 'json',
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export interface HardenSmrtClassResult {
  /** The subclass source. */
  source: string;
  /** Where it goes, relative to the project directory. */
  path: string;
  /** `true` when the file was written. */
  written: boolean;
  /** What to do next, in plain words. */
  next: string[];
  /** Things the tool could not check. */
  notes: string[];
}

/** The installed package's manifest, when it can be read. */
function readParentFields(
  directory: string,
  importFrom: string,
  className: string,
): Record<string, ManifestField> | null {
  const path = join(
    directory,
    'node_modules',
    importFrom,
    'dist/manifest.json',
  );
  if (!existsSync(path)) return null;
  let manifest: {
    objects?: Record<
      string,
      { className?: string; fields?: Record<string, ManifestField> }
    >;
  };
  try {
    manifest = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  const object = Object.values(manifest.objects ?? {}).find(
    (candidate) => candidate.className === className,
  );
  return object?.fields ?? null;
}

function fieldSource(
  override: FieldOverride,
  type: PropertyType,
  required: boolean,
): string {
  const options: string[] = [];
  options.push(`required: ${required}`);
  if (override.maxLength !== undefined) {
    options.push(`maxLength: ${override.maxLength}`);
  }
  if (override.description) {
    options.push(`description: ${JSON.stringify(override.description)}`);
  }
  const { tsType, initializer } = TYPE_MAPPING[type];
  return `  @field({ ${options.join(', ')} })\n  override ${override.name}: ${tsType} = ${initializer};`;
}

/** Build the suggestion, and write it when `write` is true. */
export async function hardenSmrtClass(
  args: HardenSmrtClassArgs,
): Promise<string> {
  const result = harden(args);
  return JSON.stringify(result, null, 2);
}

export function harden(args: HardenSmrtClassArgs): HardenSmrtClassResult {
  const { className, importFrom, overrides } = args;
  if (!IDENTIFIER.test(className)) {
    throw new Error(`className must be a class name, got "${className}".`);
  }
  if (!PACKAGE_NAME.test(importFrom)) {
    throw new Error(`importFrom must be a package name, got "${importFrom}".`);
  }
  if (!Array.isArray(overrides) || overrides.length === 0) {
    throw new Error('overrides needs at least one field.');
  }
  const directory = resolve(args.directory ?? process.cwd());
  const parentFields = readParentFields(directory, importFrom, className);
  const notes: string[] = [];
  if (!parentFields) {
    notes.push(
      `Could not read ${importFrom}/dist/manifest.json, so field names, types and reasons were not checked. The build still checks them.`,
    );
  }

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const override of overrides) {
    if (!IDENTIFIER.test(override.name)) {
      throw new Error(`Field name "${override.name}" is not a valid name.`);
    }
    if (seen.has(override.name)) {
      throw new Error(`Field "${override.name}" is listed twice.`);
    }
    seen.add(override.name);
    if (
      override.maxLength !== undefined &&
      !(Number.isInteger(override.maxLength) && override.maxLength > 0)
    ) {
      throw new Error(
        `${override.name}: maxLength must be a positive whole number.`,
      );
    }
    const parent = parentFields?.[override.name];
    if (parentFields && !parent) {
      throw new Error(
        `${className} has no field "${override.name}" in ${importFrom}. Add a new field with generate-smrt-class in a differently named subclass, or check the name.`,
      );
    }
    const required = override.required ?? true;
    // The same limit the build enforces: smrt may need a required field.
    if (
      parent?.required === true &&
      required === false &&
      typeof parent._meta?.requiredFor === 'string'
    ) {
      throw new Error(
        `${className}.${override.name} cannot be made optional. smrt needs it (${parent._meta.requiredFor}).`,
      );
    }
    const type =
      override.type ??
      (parent?.type ? MANIFEST_TYPE_TO_PROPERTY[parent.type] : undefined);
    if (!type) {
      throw new Error(
        `${override.name}: give a type (text, integer, decimal, boolean, datetime or json); it could not be read from ${importFrom}.`,
      );
    }
    lines.push(fieldSource(override, type, required));
  }

  const alias = `Smrt${className}`;
  const source = [
    `import { field, smrt } from '@happyvertical/smrt-core';`,
    `import { ${className} as ${alias} } from '${importFrom}';`,
    '',
    '/**',
    ` * The app's ${className}. Same name as the smrt class, so it replaces it`,
    ' * everywhere. Only the fields below change; everything else is inherited.',
    ' */',
    '@smrt()',
    `export class ${className} extends ${alias} {`,
    lines.join('\n\n'),
    '}',
    '',
  ].join('\n');

  const path = args.outputPath ?? join('src', 'models', `${className}.ts`);
  const target = resolve(directory, path);
  const inside = relative(directory, target);
  if (
    isAbsolute(path) ||
    inside.startsWith('..') ||
    inside.split(sep)[0] === '..'
  ) {
    throw new Error('outputPath must stay inside the project directory.');
  }

  let written = false;
  if (args.write === true) {
    if (existsSync(target)) {
      throw new Error(
        `${inside} already exists. Not overwriting it; edit the class by hand or choose another outputPath.`,
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source, { flag: 'wx' });
    written = true;
  }

  return {
    source,
    path: inside,
    written,
    next: [
      written
        ? `Check ${inside}, and export the class where the app registers its models.`
        : `Review the source. Run again with write: true to create ${inside}.`,
      'Run the build. It refuses a change smrt cannot allow, and names the class and field.',
      'Run `smrt db:migrate`. It applies the constraint. It stops, with a report, if existing rows break the rule.',
    ],
    notes,
  };
}
