/**
 * Project Introspection Tool
 * Scans project directory for SMRT objects and analyzes structure
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface IntrospectProjectArgs {
  directory?: string;
  includeFields?: boolean;
  includeRelationships?: boolean;
}

interface SmrtObjectInfo {
  className: string;
  filePath: string;
  decoratorConfig?: any;
  fields?: Array<{ name: string; type: string }>;
  methods?: Array<{ name: string; isAsync: boolean }>;
  relationships?: Array<{ field: string; relatedClass: string; type: string }>;
}

export async function introspectProject(
  args: IntrospectProjectArgs,
): Promise<string> {
  const {
    directory = process.cwd(),
    includeFields = true,
    includeRelationships = true,
  } = args;

  const objects: SmrtObjectInfo[] = [];

  // Recursively scan directory for TypeScript files
  async function scanDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        // Skip node_modules, dist, and hidden directories
        if (entry.isDirectory()) {
          if (
            !['node_modules', 'dist', '.git', '.smrt'].includes(entry.name) &&
            !entry.name.startsWith('.')
          ) {
            await scanDirectory(fullPath);
          }
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))
        ) {
          // Skip test files and declaration files
          if (
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.spec.ts') &&
            !entry.name.endsWith('.d.ts')
          ) {
            await analyzeFile(fullPath);
          }
        }
      }
    } catch (error) {
      // Silently skip directories we can't read
    }
  }

  async function analyzeFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');

      // Check if file contains @smrt() decorator
      if (!content.includes('@smrt')) {
        return;
      }

      // Extract class name (basic regex for now)
      const classMatch = content.match(
        /export\s+class\s+(\w+)\s+extends\s+(\w+)/,
      );
      if (!classMatch) {
        return;
      }

      const className = classMatch[1];
      // const baseClass = classMatch[2]; // Reserved for future use
      const relativePath = relative(directory, filePath);

      const objInfo: SmrtObjectInfo = {
        className,
        filePath: relativePath,
      };

      // Extract decorator configuration
      const decoratorMatch = content.match(
        /@smrt\(([\s\S]*?)\)\s*export\s+class/,
      );
      if (decoratorMatch?.[1].trim()) {
        try {
          // Try to parse decorator config (simplified)
          objInfo.decoratorConfig =
            'Configuration found (parsing not fully implemented)';
        } catch {
          objInfo.decoratorConfig = 'Unable to parse';
        }
      }

      // Extract fields if requested
      if (includeFields) {
        objInfo.fields = [];

        // Pattern 1: TypeScript property declarations (new decorator pattern)
        // Example: name: string = ''; or price: number = 0.0;
        const tsFieldMatches = content.matchAll(
          /^\s*(?:@\w+\([^)]*\)\s*)*(\w+)(?::\s*([\w| ]+)(?:<[^>]+>)?)?\s*=\s*([^;\n]+)/gm,
        );
        for (const match of tsFieldMatches) {
          const fieldName = match[1];
          const tsType = match[2]?.trim() ?? inferTypeFromDefault(match[3]);

          // Skip constructor, methods, etc.
          if (fieldName === 'constructor') continue;

          // Map TypeScript types to field types
          let fieldType = tsType;
          if (tsType === 'string') fieldType = 'text';
          else if (tsType === 'number') {
            // Check if it's decimal (0.0) or integer (0)
            const valueMatch = content.match(
              new RegExp(`${fieldName}:\\s*number\\s*=\\s*([\\d.]+)`),
            );
            fieldType = valueMatch?.[1].includes('.') ? 'decimal' : 'integer';
          } else if (tsType === 'boolean') fieldType = 'boolean';
          else if (tsType === 'Date') fieldType = 'datetime';
          else if (tsType === 'any' || tsType === 'object') fieldType = 'json';

          objInfo.fields.push({
            name: fieldName,
            type: fieldType,
          });
        }
      }

      // Extract methods
      const methodMatches = content.matchAll(
        /^\s*(async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/gm,
      );
      objInfo.methods = [];
      for (const match of methodMatches) {
        const methodName = match[2];
        // Skip constructor
        if (methodName !== 'constructor') {
          objInfo.methods.push({
            name: methodName,
            isAsync: !!match[1],
          });
        }
      }

      // Extract relationships if requested
      if (includeRelationships) {
        objInfo.relationships = [];
        const decoratorMatches = content.matchAll(
          /@(foreignKey|crossPackageRef|oneToMany|manyToMany)\(([^)]*)\)\s*(\w+)\s*[:=]/g,
        );
        for (const match of decoratorMatches) {
          objInfo.relationships.push({
            field: match[3],
            type: match[1],
            relatedClass: cleanRelatedClass(match[2]),
          });
        }

        const assignmentMatches = content.matchAll(
          /(\w+)\s*=\s*(foreignKey|oneToMany|manyToMany)\((\w+)/g,
        );
        for (const match of assignmentMatches) {
          objInfo.relationships.push({
            field: match[1],
            type: match[2],
            relatedClass: match[3],
          });
        }
      }

      objects.push(objInfo);
    } catch (error) {
      // Silently skip files we can't process
    }
  }

  // Start scanning
  await scanDirectory(directory);

  // Format output
  const output = {
    projectPath: directory,
    objectCount: objects.length,
    objects: objects.map((obj) => ({
      className: obj.className,
      filePath: obj.filePath,
      ...(obj.decoratorConfig && { decoratorConfig: obj.decoratorConfig }),
      ...(obj.fields &&
        obj.fields.length > 0 && {
          fields: obj.fields.map((f) => `${f.name}: ${f.type}`).join(', '),
        }),
      ...(obj.methods &&
        obj.methods.length > 0 && {
          methods: obj.methods
            .map((m) => `${m.isAsync ? 'async ' : ''}${m.name}()`)
            .join(', '),
        }),
      ...(obj.relationships &&
        obj.relationships.length > 0 && {
          relationships: obj.relationships
            .map((r) => `${r.field} -> ${r.relatedClass} (${r.type})`)
            .join(', '),
        }),
    })),
  };

  return JSON.stringify(output, null, 2);
}

function inferTypeFromDefault(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") || trimmed.startsWith('"')) return 'string';
  if (trimmed === 'true' || trimmed === 'false') return 'boolean';
  if (/^\d+\.\d+/.test(trimmed) || /^\d+$/.test(trimmed)) return 'number';
  if (trimmed.startsWith('new Date')) return 'Date';
  return 'any';
}

function cleanRelatedClass(value: string): string {
  const firstArg = value.split(',')[0]?.trim() ?? '';
  return firstArg.replace(/^['"`]/, '').replace(/['"`]$/, '');
}
