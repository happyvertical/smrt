import fs from 'node:fs';

const registryPath = 'packages/core/src/registry.ts';
const schemaOutputPath = 'packages/core/src/registry/schema-builder.ts';

const registryContent = fs.readFileSync(registryPath, 'utf8');
const lines = registryContent.split('\n');
const getLines = (start, end) => lines.slice(start - 1, end).join('\n');

// 1303 is "  /**" before getSchema
// 1943 is "    }" after mapFieldTypeToSQL
const originalSchemaBlock = getLines(1303, 1943);

const schemaModuleBody = originalSchemaBlock
  .replace(
    /private static mapFieldTypeToSQL/g,
    'export function mapFieldTypeToSQL',
  )
  .replace(/private static fieldsToColumns/g, 'export function fieldsToColumns')
  .replace(
    /private static formatDefaultValue/g,
    'export function formatDefaultValue',
  )
  .replace(
    /private static generateDDLFromColumns/g,
    'export function generateDDLFromColumns',
  )
  .replace(/static getSchema\(/g, 'export function getSchema(')
  .replace(/static getSchemaDDL\(/g, 'export function getSchemaDDL(')
  .replace(/static getTableName\(/g, 'export function getTableName(')
  .replace(/static getAllSchemas\(/g, 'export function getAllSchemas(')
  .replace(
    /static getAllSchemasAsDefinitions\(/g,
    'export function getAllSchemasAsDefinitions(',
  )

  // Fix internals to use exported functions or ObjectRegistry
  .replace(/ObjectRegistry\.getSchema\(/g, 'getSchema(')
  .replace(/ObjectRegistry\.getTableName\(/g, 'getTableName(')
  .replace(/ObjectRegistry\.mapFieldTypeToSQL\(/g, 'mapFieldTypeToSQL(')
  .replace(/ObjectRegistry\.getSTIBase\(/g, 'ObjectRegistry.getSTIBase(')
  .replace(
    /ObjectRegistry\.getTableStrategy\(/g,
    'ObjectRegistry.getTableStrategy(',
  )
  .replace(
    /ObjectRegistry\.collectionTableNames\(\)/g,
    'getCollectionTableNames()',
  )
  .replace(
    /ObjectRegistry\.collectionTableNames\.get/g,
    'getCollectionTableNames().get',
  )
  .replace(/ObjectRegistry\.classes/g, 'getClasses()')
  .replace(/ObjectRegistry\.fieldsToColumns\(/g, 'fieldsToColumns(')
  .replace(/ObjectRegistry\.formatDefaultValue\(/g, 'formatDefaultValue(')
  .replace(
    /ObjectRegistry\.generateDDLFromColumns\(/g,
    'generateDDLFromColumns(',
  )
  .replace(/ObjectRegistry\.findClass\(/g, 'findClass(');

const schemaModuleContent = `/**
 * Schema building logic for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ObjectRegistry } from '../registry';
import { getClasses, getCollectionTableNames } from './shared-state';
import { findClass } from './name-resolver';
import { toSnakeCase, classnameToTablename } from '../utils';
import type { 
  FieldDefinition,
} from '../scanner/types.js';
import type { 
  SchemaDefinition, 
  ColumnDefinition, 
  IndexDefinition,
  SQLDataType
} from '../schema/types.js';

${schemaModuleBody}
`;

fs.writeFileSync(schemaOutputPath, schemaModuleContent);
console.log('Successfully created schema-builder.ts');

// Delegates
const delegates = `  /**
   * Get cached schema definition for a registered class
   */
  static getSchema(name: string): SchemaDefinition | undefined {
    return _getSchema(name);
  }

  /**
   * Get SQL DDL statement for a registered class
   */
  static getSchemaDDL(name: string): string | undefined {
    return _getSchemaDDL(name);
  }

  /**
   * Get table name for a registered class
   */
  static getTableName(name: string): string | undefined {
    return _getTableName(name);
  }

  /**
   * Get all pre-generated schemas for passing to database adapters
   */
  static getAllSchemas(): Record<
    string,
    { tableName: string; ddl: string; indexes?: string[] }
  > {
    return _getAllSchemas();
  }

  /**
   * Get all registered schemas as SchemaDefinition objects
   */
  static getAllSchemasAsDefinitions(): Record<string, SchemaDefinition> {
    return _getAllSchemasAsDefinitions();
  }

  /**
   * Generate DDL CREATE TABLE statement from columns
   */
  private static generateDDLFromColumns(
    tableName: string,
    columns: Record<string, ColumnDefinition>,
    isSTI = false,
  ): string {
    return _generateDDLFromColumns(tableName, columns, isSTI);
  }

  /**
   * Format default value for SQL DDL
   */
  private static formatDefaultValue(value: any, type: string): string {
    return _formatDefaultValue(value, type);
  }

  /**
   * Convert a Map of field definitions to column definitions
   */
  private static fieldsToColumns(
    fields: Map<string, FieldDefinition>,
  ): Record<string, ColumnDefinition> {
    return _fieldsToColumns(fields);
  }

  /**
   * Map field type to SQL data type
   */
  private static mapFieldTypeToSQL(
    fieldType: FieldDefinition['type'],
  ): SQLDataType {
    return _mapFieldTypeToSQL(fieldType);
  }`;

let newRegistryContent = registryContent.replace(
  originalSchemaBlock,
  delegates,
);

const imports = `import {
  getSchema as _getSchema,
  getSchemaDDL as _getSchemaDDL,
  getTableName as _getTableName,
  getAllSchemas as _getAllSchemas,
  getAllSchemasAsDefinitions as _getAllSchemasAsDefinitions,
  generateDDLFromColumns as _generateDDLFromColumns,
  formatDefaultValue as _formatDefaultValue,
  fieldsToColumns as _fieldsToColumns,
  mapFieldTypeToSQL as _mapFieldTypeToSQL,
} from './registry/schema-builder';\n`;

newRegistryContent = newRegistryContent.replace(
  'import {\n  register as _register,',
  `${imports}import {\n  register as _register,`,
);

fs.writeFileSync(registryPath, newRegistryContent);
console.log('Successfully updated registry.ts');
