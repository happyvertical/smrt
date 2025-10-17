/**
 * Code generator for SMRT schema methods
 * Generates getSchema() static methods for SMRT objects
 */

import type { SmartObjectDefinition } from '../scanner/types';
import type { SchemaDefinition } from './types';

export class SchemaCodeGenerator {
  /**
   * Generate getSchema() method source code
   */
  generateSchemaMethod(
    _objectDef: SmartObjectDefinition,
    schema: SchemaDefinition,
  ): string {
    const imports = this.generateImports();
    const method = this.generateMethod(schema);

    return `${imports}\n\n${method}`;
  }

  /**
   * Generate complete schema file with all methods
   */
  generateSchemaFile(schemas: Record<string, SchemaDefinition>): string {
    const imports = this.generateImports();
    const methods = Object.entries(schemas)
      .map(([className, schema]) => this.generateClassMethod(className, schema))
      .join('\n\n');

    return `${imports}\n\n${methods}`;
  }

  /**
   * Generate import statements
   */
  private generateImports(): string {
    return `import type { SchemaDefinition } from '@smrt/core/schema';`;
  }

  /**
   * Generate getSchema method for a specific class
   */
  private generateClassMethod(
    className: string,
    schema: SchemaDefinition,
  ): string {
    const methodBody = this.generateSchemaObject(schema);

    return `export class ${className}Schema {
  static getSchema(): SchemaDefinition {
    return ${methodBody};
  }
}`;
  }

  /**
   * Generate standalone getSchema method
   */
  private generateMethod(schema: SchemaDefinition): string {
    const methodBody = this.generateSchemaObject(schema);

    return `static getSchema(): SchemaDefinition {
  return ${methodBody};
}`;
  }

  /**
   * Generate schema object definition
   */
  private generateSchemaObject(schema: SchemaDefinition): string {
    return `{
    tableName: ${JSON.stringify(schema.tableName)},
    columns: ${this.generateColumns(schema.columns)},
    indexes: ${this.generateIndexes(schema.indexes)},
    triggers: ${this.generateTriggers(schema.triggers)},
    foreignKeys: ${this.generateForeignKeys(schema.foreignKeys)},
    dependencies: ${JSON.stringify(schema.dependencies)},
    version: ${JSON.stringify(schema.version)},
    packageName: ${JSON.stringify(schema.packageName)},
    baseClass: ${JSON.stringify(schema.baseClass)},
  }`;
  }

  /**
   * Generate columns object
   */
  private generateColumns(columns: Record<string, any>): string {
    const entries = Object.entries(columns).map(([name, def]) => {
      const defStr = JSON.stringify(def, null, 6).replace(/^/gm, '      ');
      return `    ${JSON.stringify(name)}: ${defStr}`;
    });

    return `{
${entries.join(',\n')}
  }`;
  }

  /**
   * Generate indexes array
   */
  private generateIndexes(indexes: any[]): string {
    if (indexes.length === 0) return '[]';

    const indexStrings = indexes.map((idx) =>
      JSON.stringify(idx, null, 4).replace(/^/gm, '    '),
    );

    return `[
${indexStrings.join(',\n')}
  ]`;
  }

  /**
   * Generate triggers array
   */
  private generateTriggers(triggers: any[]): string {
    if (triggers.length === 0) return '[]';

    const triggerStrings = triggers.map((trigger) =>
      JSON.stringify(trigger, null, 4).replace(/^/gm, '    '),
    );

    return `[
${triggerStrings.join(',\n')}
  ]`;
  }

  /**
   * Generate foreign keys array
   */
  private generateForeignKeys(foreignKeys: any[]): string {
    if (foreignKeys.length === 0) return '[]';

    const fkStrings = foreignKeys.map((fk) =>
      JSON.stringify(fk, null, 4).replace(/^/gm, '    '),
    );

    return `[
${fkStrings.join(',\n')}
  ]`;
  }

  /**
   * Generate TypeScript type definition file
   */
  generateTypeDefinitions(schemas: Record<string, SchemaDefinition>): string {
    const imports = `import type { SchemaDefinition } from '@smrt/core/schema';`;

    const interfaces = Object.keys(schemas)
      .map(
        (className) =>
          `export interface ${className}Schema {
  getSchema(): SchemaDefinition;
}`,
      )
      .join('\n\n');

    return `${imports}\n\n${interfaces}`;
  }

  /**
   * Generate schema manifest file
   */
  generateManifest(
    packageName: string,
    schemas: Record<string, SchemaDefinition>,
  ): string {
    const manifest = {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName,
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([className, schema]) => [
          className,
          {
            tableName: schema.tableName,
            version: schema.version,
            dependencies: schema.dependencies,
            packageName: schema.packageName,
          },
        ]),
      ),
      dependencies: Array.from(
        new Set(Object.values(schemas).flatMap((s) => s.dependencies)),
      ),
    };

    return `export default ${JSON.stringify(manifest, null, 2)};`;
  }
}
