/**
 * JSON Database Validator
 *
 * Validates JSON database files against SMRT manifest schema
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { getPackageConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import fg from 'fast-glob';
import type { DEFAULT_CLI_CONFIG } from '../config.js';
import {
  type ObjectValidationResult,
  ValidationCodes,
  type ValidationIssue,
  type ValidationResults,
  type ValidationSummary,
} from './validation-types.js';

interface ValidatorOptions {
  dataPath: string;
  quickMode: boolean;
  verbose: boolean;
}

/**
 * Resolve data path from explicit argument, config, or common locations.
 *
 * Resolution order:
 * 1. Explicit --data argument if provided
 * 2. Database URL from smrt.config.js (if it looks like a directory path)
 * 3. Common data directory patterns: ./data, ./db, ./.data, ./json-db
 *
 * @param explicitPath - Optional explicit path from --data CLI argument
 * @returns Resolved absolute path to data directory, or null if:
 *   - Explicit path was provided but doesn't exist
 *   - No data directory could be auto-detected
 *   - Auto-detected directories contain no JSON files
 */
export async function resolveDataPath(
  explicitPath?: string,
): Promise<string | null> {
  // 1. Use explicit --data argument if provided
  if (explicitPath) {
    const resolved = resolve(process.cwd(), explicitPath);
    if (!existsSync(resolved)) {
      return null;
    }
    return resolved;
  }

  // 2. Check smrt.config for database URL that might point to a directory
  try {
    const { DEFAULT_CLI_CONFIG: defaultConfig } = await import('../config.js');
    const config = getPackageConfig<typeof DEFAULT_CLI_CONFIG>(
      'cli',
      defaultConfig,
    );

    // If database URL looks like a directory path (not :memory: or .db file)
    if (config.database?.url) {
      const dbUrl = config.database.url;
      if (
        !dbUrl.includes(':memory:') &&
        !dbUrl.endsWith('.db') &&
        !dbUrl.endsWith('.sqlite')
      ) {
        const configPath = resolve(process.cwd(), dbUrl);
        if (existsSync(configPath)) {
          // Check if it's a directory with JSON files
          const hasJsonFiles = await fg('*.json', { cwd: configPath });
          if (hasJsonFiles.length > 0) {
            return configPath;
          }
        }
      }
    }
  } catch {
    // Config not available, continue to fallback
  }

  // 3. Check for common data directory patterns
  const commonPaths = ['./data', './db', './.data', './json-db'];
  for (const path of commonPaths) {
    const resolved = resolve(process.cwd(), path);
    if (existsSync(resolved)) {
      const hasJsonFiles = await fg('*.json', { cwd: resolved });
      if (hasJsonFiles.length > 0) {
        return resolved;
      }
    }
  }

  return null;
}

/**
 * Discover JSON files in the data directory
 */
export async function discoverJsonFiles(dataPath: string): Promise<string[]> {
  return fg('*.json', {
    cwd: dataPath,
    absolute: true,
    ignore: ['*.schema.json', 'package.json', 'tsconfig.json', 'manifest.json'],
  });
}

/**
 * Infer table name from JSON filename
 * e.g., "events.json" → "events", "my_data.json" → "my_data"
 *
 * Note: Table names are converted to lowercase for case-insensitive matching.
 */
function inferTableName(fileName: string): string {
  return fileName.replace(/\.json$/, '').toLowerCase();
}

/**
 * Common irregular plural mappings for table name to class name matching.
 * Add entries here for domain-specific irregular plurals.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  mice: 'mouse',
  geese: 'goose',
  teeth: 'tooth',
  feet: 'foot',
  data: 'datum',
  media: 'medium',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  analyses: 'analysis',
  indices: 'index',
  matrices: 'matrix',
  vertices: 'vertex',
};

/**
 * Convert a plural table name to its singular form for class name matching.
 *
 * @remarks
 * Uses a simple heuristic: checks irregular plurals first, then removes trailing 's'.
 * This handles common cases but may not work for all irregular plurals.
 * For domain-specific irregular plurals, add them to IRREGULAR_PLURALS.
 */
function toSingular(tableName: string): string {
  const lower = tableName.toLowerCase();

  // Check irregular plurals first
  if (IRREGULAR_PLURALS[lower]) {
    return IRREGULAR_PLURALS[lower];
  }

  // Simple heuristic: remove trailing 's'
  return tableName.replace(/s$/, '');
}

