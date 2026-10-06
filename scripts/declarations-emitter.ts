import { dirname, relative } from 'node:path';
import ts from 'typescript';

/** Normalize relative declaration references during emit, preserving compiler maps. */
function portableReferences(
  options: ts.CompilerOptions,
): ts.TransformerFactory<ts.SourceFile | ts.Bundle> {
  const cache = ts.createModuleResolutionCache(
    process.cwd(),
    (path) => (ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase()),
    options,
  );
  return (context) => {
    const factory = context.factory;
    const transformFile = (source: ts.SourceFile): ts.SourceFile => {
      const rewrite = (literal: ts.StringLiteral): ts.StringLiteral => {
        const text = literal.text;
        if (
          text !== '.' &&
          text !== '..' &&
          !text.startsWith('./') &&
          !text.startsWith('../')
        )
          return literal;
        // Explicit runtime and asset suffixes are already part of the contract.
        if (/\.(?:[cm]?js|jsx|json|svelte|css|svg|wasm)$/.test(text))
          return literal;
        const resolved = ts.resolveModuleName(
          text,
          source.fileName,
          options,
          ts.sys,
          cache,
        ).resolvedModule;
        if (
          !resolved ||
          !/\.(?:[cm]?tsx?|[cm]?jsx?)$/.test(resolved.resolvedFileName)
        )
          return literal;
        let target = relative(
          dirname(source.fileName),
          resolved.resolvedFileName,
        )
          .replace(/\\/g, '/')
          .replace(/(?:\.d)?\.mts$/, '.mjs')
          .replace(/(?:\.d)?\.cts$/, '.cjs')
          .replace(/(?:\.d)?\.tsx?$/, '.js');
        if (!target.startsWith('.')) target = `./${target}`;
        if (target === text) return literal;
        return ts.setTextRange(
          ts.setOriginalNode(factory.createStringLiteral(target), literal),
          literal,
        );
      };
      const visit: ts.Visitor = (node) => {
        node = ts.visitEachChild(node, visit, context);
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          return factory.updateImportDeclaration(
            node,
            node.modifiers,
            node.importClause,
            rewrite(node.moduleSpecifier),
            node.attributes,
          );
        }
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          return factory.updateExportDeclaration(
            node,
            node.modifiers,
            node.isTypeOnly,
            node.exportClause,
            rewrite(node.moduleSpecifier),
            node.attributes,
          );
        }
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        ) {
          return factory.updateImportTypeNode(
            node,
            factory.updateLiteralTypeNode(
              node.argument,
              rewrite(node.argument.literal),
            ),
            node.attributes,
            node.qualifier,
            node.typeArguments,
            node.isTypeOf,
          );
        }
        if (
          ts.isExternalModuleReference(node) &&
          ts.isStringLiteral(node.expression)
        ) {
          return factory.updateExternalModuleReference(
            node,
            rewrite(node.expression),
          );
        }
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
          return factory.updateModuleDeclaration(
            node,
            node.modifiers,
            rewrite(node.name),
            node.body,
          );
        }
        return node;
      };
      return ts.visitEachChild(source, visit, context);
    };
    return (node) =>
      ts.isBundle(node)
        ? factory.updateBundle(node, node.sourceFiles.map(transformFile))
        : transformFile(node);
  };
}

const configPath = process.argv[2];
if (!configPath)
  throw new Error('A declaration project configuration is required');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(
  config.config ?? {},
  ts.sys,
  dirname(configPath),
  undefined,
  configPath,
);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
});
const diagnostics = [
  ...(config.error ? [config.error] : []),
  ...parsed.errors,
  ...ts.getPreEmitDiagnostics(program),
];
if (
  !diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)
) {
  const result = program.emit(undefined, undefined, undefined, true, {
    afterDeclarations: [portableReferences(parsed.options)],
  });
  diagnostics.push(...result.diagnostics);
  // Like tsc, skipped non-declaration assets (for example JSON) are not errors.
}
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  );
}
if (diagnostics.length) process.exitCode = 1;
