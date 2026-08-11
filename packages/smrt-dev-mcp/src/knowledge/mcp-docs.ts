import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Tool } from '@modelcontextprotocol/server';

export interface McpDocumentationIssue {
  severity: 'error';
  code: string;
  message: string;
  file: string;
  packageName: string;
}

interface DocumentedParameter {
  name: string;
  required: boolean;
  type: string;
}

const PACKAGE_NAME = '@happyvertical/smrt-dev-mcp';

/**
 * Compare the authored development-MCP catalog to the actual exported tools.
 * The parser intentionally checks only stable structural Markdown: tool names
 * plus top-level input-property names, types, enums, and requiredness.
 * Descriptive prose and prose-embedded defaults remain authored.
 */
export function checkMcpToolDocumentation(
  rootDir: string,
  packageDir: string,
  tools: readonly Tool[],
): McpDocumentationIssue[] {
  const readmePath = join(packageDir, 'README.md');
  const agentsPath = join(packageDir, 'AGENTS.md');
  const issues: McpDocumentationIssue[] = [];

  if (!existsSync(readmePath)) {
    issues.push(
      issue(
        rootDir,
        readmePath,
        'mcp-readme-missing',
        'MCP package README.md is missing',
      ),
    );
    return issues;
  }

  const expectedTools = [...tools].sort((left, right) =>
    compareNames(left.name, right.name),
  );
  const readme = readFileSync(readmePath, 'utf8');
  const { sections: readmeSections, names: documentedToolNames } =
    readToolSections(readme);
  const expectedToolNames = expectedTools.map((tool) => tool.name);
  const readmeCatalogDiff = setDifference(
    expectedToolNames,
    documentedToolNames,
  );

  if (readmeCatalogDiff) {
    issues.push(
      issue(
        rootDir,
        readmePath,
        'mcp-readme-tool-drift',
        `README tool catalog differs from exported TOOLS (${readmeCatalogDiff})`,
      ),
    );
  }

  for (const tool of expectedTools) {
    const section = readmeSections.get(tool.name);
    if (section === undefined) continue;

    const {
      parameters: documentedParameters,
      names: documentedParameterNames,
    } = readParameterTable(section);
    const expectedProperties = Object.keys(
      tool.inputSchema.properties ?? {},
    ).sort(compareNames);
    const propertyDiff = setDifference(
      expectedProperties,
      documentedParameterNames,
    );
    const required = new Set(tool.inputSchema.required ?? []);
    const requiredness = expectedProperties
      .filter(
        (name) =>
          documentedParameters.has(name) &&
          documentedParameters.get(name)?.required !== required.has(name),
      )
      .map(
        (name) =>
          `${name} expected ${required.has(name) ? 'Yes' : 'No'} but documented ${documentedParameters.get(name)?.required ? 'Yes' : 'No'}`,
      );
    const inputProperties = tool.inputSchema.properties ?? {};
    const types = expectedProperties
      .filter((name) => documentedParameters.has(name))
      .flatMap((name) => {
        const expected = formatSchemaType(inputProperties[name]);
        const documented = documentedParameters.get(name)?.type;
        return documented === expected
          ? []
          : [`${name} expected ${expected} but documented ${documented}`];
      });
    const details = [
      propertyDiff,
      requiredness.length > 0
        ? `requiredness: ${requiredness.join(', ')}`
        : undefined,
      types.length > 0 ? `types: ${types.join(', ')}` : undefined,
    ].filter((value): value is string => Boolean(value));

    if (details.length > 0) {
      issues.push(
        issue(
          rootDir,
          readmePath,
          'mcp-readme-schema-drift',
          `README parameters for "${tool.name}" differ from its exported input schema (${details.join('; ')})`,
        ),
      );
    }
  }

  if (!existsSync(agentsPath)) return issues;
  const documentedAgentTools = readAgentToolNames(
    readFileSync(agentsPath, 'utf8'),
  ).sort(compareNames);
  const agentsCatalogDiff = setDifference(
    expectedToolNames,
    documentedAgentTools,
  );
  if (agentsCatalogDiff) {
    issues.push(
      issue(
        rootDir,
        agentsPath,
        'mcp-agents-tool-drift',
        `AGENTS.md tool catalog differs from exported TOOLS (${agentsCatalogDiff})`,
      ),
    );
  }

  return issues;
}

