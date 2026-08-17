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
 * Transpilation uses the `typescript` package that `@happyvertical/smrt-core`
 * already depends on, imported lazily so that merely importing the generators
 * does not pull the compiler into memory.
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

type TypeScriptApi = typeof import('typescript');

/**
 * Load the TypeScript compiler API lazily.
 *
 * `typescript` is CommonJS: Node's ESM interop exposes the whole API on
 * `default`, while bundlers hand back the namespace itself.
 *
 * It is an *optional* peer dependency (#2339): declaring it as a runtime
 * dependency made every consumer's bundler resolve cosmiconfig's
 * `require('typescript')` and pull the whole compiler into their production
 * server graph, even though only this transpile path needs it. Anyone
 * generating a `.js` MCP server installs `typescript` themselves; the throw
 * below tells them exactly that instead of surfacing ERR_MODULE_NOT_FOUND.
 */
async function loadTypeScript(): Promise<TypeScriptApi> {
  try {
    const imported = (await import('typescript')) as TypeScriptApi & {
      default?: TypeScriptApi;
    };
    return imported.default ?? imported;
  } catch (cause) {
    throw new Error(
      'Generating a JavaScript MCP server requires the optional peer dependency ' +
        '"typescript". Install it (pnpm add -D typescript) or emit TypeScript ' +
        'instead by giving generateServer() an output path ending in ".ts".',
      { cause },
    );
  }
}

/**
 * Transpile generated TypeScript to runnable ESM JavaScript.
 *
 * `verbatimModuleSyntax` keeps every value import the template emits (an
 * unused-looking import must not be elided: the generated server relies on
 * side effects and on imports whose only use is inside emitted switch cases),
 * while type-only import specifiers are dropped.
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
  const ts = await loadTypeScript();

  const { outputText, diagnostics } = ts.transpileModule(source, {
    // The input is always TypeScript regardless of where it will be written;
    // a `.js` file name here would make the compiler parse it as JavaScript.
    fileName: 'smrt-generated-mcp-source.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      verbatimModuleSyntax: true,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  });

  const errors = (diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    const details = errors
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      )
      .join('; ');
    throw new Error(
      `Failed to transpile generated MCP source (${label}): ${details}`,
    );
  }

  return outputText;
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
