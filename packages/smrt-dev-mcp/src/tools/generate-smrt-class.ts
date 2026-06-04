/**
 * Generate SMRT Class Tool
 * Creates a package-ready SMRT class using current object-package patterns.
 */

type PropertyType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json';
type BaseClass = 'SmrtObject' | 'SmrtCollection';
type TemplateVariant =
  | 'basic'
  | 'global-catalog'
  | 'optional-catalog'
  | 'tenant-project-object'
  | 'tenant-event-log-object'
  | 'cross-package-reference';
type RelationshipType =
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

interface PropertyDefinition {
  name: string;
  type: PropertyType;
  required?: boolean;
  nullable?: boolean;
  description?: string;
  defaultValue?: unknown;
}

interface RelationshipDefinition {
  name: string;
  type: RelationshipType;
  related: string;
  required?: boolean;
  nullable?: boolean;
  description?: string;
  validate?: boolean;
  foreignKey?: string;
  through?: string;
  sourceKey?: string;
  targetKey?: string;
}

interface TenantScopedDefinition {
  mode?: 'required' | 'optional';
  field?: string;
  autoFilter?: boolean;
  autoPopulate?: boolean;
  allowSuperAdminBypass?: boolean;
}

interface GenerateSmrtClassArgs {
  className: string;
  properties: PropertyDefinition[];
  baseClass?: BaseClass;
  template?: TemplateVariant;
  tableName?: string;
  conflictColumns?: string[];
  tenantScoped?: boolean | TenantScopedDefinition;
  includeTenantIdField?: boolean;
  relationships?: RelationshipDefinition[];
  includeApiConfig?: boolean;
  includeMcpConfig?: boolean;
  includeCliConfig?: boolean;
  includeCompanionSnippets?: boolean;
}

interface NormalizedGenerateSmrtClassArgs {
  className: string;
  properties: PropertyDefinition[];
  baseClass: BaseClass;
  template: TemplateVariant;
  tableName?: string;
  conflictColumns: string[];
  tenantScoped?: TenantScopedDefinition;
  includeTenantIdField: boolean;
  relationships: RelationshipDefinition[];
  includeApiConfig: boolean;
  includeMcpConfig: boolean;
  includeCliConfig: boolean;
  includeCompanionSnippets: boolean;
}

const TYPE_MAPPING: Record<
  PropertyType,
  { tsType: string; defaultValue: string }
> = {
  text: { tsType: 'string', defaultValue: "''" },
  integer: { tsType: 'number', defaultValue: '0' },
  decimal: { tsType: 'number', defaultValue: '0.0' },
  boolean: { tsType: 'boolean', defaultValue: 'false' },
  datetime: { tsType: 'Date', defaultValue: 'new Date()' },
  json: { tsType: 'any', defaultValue: '{}' },
};

export async function generateSmrtClass(
  args: GenerateSmrtClassArgs,
): Promise<string> {
  const normalized = normalizeArgs(args);
  const {
    className,
    properties,
    relationships,
    baseClass,
    tableName,
    conflictColumns,
    tenantScoped,
    includeTenantIdField,
    includeApiConfig,
    includeMcpConfig,
    includeCliConfig,
    includeCompanionSnippets,
  } = normalized;

  const coreImports = new Set<string>([baseClass, 'smrt']);
  if (needsFieldDecorator(properties)) coreImports.add('field');
  for (const relationship of relationships) {
    coreImports.add(relationship.type);
  }

  const imports = [
    `import { ${Array.from(coreImports).join(', ')} } from '@happyvertical/smrt-core';`,
  ];

  if (tenantScoped) {
    const tenancyImports = ['TenantScoped'];
    if (includeTenantIdField) tenancyImports.push('tenantId');
    imports.push(
      `import { ${tenancyImports.join(', ')} } from '@happyvertical/smrt-tenancy';`,
    );
  }

  const decoratorLines = [
    ...(tenantScoped
      ? [`@TenantScoped(${renderObjectLiteral({ ...tenantScoped })})`]
      : []),
    renderSmrtDecorator({
      includeApiConfig,
      includeMcpConfig,
      includeCliConfig,
      tableName,
      conflictColumns,
    }),
  ];

  const classMembers = [
    ...(includeTenantIdField && tenantScoped
      ? [renderTenantIdField(tenantScoped)]
      : []),
    ...properties.map(renderProperty),
    ...relationships.map(renderRelationship),
  ].filter(Boolean);

  const companionSnippets = includeCompanionSnippets
    ? `\n${renderCompanionSnippets(className, Boolean(tenantScoped))}`
    : '';

  return `${imports.join('\n')}

${decoratorLines.join('\n')}
export class ${className} extends ${baseClass} {
${classMembers.join('\n\n')}

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }
}
${companionSnippets}`;
}