function issue(
  rootDir: string,
  path: string,
  code: string,
  message: string,
): McpDocumentationIssue {
  return {
    severity: 'error',
    code,
    message,
    file: relative(rootDir, path),
    packageName: PACKAGE_NAME,
  };
}

function readToolSections(markdown: string): {
  sections: Map<string, string>;
  names: string[];
} {
  const availableTools = sectionAfterHeading(markdown, 'Available Tools');
  if (!availableTools) return { sections: new Map(), names: [] };

  const headings = [...availableTools.matchAll(/^### `([^`]+)`\s*$/gm)];
  return {
    sections: new Map(
      headings.map((heading, index) => {
        const start = (heading.index ?? 0) + heading[0].length;
        const end = headings[index + 1]?.index ?? availableTools.length;
        return [heading[1], availableTools.slice(start, end)];
      }),
    ),
    names: headings.map((heading) => heading[1]),
  };
}

function readParameterTable(section: string): {
  parameters: Map<string, DocumentedParameter>;
  names: string[];
} {
  const parameters = new Map<string, DocumentedParameter>();
  const names: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    const name = /^`([^`]+)`$/.exec(cells[0]?.trim() ?? '')?.[1];
    const required = cells[2]?.trim();
    if (!name || (required !== 'Yes' && required !== 'No')) continue;
    names.push(name);
    parameters.set(name, {
      name,
      required: required === 'Yes',
      type: normalizeDocumentedType(cells[1] ?? ''),
    });
  }
  return { parameters, names };
}

function normalizeDocumentedType(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.startsWith('`') && trimmed.endsWith('`')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted
    .replaceAll('\\|', '|')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
}

function formatSchemaType(value: unknown): string {
  if (!isRecord(value)) return 'unknown';

  if (Array.isArray(value.oneOf)) {
    return unique(value.oneOf.map(formatSchemaType)).join(' | ');
  }

  if (Array.isArray(value.enum) && value.enum.length > 0) {
    return value.enum.map(formatEnumValue).join(' | ');
  }

  if (value.type === 'array') {
    const itemType = formatSchemaType(value.items);
    return itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`;
  }

  if (Array.isArray(value.type)) {
    return unique(value.type.map(String)).join(' | ');
  }

  return typeof value.type === 'string' ? value.type : 'unknown';
}

function formatEnumValue(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", "\\'")}'`;
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function splitMarkdownRow(row: string): string[] {
  const content = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '|' && content[index - 1] !== '\\') {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function readAgentToolNames(markdown: string): string[] {
  const toolsSection = sectionAfterHeading(markdown, 'Tools');
  if (!toolsSection) return [];
  return [...toolsSection.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(
    (match) => match[1],
  );
}

function sectionAfterHeading(markdown: string, heading: string): string {
  const marker = new RegExp(`^## ${heading}\\s*$`, 'm').exec(markdown);
  if (!marker) return '';
  const start = (marker.index ?? 0) + marker[0].length;
  const remainder = markdown.slice(start);
  const nextHeading = /^##\s+/m.exec(remainder);
  return remainder.slice(0, nextHeading?.index ?? remainder.length);
}

function setDifference(
  expected: readonly string[],
  actual: readonly string[],
): string | undefined {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected
    .filter((value) => !actualSet.has(value))
    .sort(compareNames);
  const extra = unique(actual.filter((value) => !expectedSet.has(value))).sort(
    compareNames,
  );
  const expectedDuplicates = duplicateNames(expected);
  const actualDuplicates = duplicateNames(actual);
  const parts = [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    extra.length > 0 ? `extra: ${extra.join(', ')}` : undefined,
    expectedDuplicates.length > 0
      ? `exported duplicates: ${expectedDuplicates.join(', ')}`
      : undefined,
    actualDuplicates.length > 0
      ? `duplicates: ${actualDuplicates.join(', ')}`
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function duplicateNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareNames);
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
