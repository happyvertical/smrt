/**
 * Schema override system for SMRT objects
 * Allows packages and applications to extend base schemas
 */

import { createHash } from 'crypto';
import type {
  ColumnDefinition,
  SchemaDefinition,
  SchemaOverride,
} from './types';

export class SchemaOverrideSystem {
  /**
   * Apply schema override to base schema
   */
  static applyOverride(
    baseSchema: SchemaDefinition,
    override: SchemaOverride,
  ): SchemaDefinition {
    const overriddenSchema: SchemaDefinition = {
      ...baseSchema,
      version: SchemaOverrideSystem.generateOverrideVersion(
        baseSchema,
        override,
      ),
      packageName: override.packageName,
    };

    // Apply column additions
    if (override.addColumns) {
      overriddenSchema.columns = {
        ...overriddenSchema.columns,
        ...override.addColumns,
      };
    }

    // Apply column removals
    if (override.removeColumns) {
      for (const columnName of override.removeColumns) {
        delete overriddenSchema.columns[columnName];
      }
    }

    // Apply index additions
    if (override.addIndexes) {
      overriddenSchema.indexes = [
        ...overriddenSchema.indexes,
        ...override.addIndexes,
      ];
    }

    // Apply index removals
    if (override.removeIndexes) {
      overriddenSchema.indexes = overriddenSchema.indexes.filter(
        (index) => !override.removeIndexes!.includes(index.name),
      );
    }

    // Apply trigger additions
    if (override.addTriggers) {
      overriddenSchema.triggers = [
        ...overriddenSchema.triggers,
        ...override.addTriggers,
      ];
    }

    // Apply trigger removals
    if (override.removeTriggers) {
      overriddenSchema.triggers = overriddenSchema.triggers.filter(
        (trigger) => !override.removeTriggers!.includes(trigger.name),
      );
    }

    // Update foreign keys and dependencies
    overriddenSchema.foreignKeys = SchemaOverrideSystem.extractForeignKeys(
      overriddenSchema.columns,
    );
    overriddenSchema.dependencies =
      SchemaOverrideSystem.extractDependencies(overriddenSchema);

    return overriddenSchema;
  }

  /**
   * Create a schema override for extending a base schema
   */
  static createOverride(
    tableName: string,
    packageName: string,
    extensions: {
      addColumns?: Record<string, ColumnDefinition>;
      removeColumns?: string[];
      addIndexes?: Array<any>;
      removeIndexes?: string[];
      addTriggers?: Array<any>;
      removeTriggers?: string[];
    },
  ): SchemaOverride {
    return {
      tableName,
      packageName,
      ...extensions,
    };
  }

  /**
   * Merge multiple schema overrides
   */
  static mergeOverrides(
    baseSchema: SchemaDefinition,
    overrides: SchemaOverride[],
  ): SchemaDefinition {
    let currentSchema = baseSchema;

    for (const override of overrides) {
      if (override.tableName === baseSchema.tableName) {
        currentSchema = SchemaOverrideSystem.applyOverride(
          currentSchema,
          override,
        );
      }
    }

    return currentSchema;
  }

  /**
   * Create praeco-specific content schema override
   */
  static createPraecoContentOverride(): SchemaOverride {
    return SchemaOverrideSystem.createOverride('contents', 'praeco', {
      addColumns: {
        council_id: {
          type: 'TEXT',
          foreignKey: {
            table: 'councils',
            column: 'id',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          description: 'Reference to council this content belongs to',
        },
        meeting_id: {
          type: 'TEXT',
          foreignKey: {
            table: 'meetings',
            column: 'id',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          description: 'Reference to meeting this content relates to',
        },
        content_type: {
          type: 'TEXT',
          notNull: true,
          defaultValue: "'document'",
          description: 'Type of content: document, agenda, minutes, etc.',
        },
        source_url: {
          type: 'TEXT',
          description: 'Original URL where content was found',
        },
        extraction_metadata: {
          type: 'JSON',
          description: 'Metadata about content extraction process',
        },
        analysis_results: {
          type: 'JSON',
          description: 'AI analysis results for content',
        },
        priority_score: {
          type: 'INTEGER',
          defaultValue: '0',
          description: 'Priority score for content processing',
        },
      },
      addIndexes: [
        {
          name: 'idx_contents_council_id',
          columns: ['council_id'],
          description: 'Index for council-based content queries',
        },
        {
          name: 'idx_contents_meeting_id',
          columns: ['meeting_id'],
          description: 'Index for meeting-based content queries',
        },
        {
          name: 'idx_contents_type_priority',
          columns: ['content_type', 'priority_score'],
          description: 'Compound index for content type and priority queries',
        },
      ],
    });
  }

  /**
   * Create praeco-specific meeting schema override
   */
  static createPraecoMeetingOverride(): SchemaOverride {
    return SchemaOverrideSystem.createOverride('meetings', 'praeco', {
      addColumns: {
        agenda_url: {
          type: 'TEXT',
          description: 'URL to meeting agenda document',
        },
        minutes_url: {
          type: 'TEXT',
          description: 'URL to meeting minutes document',
        },
        video_url: {
          type: 'TEXT',
          description: 'URL to meeting video recording',
        },
        meeting_status: {
          type: 'TEXT',
          notNull: true,
          defaultValue: "'scheduled'",
          description: 'Status: scheduled, in_progress, completed, cancelled',
        },
        ai_summary: {
          type: 'JSON',
          description: 'AI-generated summary of meeting content',
        },
        key_decisions: {
          type: 'JSON',
          description: 'Key decisions made in the meeting',
        },
        action_items: {
          type: 'JSON',
          description: 'Action items from the meeting',
        },
      },
      addIndexes: [
        {
          name: 'idx_meetings_status_date',
          columns: ['meeting_status', 'date'],
          description: 'Index for status and date-based meeting queries',
        },
      ],
    });
  }

  /**
   * Generate version for overridden schema
   */
  private static generateOverrideVersion(
    baseSchema: SchemaDefinition,
    override: SchemaOverride,
  ): string {
    const overrideContent = JSON.stringify({
      baseVersion: baseSchema.version,
      override: {
        addColumns: override.addColumns,
        removeColumns: override.removeColumns,
        addIndexes: override.addIndexes,
        removeIndexes: override.removeIndexes,
        addTriggers: override.addTriggers,
        removeTriggers: override.removeTriggers,
      },
      packageName: override.packageName,
    });

    return createHash('sha256')
      .update(overrideContent)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Extract foreign keys from columns
   */
  private static extractForeignKeys(
    columns: Record<string, ColumnDefinition>,
  ): Array<any> {
    const foreignKeys: Array<any> = [];

    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.foreignKey) {
        foreignKeys.push({
          column: columnName,
          referencesTable: columnDef.foreignKey.table,
          referencesColumn: columnDef.foreignKey.column,
          onDelete: columnDef.foreignKey.onDelete,
          onUpdate: columnDef.foreignKey.onUpdate,
        });
      }
    }

    return foreignKeys;
  }

  /**
   * Extract dependencies from schema
   */
  private static extractDependencies(schema: SchemaDefinition): string[] {
    const dependencies = new Set<string>();

    // Add dependencies from foreign keys
    for (const fk of schema.foreignKeys) {
      dependencies.add(fk.referencesTable);
    }

    return Array.from(dependencies);
  }
}
