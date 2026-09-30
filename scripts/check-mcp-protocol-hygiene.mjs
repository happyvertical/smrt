#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--root')) {
  console.error('Usage: check-mcp-protocol-hygiene.mjs [--root repository]');
  process.exit(1);
}
const root = args.length ? resolve(args[1]) : resolve(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');
const sourceExtensions = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.svelte']);
const skippedDirectories = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.smrt',
  '.svelte-kit',
  '.generated-tmp',
]);
const banned = [
  ['PingRequestSchema', 'ping was removed'],
  ['logging/setLevel', 'logging/setLevel was removed'],
  ['SetLevelRequestSchema', 'logging/setLevel was removed'],
  ['notifications/roots/list_changed', 'roots list_changed was removed'],
  ['RootsListChangedNotificationSchema', 'roots list_changed was removed'],
  ['ListRootsRequestSchema', 'roots are deprecated'],
  ['sampling/createMessage', 'sampling is deprecated'],
  ['CreateMessageRequestSchema', 'sampling is deprecated'],
  ['mcp-session-id', 'sessions were removed'],
  ['SSEServerTransport', 'HTTP+SSE is deprecated'],
  ['SSEClientTransport', 'HTTP+SSE is deprecated'],
];
const findings = [];

for (const packageName of readdirSync(packagesDir)) {
  const packageDir = join(packagesDir, packageName);
  try {
    scan(packageDir);
  } catch {}
}

// Exempt a literal, never a line: adjacent retired feature use must still fail.
function negativeSessionHeaderLiterals(path, source) {
  if (!/\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) return [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (file.parseDiagnostics.length) return [];
  let importedExpect = false;
  let shadowedExpect = false;
  const ranges = [];
  const named = (node, name) => ts.isIdentifier(node) && node.text === name;
  const property = (node, name) =>
    ts.isPropertyAccessExpression(node) && !node.questionDotToken && named(node.name, name);
  const call = (node, count) =>
    ts.isCallExpression(node) && !node.questionDotToken && node.arguments.length === count;
  function bindsExpect(node) {
    if (named(node, 'expect')) return true;
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      return node.elements.some((element) => ts.isBindingElement(element) && bindsExpect(element.name));
    }
    return false;
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'vitest') {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        importedExpect ||= bindings.elements.some((entry) =>
          !node.importClause.isTypeOnly && !entry.isTypeOnly && named(entry.name, 'expect') &&
          (!entry.propertyName || named(entry.propertyName, 'expect')));
      }
    }
    // Conservatively refuse the exemption if the assertion name is rebound anywhere.
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name && bindsExpect(node.name)) {
      shadowedExpect = true;
    }
    if (ts.isBinaryExpression(node) && named(node.left, 'expect') && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) shadowedExpect = true;
    if (ts.isExpressionStatement(node)) {
      const matcher = node.expression;
      if (call(matcher, 1) && property(matcher.expression, 'toBe') && matcher.arguments[0].kind === ts.SyntaxKind.TrueKeyword) {
        const assertion = matcher.expression.expression;
        if (call(assertion, 1) && named(assertion.expression, 'expect')) {
          const every = assertion.arguments[0];
          if (call(every, 1) && property(every.expression, 'every') && ts.isIdentifier(every.expression.expression)) {
            const callback = every.arguments[0];
            if (ts.isArrowFunction(callback) && !callback.modifiers?.length && callback.parameters.length === 1) {
              const parameter = callback.parameters[0];
              const body = callback.body;
              if (ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken && ts.isPrefixUnaryExpression(body) && body.operator === ts.SyntaxKind.ExclamationToken) {
                const has = body.operand;
                if (call(has, 1) && property(has.expression, 'has')) {
                  const headers = has.expression.expression;
                  const literal = has.arguments[0];
                  if (property(headers, 'headers') && named(headers.expression, parameter.name.text) && ts.isStringLiteral(literal) && literal.text === 'mcp-session-id') {
                    ranges.push([literal.getStart(file), literal.end]);
                  }
                }
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return importedExpect && !shadowedExpect ? ranges : [];
}

function scan(directory) {
  const manifestPath = join(directory, 'package.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (manifest[section]?.['@modelcontextprotocol/sdk']) {
        findings.push(`${relative(root, manifestPath)}: direct monolithic SDK dependency`);
      }
    }
  } catch {}

  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    if (!sourceExtensions.has(extname(path))) continue;
    const source = readFileSync(path, 'utf8');
    let inspected = source;
    for (const [start, end] of negativeSessionHeaderLiterals(path, source)) {
      inspected = inspected.slice(0, start) + ' '.repeat(end - start) + inspected.slice(end);
    }
    const lines = inspected.split('\n');
    lines.forEach((line, index) => {
      if (line.includes('mcp-protocol-hygiene-allow:')) return;
      for (const [token, reason] of banned) {
        if (line.toLowerCase().includes(token.toLowerCase())) {
          findings.push(`${relative(root, path)}:${index + 1}: ${reason} (${token})`);
        }
      }
      if (/\b(?:client|server|mcp\w*)\s*\.\s*ping\s*\(/.test(line)) {
        findings.push(`${relative(root, path)}:${index + 1}: ping was removed`);
      }
    });
  }
}

if (findings.length) {
  console.error(`MCP 2026-07-28 protocol hygiene failed:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log('MCP protocol hygiene passed: scoped SDK manifests and no removed features.');
