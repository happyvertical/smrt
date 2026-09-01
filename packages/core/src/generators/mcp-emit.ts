/**
 * Emit helpers for generated MCP server sources.
 *
 * The MCP generators build their output as TypeScript source: the runtime
 * template carries type-only imports, type annotations, and generics. Whatever
 * the caller asked for as `outputPath` decides how that source has to be
 * written (#2279):
 *
 * - `.ts` / `.mts` — write the TypeScript verbatim. The consumer runs it
 *   through `tsx` or Node's type stripping, which is what the repository's own
 *   MCP conformance fixture does. The generated source therefore has to stay
 *   erasable-syntax-only.
 * - `.cjs` / `.cts` — rejected. Generated servers are ES modules, so a
 *   CommonJS target cannot run in any language.
 * - anything else (`.js` by default) — transpile to JavaScript first, so
 *   `node .smrt/mcp-server/index.js` runs instead of dying on
 *   `SyntaxError: Unexpected identifier 'CallToolRequest'`.
 *
 * Transpilation uses `oxc-transform`, which strips the generated source's
 * erasable TypeScript syntax without making the TypeScript compiler a runtime
 * dependency of `@happyvertical/smrt-core` (#2339).
 */

/** Language a generated file is written in, derived from its extension. */
export type GeneratedSourceLanguage = 'typescript' | 'javascript';

/** Extension a generated module may be written with. */
export type GeneratedSourceExtension = '.ts' | '.mts' | '.js' | '.mjs';

const TYPESCRIPT_EXTENSIONS = ['.ts', '.mts'];

/**
 * Generated servers are ES modules — they use `import` and `import.meta.url` —
 * so a CommonJS target can never run whatever language it is written in.
 */
const COMMONJS_EXTENSIONS = ['.cjs', '.cts'];

type OxcTransform = typeof import('oxc-transform').transform;

/**
 * Load OXC only for JavaScript emission. Core exports every generator from its
 * package root, so loading native OXC bindings at module evaluation would make
 * ordinary ORM and TypeScript-output consumers depend on this optional path.
 */
async function loadOxcTransform(): Promise<OxcTransform> {
  const { transform } = await import('oxc-transform');
  return transform;
}

function assertModuleTarget(outputPath: string, lowerCased: string): void {
  const commonJs = COMMONJS_EXTENSIONS.find((extension) =>
    lowerCased.endsWith(extension),
  );
  if (commonJs) {
    throw new Error(
      `Cannot generate an MCP server at '${outputPath}': the generated server is an ES module, so a ${commonJs} target cannot run. Use .js/.mjs for JavaScript or .ts/.mts for TypeScript.`,
    );
  }
}

/**
 * Decide how a generated file must be written from the path the caller asked
 * for. Unknown extensions emit JavaScript: `node` is the documented way to run
 * a generated server, so JavaScript is the safe default.
 *
 * @param outputPath - Path the generated file will be written to
 * @returns The language the file contents must be written in
 * @throws When the path asks for a CommonJS target
 */
export function resolveGeneratedSourceLanguage(
  outputPath: string,
): GeneratedSourceLanguage {
  const lowerCased = outputPath.toLowerCase();
  assertModuleTarget(outputPath, lowerCased);
  return TYPESCRIPT_EXTENSIONS.some((extension) =>
    lowerCased.endsWith(extension),
  )
    ? 'typescript'
    : 'javascript';
}

/**
 * Extension for modules emitted alongside a generated entry point, so the
 * modular server's relative imports resolve to files that exist on disk *and*
 * are loaded with the entry's own module semantics. An `.mjs` entry point in a
 * CommonJS package needs `.mjs` siblings, not `.js` ones that Node would then
 * parse as CommonJS.
 *
 * @param outputPath - Path of the generated entry point
 * @returns The extension every sibling module is written with
 * @throws When the path asks for a CommonJS target
 */
export function generatedSiblingExtension(
  outputPath: string,
): GeneratedSourceExtension {
  const lowerCased = outputPath.toLowerCase();
  assertModuleTarget(outputPath, lowerCased);
  if (lowerCased.endsWith('.mts')) return '.mts';
  if (lowerCased.endsWith('.ts')) return '.ts';
  if (lowerCased.endsWith('.mjs')) return '.mjs';
  return '.js';
}

/**
 * Transpile generated TypeScript to runnable ESM JavaScript.
 *
 * Generated source is constrained to erasable TypeScript syntax, so OXC can
 * strip annotations and type-only import specifiers while leaving the ES
 * module's runtime imports intact.
 *
 * @param source - Generated TypeScript source
 * @param label - Target path or name reported in transpile diagnostics
 * @returns Equivalent JavaScript source
 * @throws When the generated source is not valid TypeScript
 */
export async function transpileGeneratedSource(
  source: string,
  label = 'generated MCP source',
): Promise<string> {
  const transform = await loadOxcTransform();
  const { code, errors } = await transform(
    'smrt-generated-mcp-source.ts',
    source,
    { lang: 'ts', sourceType: 'module' },
  );
  if (errors.length > 0) {
    const details = errors.map((diagnostic) => diagnostic.message).join('; ');
    throw new Error(
      `Failed to transpile generated MCP source (${label}): ${details}`,
    );
  }

  return code;
}

/**
 * Render generated TypeScript for the requested output language.
 *
 * @param source - Generated TypeScript source
 * @param language - Language the file must be written in
 * @param label - Target path or name reported in transpile diagnostics
 * @returns Source ready to be written to disk
 */
export async function renderGeneratedSource(
  source: string,
  language: GeneratedSourceLanguage,
  label = 'generated MCP source',
): Promise<string> {
  if (language === 'typescript') {
    return source;
  }
  return transpileGeneratedSource(source, label);
}