/**
 * Find the SMRT object type for a given table name.
 *
 * Matching order:
 * 1. Exact table name match from ObjectRegistry
 * 2. Class name matching singular form of table name (handles "events" → "Event")
 */
function findObjectTypeForTable(tableName: string): string | null {
  const allClasses = ObjectRegistry.getAllClasses();

  // First, try exact table name match
  for (const [className] of allClasses) {
    const registeredTableName = ObjectRegistry.getTableName(className);
    if (registeredTableName === tableName) {
      return className;
    }
  }

  // Try singular form (e.g., "event" for "events" table, "person" for "people" table)
  const singular = toSingular(tableName);
  for (const [className] of allClasses) {
    if (className.toLowerCase() === singular) {
      return className;
    }
  }

  return null;
}

/**
 * JSON Database Validator class.
 *
 * Validates JSON database files against SMRT manifest schema, checking:
 * - JSON structure (valid JSON, root is array)
 * - Required fields (id, slug for sluggable objects)
 * - Field types (string, integer, decimal, boolean, datetime, json)
 * - STI discriminator validation (_meta_type exists and is registered)
 * - Uniqueness within file (no duplicate IDs, no duplicate slug+context)
 * - Constraint validation (min/max, minLength/maxLength)
 * - Foreign key references (full mode only)
 *
 * @remarks
 * **Memory considerations**: All JSON files are loaded into memory for
 * cross-file validation (FK checks). For very large datasets (>1GB total),
 * consider using quick mode (--quick) which skips FK validation and
 * processes files independently.
 *
 * **Auto-fixable validation codes**:
 * - `MISSING_REQUIRED_FIELD`: Can be fixed if the field has a default value
 *   defined in the manifest. Other codes require manual intervention.
 *
 * @example
 * ```typescript
 * const validator = new JsonDatabaseValidator({
 *   dataPath: './data',
 *   quickMode: false,
 *   verbose: true
 * });
 *
 * const results = await validator.validate(jsonFiles);
 * const summary = validator.generateSummary(results, duration);
 * ```
 */
export class JsonDatabaseValidator {
  private dataPath: string;
  private quickMode: boolean;
  private verbose: boolean;
  private loadedData = new Map<string, unknown[]>();

  constructor(options: ValidatorOptions) {
    this.dataPath = options.dataPath;
    this.quickMode = options.quickMode;
    this.verbose = options.verbose;
  }

  /**
   * Run validation on all discovered JSON files
   */
  async validate(jsonFiles: string[]): Promise<ValidationResults> {
    const results: ObjectValidationResult[] = [];
    const fixableIssues: ValidationIssue[] = [];

    // Load all files first (needed for FK validation in full mode)
    await this.loadAllFiles(jsonFiles);

    // Validate each file
    for (const filePath of jsonFiles) {
      const result = await this.validateFile(filePath);
      results.push(result);

      // Collect fixable issues
      for (const issue of result.issues) {
        if (issue.fixable) {
          fixableIssues.push(issue);
        }
      }
    }

    // Cross-file validation (if not quick mode)
    if (!this.quickMode) {
      await this.validateForeignKeys(results);
    }

    return { objectResults: results, fixableIssues };
  }