function normalizeArgs(
  args: GenerateSmrtClassArgs,
): NormalizedGenerateSmrtClassArgs {
  const template = args.template ?? 'basic';
  const templateDefaults = defaultsForTemplate(template);
  const tenantScoped =
    args.tenantScoped === true
      ? (templateDefaults.tenantScoped ?? { mode: 'required' as const })
      : args.tenantScoped === false
        ? undefined
        : (args.tenantScoped ?? templateDefaults.tenantScoped);

  return {
    className: args.className,
    properties: args.properties,
    baseClass: args.baseClass ?? 'SmrtObject',
    template,
    tableName: args.tableName ?? templateDefaults.tableName,
    conflictColumns:
      args.conflictColumns ?? templateDefaults.conflictColumns ?? [],
    tenantScoped: normalizeTenantScoped(tenantScoped),
    includeTenantIdField:
      args.includeTenantIdField ??
      templateDefaults.includeTenantIdField ??
      Boolean(tenantScoped),
    relationships: args.relationships ?? [],
    includeApiConfig: args.includeApiConfig ?? true,
    includeMcpConfig: args.includeMcpConfig ?? true,
    includeCliConfig: args.includeCliConfig ?? true,
    includeCompanionSnippets: args.includeCompanionSnippets ?? false,
  };
}

function defaultsForTemplate(template: TemplateVariant): {
  tableName?: string;
  conflictColumns?: string[];
  tenantScoped?: TenantScopedDefinition;
  includeTenantIdField?: boolean;
} {
  switch (template) {
    case 'optional-catalog':
      return {
        tenantScoped: { mode: 'optional' },
        includeTenantIdField: true,
        conflictColumns: ['tenant_id', 'slug'],
      };
    case 'tenant-project-object':
      return {
        tenantScoped: { mode: 'required' },
        includeTenantIdField: true,
      };
    case 'tenant-event-log-object':
      return {
        tenantScoped: { mode: 'optional' },
        includeTenantIdField: true,
      };
    case 'global-catalog':
      return { conflictColumns: ['slug'] };
    case 'cross-package-reference':
    case 'basic':
      return {};
  }
}

function normalizeTenantScoped(
  value: boolean | TenantScopedDefinition | undefined,
): TenantScopedDefinition | undefined {
  if (!value) return undefined;
  return {
    mode: typeof value === 'object' ? (value.mode ?? 'required') : 'required',
    field: typeof value === 'object' ? (value.field ?? 'tenantId') : 'tenantId',
    autoFilter: typeof value === 'object' ? value.autoFilter : undefined,
    autoPopulate: typeof value === 'object' ? value.autoPopulate : undefined,
    allowSuperAdminBypass:
      typeof value === 'object' ? value.allowSuperAdminBypass : undefined,
  };
}

function renderSmrtDecorator(options: {
  includeApiConfig: boolean;
  includeMcpConfig: boolean;
  includeCliConfig: boolean;
  tableName?: string;
  conflictColumns: string[];
}): string {
  const decoratorConfig: Record<string, unknown> = {};

  if (options.tableName) {
    decoratorConfig.tableName = options.tableName;
  }

  if (options.conflictColumns.length > 0) {
    decoratorConfig.conflictColumns = options.conflictColumns;
  }

  if (options.includeApiConfig) {
    decoratorConfig.api = {
      include: ['list', 'get', 'create', 'update'],
      exclude: ['delete'],
    };
  }

  if (options.includeMcpConfig) {
    decoratorConfig.mcp = {
      include: ['list', 'get'],
    };
  }

  if (options.includeCliConfig) {
    decoratorConfig.cli = true;
  }

  return Object.keys(decoratorConfig).length > 0
    ? `@smrt(${JSON.stringify(decoratorConfig, null, 2)})`
    : '@smrt()';
}

function renderTenantIdField(tenantScoped: TenantScopedDefinition): string {
  const nullable = tenantScoped.mode === 'optional';
  const field = tenantScoped.field ?? 'tenantId';
  return nullable
    ? `  @tenantId({ nullable: true })\n  ${field}: string | null = null;`
    : `  @tenantId()\n  ${field}: string = '';`;
}

function renderProperty(prop: PropertyDefinition): string {
  const mapping = TYPE_MAPPING[prop.type];
  const nullable = prop.nullable === true;
  const tsType = nullable ? `${mapping.tsType} | null` : mapping.tsType;
  const defaultValue =
    prop.defaultValue !== undefined
      ? renderLiteral(prop.defaultValue)
      : nullable
        ? 'null'
        : mapping.defaultValue;
  const fieldOptions = compactObject({
    required: prop.required,
    nullable: prop.nullable,
    description: prop.description,
  });
  const jsdoc = prop.description ? `  /** ${prop.description} */\n` : '';
  const decorator =
    Object.keys(fieldOptions).length > 0
      ? `  @field(${JSON.stringify(fieldOptions)})\n`
      : '';

  return `${jsdoc}${decorator}  ${prop.name}: ${tsType} = ${defaultValue};`;
}

function renderRelationship(relationship: RelationshipDefinition): string {
  const options = compactObject({
    required: relationship.required,
    nullable: relationship.nullable,
    description: relationship.description,
    validate: relationship.validate,
    foreignKey: relationship.foreignKey,
    through: relationship.through,
    sourceKey: relationship.sourceKey,
    targetKey: relationship.targetKey,
  });
  const args = [
    renderLiteral(relationship.related),
    ...(Object.keys(options).length > 0 ? [JSON.stringify(options)] : []),
  ];
  const decorator = `@${relationship.type}(${args.join(', ')})`;
  const fieldType =
    relationship.type === 'oneToMany' || relationship.type === 'manyToMany'
      ? 'unknown[]'
      : relationship.nullable
        ? 'string | null'
        : 'string';
  const defaultValue =
    relationship.type === 'oneToMany' || relationship.type === 'manyToMany'
      ? '[]'
      : relationship.nullable
        ? 'null'
        : "''";

  return `  ${decorator}\n  ${relationship.name}: ${fieldType} = ${defaultValue};`;
}

function needsFieldDecorator(properties: PropertyDefinition[]): boolean {
  return properties.some(
    (property) =>
      property.required !== undefined ||
      property.nullable !== undefined ||
      property.description !== undefined,
  );
}

function renderCompanionSnippets(
  className: string,
  usesTenantScoped: boolean,
): string {
  const dependencyNote = usesTenantScoped
    ? `\n * - Ensure package.json declares "@happyvertical/smrt-tenancy".`
    : '';
  return `/*
 * Package wiring:
 * - Export ${className} from the package entrypoint used by consumers.
 * - Import this module from any package registration file that eagerly loads objects.${dependencyNote}
 */`;
}

function renderObjectLiteral(value: Record<string, unknown>): string {
  return JSON.stringify(compactObject(value), null, 2);
}

function renderLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) return 'null';
  return JSON.stringify(value, null, 2);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