  /**
   * Load all JSON files into memory for cross-file validation (FK checks).
   *
   * @remarks
   * Files that fail to load are silently skipped here but will produce
   * validation errors when validateFile() is called. In verbose mode,
   * load failures are logged for debugging.
   */
  private async loadAllFiles(jsonFiles: string[]): Promise<void> {
    for (const filePath of jsonFiles) {
      const fileName = basename(filePath, '.json');
      const tableName = inferTableName(fileName);

      try {
        const content = await readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          this.loadedData.set(tableName, data);
        }
      } catch (error) {
        // Will be caught during validation, but log in verbose mode for debugging
        if (this.verbose) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(
            `  [verbose] Failed to pre-load ${filePath}: ${errorMessage}`,
          );
        }
      }
    }
  }

  /**
   * Validate a single JSON file
   */
  private async validateFile(
    filePath: string,
  ): Promise<ObjectValidationResult> {
    const issues: ValidationIssue[] = [];
    const fileName = basename(filePath, '.json');
    const tableName = inferTableName(fileName);

    // Get manifest metadata for this table
    const objectType = findObjectTypeForTable(tableName);
    const fields = objectType
      ? ObjectRegistry.getFields(objectType)
      : new Map<string, unknown>();

    // Load and validate JSON structure
    let records: unknown[];
    try {
      const content = await readFile(filePath, 'utf-8');
      records = JSON.parse(content);
    } catch (error) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.INVALID_JSON,
        message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        file: filePath,
      });
      return this.createResult(objectType, tableName, filePath, 0, issues, 0);
    }

    // Validate root is array
    if (!Array.isArray(records)) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.NOT_ARRAY,
        message: 'Root element must be an array',
        file: filePath,
      });
      return this.createResult(objectType, tableName, filePath, 0, issues, 0);
    }

    // Warn if table not found in registry
    if (!objectType) {
      issues.push({
        severity: 'warning',
        code: ValidationCodes.UNKNOWN_TABLE,
        message: `No SMRT object found for table '${tableName}' - skipping field validation`,
        file: filePath,
      });
    }

    // Validate each record
    const seenIds = new Set<string>();
    const seenSlugContext = new Set<string>();
    let validCount = 0;

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      if (typeof record !== 'object' || record === null) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.EMPTY_OBJECT,
          message: `Record at index ${i} is not an object`,
          file: filePath,
          objectId: `[index:${i}]`,
        });
        continue;
      }

      const recordIssues = this.validateRecord(
        record as Record<string, unknown>,
        fields,
        objectType,
        filePath,
        i,
        seenIds,
        seenSlugContext,
      );

      if (recordIssues.length === 0) {
        validCount++;
      }
      issues.push(...recordIssues);
    }

    return this.createResult(
      objectType,
      tableName,
      filePath,
      records.length,
      issues,
      validCount,
    );
  }

  /**
   * Validate a single record
   */
  private validateRecord(
    record: Record<string, unknown>,
    fields: Map<string, unknown>,
    objectType: string | null,
    filePath: string,
    index: number,
    seenIds: Set<string>,
    seenSlugContext: Set<string>,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const objectId = (record.id as string) || `[index:${index}]`;

    // Check ID
    if (!record.id) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.MISSING_ID,
        message: `Record at index ${index} missing required 'id' field`,
        file: filePath,
        objectId: `[index:${index}]`,
      });
    } else if (typeof record.id !== 'string') {
      issues.push({
        severity: 'error',
        code: ValidationCodes.INVALID_ID_FORMAT,
        message: `Record ID must be a string, got ${typeof record.id}`,
        file: filePath,
        objectId: String(record.id),
      });
    } else if (seenIds.has(record.id)) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.DUPLICATE_ID,
        message: `Duplicate ID: ${record.id}`,
        file: filePath,
        objectId: record.id,
      });
    } else {
      seenIds.add(record.id);
    }

    // Check slug uniqueness (with context)
    if (record.slug) {
      const context = (record.context as string) || '';
      const slugKey = `${record.slug}:${context}`;
      if (seenSlugContext.has(slugKey)) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.DUPLICATE_SLUG_CONTEXT,
          message: `Duplicate slug+context: '${record.slug}' in context '${context}'`,
          file: filePath,
          objectId,
        });
      } else {
        seenSlugContext.add(slugKey);
      }
    }

    // Check STI fields if object type is known
    if (objectType) {
      const tableStrategy = ObjectRegistry.getTableStrategy(objectType);
      if (tableStrategy === 'sti') {
        issues.push(
          ...this.validateSTIFields(record, objectType, filePath, objectId),
        );
      }
    }

    // Validate each field against manifest
    for (const [fieldName, fieldDef] of fields) {
      issues.push(
        ...this.validateField(
          record,
          fieldName,
          fieldDef as Record<string, unknown>,
          filePath,
          objectId,
        ),
      );
    }

    return issues;
  }

  /**
   * Validate STI-specific fields
   */
  private validateSTIFields(
    record: Record<string, unknown>,
    objectType: string,
    filePath: string,
    objectId: string,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Check _meta_type
    if (!record._meta_type) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.MISSING_META_TYPE,
        message: 'STI record missing _meta_type discriminator',
        file: filePath,
        objectId,
        objectType,
        field: '_meta_type',
      });
    } else if (typeof record._meta_type !== 'string') {
      issues.push({
        severity: 'error',
        code: ValidationCodes.INVALID_TYPE,
        message: `_meta_type must be a string, got ${typeof record._meta_type}`,
        file: filePath,
        objectId,
        objectType,
        field: '_meta_type',
      });
    } else {
      // Verify _meta_type is a registered class
      const allClasses = ObjectRegistry.getAllClasses();
      if (!allClasses.has(record._meta_type)) {
        issues.push({
          severity: 'warning',
          code: ValidationCodes.UNKNOWN_META_TYPE,
          message: `Unknown _meta_type: '${record._meta_type}' (may be from unloaded package)`,
          file: filePath,
          objectId,
          objectType,
          field: '_meta_type',
          actual: record._meta_type,
        });
      }
    }

    // Validate _meta_data if present
    if (record._meta_data !== undefined && record._meta_data !== null) {
      if (
        typeof record._meta_data !== 'object' ||
        Array.isArray(record._meta_data)
      ) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.INVALID_META_DATA,
          message: '_meta_data must be an object',
          file: filePath,
          objectId,
          objectType,
          field: '_meta_data',
          expected: 'object',
          actual: typeof record._meta_data,
        });
      }
    }

    return issues;
  }

  /**
   * Validate a single field against its definition.
   *
   * @remarks
   * Null handling varies by field type:
   * - Required fields: null triggers MISSING_REQUIRED_FIELD error
   * - JSON type: null is valid (it's a valid JSON value)
   * - Other types: null is treated as "no value" and skips validation
   */
  private validateField(
    record: Record<string, unknown>,
    fieldName: string,
    fieldDef: Record<string, unknown>,
    filePath: string,
    objectId: string,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const value = record[fieldName];
    const fieldType = fieldDef.type as string;

    // Check required fields
    if (fieldDef.required && (value === undefined || value === null)) {
      issues.push({
        severity: 'error',
        code: ValidationCodes.MISSING_REQUIRED_FIELD,
        message: `Missing required field: ${fieldName}`,
        file: filePath,
        objectId,
        field: fieldName,
        fixable: fieldDef.default !== undefined,
      });
      return issues;
    }

    // Skip validation if value is undefined (and not required)
    if (value === undefined) {
      return issues;
    }

    // For JSON type, null is a valid JSON value - don't skip
    // For other types, null means "no value" - skip validation
    if (value === null && fieldType !== 'json') {
      return issues;
    }

    // Type validation
    const typeIssue = this.validateFieldType(
      value,
      fieldType,
      fieldName,
      objectId,
      filePath,
    );
    if (typeIssue) {
      issues.push(typeIssue);
    }

    // Constraint validation (skip for null values)
    if (value !== null) {
      issues.push(
        ...this.validateConstraints(
          value,
          fieldDef,
          fieldName,
          objectId,
          filePath,
        ),
      );
    }

    return issues;
  }

  /**
   * Validate field type
   */
  private validateFieldType(
    value: unknown,
    expectedType: string,
    fieldName: string,
    objectId: string,
    filePath: string,
  ): ValidationIssue | null {
    switch (expectedType) {
      case 'text':
        if (typeof value !== 'string') {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_TYPE,
            message: `Field '${fieldName}' expected string, got ${typeof value}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'string',
            actual: typeof value,
          };
        }
        break;

      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_INTEGER,
            message: `Field '${fieldName}' expected integer, got ${typeof value}${typeof value === 'number' ? ' (decimal)' : ''}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'integer',
            actual: value,
          };
        }
        break;

      case 'decimal':
        if (typeof value !== 'number') {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_NUMBER,
            message: `Field '${fieldName}' expected number, got ${typeof value}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'number',
            actual: typeof value,
          };
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_BOOLEAN,
            message: `Field '${fieldName}' expected boolean, got ${typeof value}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'boolean',
            actual: typeof value,
          };
        }
        break;

      case 'datetime': {
        const dateValue = typeof value === 'string' ? new Date(value) : value;
        if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_DATE,
            message: `Field '${fieldName}' contains invalid date: ${String(value)}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'ISO 8601 date string',
            actual: value,
          };
        }
        break;
      }

      case 'json':
        // null is a valid JSON value (handled explicitly)
        // typeof null === 'object', so this check passes for null
        // Arrays are also valid (Array.isArray returns true for arrays)
        if (value !== null && typeof value !== 'object') {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_JSON_FIELD,
            message: `Field '${fieldName}' expected JSON value (object, array, or null), got ${typeof value}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'object, array, or null',
            actual: typeof value,
          };
        }
        break;

      case 'foreignKey':
        // Foreign keys should be strings (UUIDs)
        if (typeof value !== 'string') {
          return {
            severity: 'error',
            code: ValidationCodes.INVALID_TYPE,
            message: `Field '${fieldName}' (foreign key) expected string, got ${typeof value}`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: 'string',
            actual: typeof value,
          };
        }
        break;
    }

    return null;
  }

  /**
   * Validate field constraints
   */
  private validateConstraints(
    value: unknown,
    fieldDef: Record<string, unknown>,
    fieldName: string,
    objectId: string,
    filePath: string,
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Numeric constraints
    if (typeof value === 'number') {
      if (fieldDef.min !== undefined && value < (fieldDef.min as number)) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.VALUE_OUT_OF_RANGE,
          message: `Field '${fieldName}' value ${value} is below minimum ${fieldDef.min}`,
          file: filePath,
          objectId,
          field: fieldName,
          expected: `>= ${fieldDef.min}`,
          actual: value,
        });
      }
      if (fieldDef.max !== undefined && value > (fieldDef.max as number)) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.VALUE_OUT_OF_RANGE,
          message: `Field '${fieldName}' value ${value} is above maximum ${fieldDef.max}`,
          file: filePath,
          objectId,
          field: fieldName,
          expected: `<= ${fieldDef.max}`,
          actual: value,
        });
      }
    }

    // String constraints
    if (typeof value === 'string') {
      if (
        fieldDef.minLength !== undefined &&
        value.length < (fieldDef.minLength as number)
      ) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.STRING_TOO_SHORT,
          message: `Field '${fieldName}' length ${value.length} is below minimum ${fieldDef.minLength}`,
          file: filePath,
          objectId,
          field: fieldName,
          expected: `length >= ${fieldDef.minLength}`,
          actual: value.length,
        });
      }
      if (
        fieldDef.maxLength !== undefined &&
        value.length > (fieldDef.maxLength as number)
      ) {
        issues.push({
          severity: 'error',
          code: ValidationCodes.STRING_TOO_LONG,
          message: `Field '${fieldName}' length ${value.length} is above maximum ${fieldDef.maxLength}`,
          file: filePath,
          objectId,
          field: fieldName,
          expected: `length <= ${fieldDef.maxLength}`,
          actual: value.length,
        });
      }
      if (fieldDef.pattern) {
        const regex = new RegExp(fieldDef.pattern as string);
        if (!regex.test(value)) {
          issues.push({
            severity: 'error',
            code: ValidationCodes.PATTERN_MISMATCH,
            message: `Field '${fieldName}' does not match required pattern`,
            file: filePath,
            objectId,
            field: fieldName,
            expected: fieldDef.pattern,
            actual: value,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate foreign key references across files (full mode only).
   *
   * @remarks
   * Uses Set-based lookup for target IDs (O(1) per lookup instead of O(n)),
   * optimizing validation from O(n*m*k) to O(n*k + m) where:
   * - n = number of records with FK fields
   * - m = number of target records
   * - k = number of FK fields per record
   *
   * Note: This method mutates the results to add FK validation issues.
   * The validCount/invalidCount are updated to reflect records that
   * failed FK validation (a record is counted as invalid if it has
   * any FK errors).
   */
  private async validateForeignKeys(
    results: ObjectValidationResult[],
  ): Promise<void> {
    // Build ID lookup Sets for all loaded tables (optimization: O(m) once, O(1) per lookup)
    const tableIdSets = new Map<string, Set<string>>();
    for (const [tableName, records] of this.loadedData) {
      const idSet = new Set<string>();
      for (const record of records) {
        const id = (record as Record<string, unknown>).id;
        if (typeof id === 'string') {
          idSet.add(id);
        }
      }
      tableIdSets.set(tableName, idSet);
    }

    for (const result of results) {
      if (!result.objectType) continue;

      const fields = ObjectRegistry.getFields(result.objectType);
      const fkFields = Array.from(fields.entries()).filter(
        ([, def]) => (def as Record<string, unknown>).type === 'foreignKey',
      );

      if (fkFields.length === 0) continue;

      const records = this.loadedData.get(result.tableName) || [];

      // Track which records have FK errors (by ID or index)
      const recordsWithFKErrors = new Set<string>();

      for (const record of records) {
        const rec = record as Record<string, unknown>;
        const recordId = (rec.id as string) || `[unknown]`;

        for (const [fieldName, fieldDef] of fkFields) {
          const fkValue = rec[fieldName];
          if (!fkValue) continue;

          const def = fieldDef as Record<string, unknown>;
          const targetClass = def.related as string;
          if (!targetClass) continue;

          const targetTable = ObjectRegistry.getTableName(targetClass);
          if (!targetTable) {
            result.issues.push({
              severity: 'warning',
              code: ValidationCodes.MISSING_FK_TABLE,
              message: `FK target class '${targetClass}' not registered`,
              file: result.file,
              objectId: recordId,
              field: fieldName,
            });
            continue;
          }

          const targetIdSet = tableIdSets.get(targetTable);

          if (!targetIdSet) {
            result.issues.push({
              severity: 'error',
              code: ValidationCodes.MISSING_FK_TABLE,
              message: `FK reference to missing table file: ${targetTable}.json`,
              file: result.file,
              objectId: recordId,
              field: fieldName,
            });
            recordsWithFKErrors.add(recordId);
            continue;
          }

          // O(1) Set lookup instead of O(n) array.some()
          if (!targetIdSet.has(fkValue as string)) {
            result.issues.push({
              severity: 'error',
              code: ValidationCodes.INVALID_FOREIGN_KEY,
              message: `FK reference to non-existent record: ${fkValue} in ${targetTable}`,
              file: result.file,
              objectId: recordId,
              field: fieldName,
              actual: fkValue,
            });
            recordsWithFKErrors.add(recordId);
          }
        }
      }

      // Update counts: records with FK errors that were previously counted as valid
      // Note: We only adjust if the record was counted as valid in the initial pass
      // (i.e., it had no structural/type errors but has FK errors)
      const newInvalidCount = recordsWithFKErrors.size;
      if (newInvalidCount > 0) {
        // Only count records that weren't already invalid
        const previouslyValid = result.validCount;
        const newlyInvalid = Math.min(newInvalidCount, previouslyValid);
        result.validCount -= newlyInvalid;
        result.invalidCount += newlyInvalid;
      }
    }
  }

  /**
   * Apply fixes to fixable issues.
   *
   * Currently supports auto-fixing:
   * - MISSING_REQUIRED_FIELD: Applies default value from field definition
   *
   * @remarks
   * Records are matched by ID. Records identified by index only (objectId = '[index:N]')
   * require the ID to be present and are matched by array position as a fallback.
   */
  async applyFixes(fixableIssues: ValidationIssue[]): Promise<number> {
    // Group fixes by file
    const fixesByFile = new Map<string, ValidationIssue[]>();
    for (const issue of fixableIssues) {
      if (!issue.file) continue;
      const existing = fixesByFile.get(issue.file) || [];
      existing.push(issue);
      fixesByFile.set(issue.file, existing);
    }

    let fixedCount = 0;

    for (const [filePath, issues] of fixesByFile) {
      try {
        const content = await readFile(filePath, 'utf-8');
        const records = JSON.parse(content) as Record<string, unknown>[];

        for (const issue of issues) {
          if (
            issue.code === ValidationCodes.MISSING_REQUIRED_FIELD &&
            issue.field
          ) {
            // Find the record - by ID or by index if objectId is '[index:N]' format
            let record: Record<string, unknown> | undefined;

            if (issue.objectId?.startsWith('[index:')) {
              // Extract index from '[index:N]' format
              const indexMatch = issue.objectId.match(/\[index:(\d+)\]/);
              if (indexMatch) {
                const index = parseInt(indexMatch[1], 10);
                record = records[index];
              }
            } else {
              // Match by ID
              record = records.find((r) => r.id === issue.objectId);
            }

            if (record && issue.objectType) {
              const fields = ObjectRegistry.getFields(issue.objectType);
              const fieldDef = fields.get(issue.field) as
                | Record<string, unknown>
                | undefined;
              if (fieldDef?.default !== undefined) {
                record[issue.field] = fieldDef.default;
                fixedCount++;
              }
            }
          }
        }

        await writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`);
      } catch (error) {
        // Log in verbose mode for debugging
        if (this.verbose) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(
            `  [verbose] Failed to apply fixes to ${filePath}: ${errorMessage}`,
          );
        }
      }
    }

    return fixedCount;
  }

  /**
   * Generate validation summary
   */
  generateSummary(
    results: ValidationResults,
    duration: number,
    manifestPath: string | null = null,
  ): ValidationSummary {
    let totalRecords = 0;
    let validRecords = 0;
    let invalidRecords = 0;
    let errors = 0;
    let warnings = 0;
    let info = 0;

    for (const result of results.objectResults) {
      totalRecords += result.recordCount;
      validRecords += result.validCount;
      invalidRecords += result.invalidCount;

      for (const issue of result.issues) {
        if (issue.severity === 'error') errors++;
        else if (issue.severity === 'warning') warnings++;
        else info++;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      dataPath: this.dataPath,
      manifestPath,
      duration,
      totalFiles: results.objectResults.length,
      totalRecords,
      validRecords,
      invalidRecords,
      issues: { errors, warnings, info },
      objectResults: results.objectResults,
    };
  }

  /**
   * Create an ObjectValidationResult
   */
  private createResult(
    objectType: string | null,
    tableName: string,
    file: string,
    recordCount: number,
    issues: ValidationIssue[],
    validCount: number,
  ): ObjectValidationResult {
    return {
      objectType,
      tableName,
      file,
      recordCount,
      validCount,
      invalidCount: recordCount - validCount,
      issues,
    };
  }
}

/**
 * Display validation results in human-readable format
 */
export function displayValidationResults(
  summary: ValidationSummary,
  verbose: boolean,
): void {
  console.log('\n🔍 SMRT Database Validation Report\n');
  console.log(`  Data path: ${summary.dataPath}`);
  if (summary.manifestPath) {
    console.log(`  Manifest:  ${summary.manifestPath}`);
  }
  console.log(`  Duration:  ${summary.duration}ms\n`);

  console.log('━'.repeat(60));
  console.log('\n📊 Summary\n');
  console.log(`  Files validated:    ${summary.totalFiles}`);
  console.log(`  Total records:      ${summary.totalRecords}`);
  console.log(`  Valid records:      ${summary.validRecords}`);
  console.log(`  Invalid records:    ${summary.invalidRecords}`);
  console.log();
  console.log(`  ❌ Errors:   ${summary.issues.errors}`);
  console.log(`  ⚠️  Warnings: ${summary.issues.warnings}`);
  console.log(`  ℹ️  Info:     ${summary.issues.info}`);
  console.log();

  if (summary.issues.errors === 0 && summary.issues.warnings === 0) {
    console.log('✅ All validations passed!\n');
    return;
  }

  console.log('━'.repeat(60));
  console.log('\n🔧 Issues by Object Type\n');

  for (const result of summary.objectResults) {
    if (result.issues.length === 0) continue;

    console.log(`  ${result.objectType || result.tableName}`);
    console.log(`    File: ${result.file}`);
    console.log(
      `    Records: ${result.recordCount} (${result.validCount} valid, ${result.invalidCount} invalid)`,
    );

    // Group issues by severity
    const errors = result.issues.filter((i) => i.severity === 'error');
    const warnings = result.issues.filter((i) => i.severity === 'warning');

    if (errors.length > 0) {
      console.log(`\n    ❌ Errors (${errors.length}):`);
      const displayErrors = verbose ? errors : errors.slice(0, 5);
      for (const issue of displayErrors) {
        console.log(`       [${issue.code}] ${issue.message}`);
        if (issue.objectId && issue.objectId !== '[index:0]') {
          console.log(`         Record: ${issue.objectId}`);
        }
      }
      if (!verbose && errors.length > 5) {
        console.log(`       ... and ${errors.length - 5} more errors`);
      }
    }

    if (warnings.length > 0) {
      console.log(`\n    ⚠️  Warnings (${warnings.length}):`);
      const displayWarnings = verbose ? warnings : warnings.slice(0, 3);
      for (const issue of displayWarnings) {
        console.log(`       [${issue.code}] ${issue.message}`);
      }
      if (!verbose && warnings.length > 3) {
        console.log(`       ... and ${warnings.length - 3} more warnings`);
      }
    }

    console.log();
  }

  console.log('━'.repeat(60));
  console.log('\n💡 Next steps:\n');
  console.log('  - Run with --verbose for detailed issue information');
  console.log('  - Run with --fix to auto-correct fixable issues');
  console.log('  - Run with --json for CI-friendly output\n');
}
