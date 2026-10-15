/**
 * Regression gate: across every published SMRT package, no collection class
 * publishes a generated write its model closes.
 *
 * Each package is imported the way a consumer imports it (its inline manifest
 * registers its classes), then MCP tools are generated for it and its CLI CRUD
 * commands are read from the registry config the CLI generator gates on. For
 * every collection class over a model the assertions are:
 *
 * - MCP and CLI CRUD writes are a subset of the model's;
 * - a sensitive model's collection publishes no MCP write;
 * - over a model whose MCP surface is an include list, `false`, or sensitive,
 *   a collection publishes a custom-method tool only when its own include
 *   list names it;
 * - over a model whose `api` is an include list or `false`, a collection gets
 *   a generated REST route (`resolveApiActionSet`, the set both SvelteKit
 *   route emitters read) only for a method its own `api` include names.
 *
 * `INVENTORY` is the list of collections that published writes or custom
 * methods their model closed before this gate existed; each must still be
 * found and checked, so a rename cannot silently drop one from coverage.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exposedCrudVerbs,
  ObjectRegistry,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators';
import { resolveApiActionSet } from '@happyvertical/smrt-core/vite-plugin';
import { beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '../../..');
const WRITES = ['create', 'update', 'delete'];
const CRUD = ['list', 'get', ...WRITES];
const COLLECTION_BASES = new Set([
  'SmrtCollection',
  'SmrtJunction',
  'SmrtJunctionBase',
  'SmrtReportCollection',
]);

/**
 * Inventory entries that are not registered resources at all: a collection
 * whose base class lives in another package is not scanned into its own
 * package's manifest, so no transport generates anything for it.
 */
const NOT_REGISTERED = new Set([
  '@happyvertical/smrt-manufacturing:AssemblyCollection',
]);

const INVENTORY: Record<string, string[]> = {
  ads: [
    'AdDeliveryTierCollection',
    'AdEventCollection',
    'AdFormatCollection',
    'AdGroupCollection',
    'AdVariationCollection',
  ],
  agents: [
    'AgentConfigCollection',
    'AgentScheduleCollection',
    'TenantAgentCollection',
  ],
  analytics: [
    'AnalyticsDataStreamCollection',
    'AnalyticsEventCollection',
    'AnalyticsPropertyCollection',
    'AnalyticsReportCollection',
  ],
  assets: [
    'AssetMetafieldCollection',
    'AssetStatusCollection',
    'AssetTypeCollection',
    'AssetCollection',
    'FolderCollection',
  ],
  chat: [
    'AgentSessionCollection',
    'ChatMessageCollection',
    'ChatParticipantCollection',
    'ChatReactionCollection',
    'ChatRoomCollection',
    'ChatThreadCollection',
    'VoiceGatewayTurnCollection',
    'VoiceSessionCollection',
  ],
  comments: ['CommentCollection'],
  commerce: [
    'ContractCollection',
    'ContractLineItemCollection',
    'DocumentTaxCollection',
    'FulfillmentCollection',
    'FulfillmentLineItemCollection',
    'InvoiceLineItemCollection',
    'PaymentAllocationCollection',
    'PaymentCollection',
    'PaymentInstrumentCollection',
    'PaymentIntentCollection',
    'PayoutCollection',
    'TaxCodeCollection',
    'TaxComponentCollection',
    'TaxSettingsCollection',
    'TaxSummaryReportCollection',
    'VendorCollection',
  ],
  content: [
    'ContentCorrectionCollection',
    'ContentReviewCollection',
    'ContentVersionCollection',
  ],
  events: ['EventCollection', 'EventSeriesCollection', 'EventTypeCollection'],
  facts: [
    'FactEvidenceCollection',
    'FactSourceCollection',
    'FactSubjectCollection',
    'FactTagCollection',
    'FactCollection',
  ],
  images: ['ImageCollection'],
  inventory: [
    'InventoryLocationCollection',
    'StockLevelCollection',
    'StockMovementCollection',
  ],
  jobs: ['SmrtJobEventCollection', 'SmrtJobCollection'],
  languages: ['LanguageOverrideCollection'],
  ledgers: ['AccountCollection', 'JournalEntryCollection', 'JournalCollection'],
  manufacturing: [
    'AssemblyCollection',
    'BillOfMaterialsCollection',
    'BomLineCollection',
    'OperationCollection',
    'ProductionRunCollection',
    'ProductionRunCompletionCollection',
    'RoutingStepCollection',
  ],
  marketing: [
    'CampaignChannelCollection',
    'CampaignCollection',
    'CampaignMetricSnapshotCollection',
  ],
  messages: [
    'AccountCollection',
    'AttachmentCollection',
    'EmailAccountCollection',
    'EmailCollection',
    'EmailFolderCollection',
    'MessageCollection',
    'MessagingEndpointCollection',
    'PersonaMessageRouteCollection',
  ],
  personas: [
    'AgentPersonaCollection',
    'DirectiveProposalCollection',
    'FeedbackCollection',
  ],
  places: ['PlaceCollection', 'PlaceTypeCollection'],
  playbooks: ['PlaybookOverrideCollection'],
  preferences: ['UiPreferenceRecordCollection'],
  products: ['MaterialCollection', 'ProductVariantCollection', 'SkuCollection'],
  profiles: [
    'ApiKeyCollection',
    'MagicLinkTokenCollection',
    'NostrIdentityCollection',
    'OidcIdentityCollection',
    'ProfileCollection',
    'ProfileMetadataCollection',
    'ProfileMetafieldCollection',
    'ProfileRelationshipCollection',
    'ProfileRelationshipTermCollection',
    'ProfileRelationshipTypeCollection',
    'ProfileTypeCollection',
  ],
  projects: [
    'CommentCollection',
    'IssueCollection',
    'ProjectIntegrationCollection',
    'ProjectCollection',
    'PullRequestCollection',
    'RepositoryCollection',
  ],
  properties: ['PropertyCollection', 'ZoneCollection'],
  reports: ['RuntimeReportCollection'],
  sales: [
    'ExecutedAgreementCollection',
    'CommissionAdjustmentCollection',
    'CommissionCollection',
    'CommissionPayoutCollection',
    'CommissionPlanCollection',
    'EarnerCollection',
    'EarnerSourceAttributionCollection',
    'EarningEventCollection',
    'LeadCollection',
    'OpportunityCollection',
    'OpportunityConversionCollection',
    'PipelineDefinitionCollection',
    'PipelineStageCollection',
    'SalesActivityCollection',
    'SalesRepresentativeCollection',
    'AttributionExceptionCollection',
    'AttributionPolicyCollection',
    'ReferralAgreementCollection',
    'ReferralCollection',
    'ReferralLinkCollection',
    'ReferralProgramCollection',
    'ReferralTermSnapshotCollection',
    'ReferralTouchCollection',
    'ReferrerCollection',
  ],
  secrets: [
    'SecretAuditLogCollection',
    'SecretCollection',
    'TenantKeyCollection',
  ],
  sites: ['SiteAgentBindingCollection', 'SiteCollection'],
  social: [
    'SocialAccountCollection',
    'SocialPostAnalyticsSnapshotCollection',
    'SocialPostCollection',
  ],
  subscriptions: [
    'SubscriptionPlanCollection',
    'TenantSubscriptionCollection',
    'TenantUsageMetricCollection',
    'ClientChargeCollection',
    'BillingAdjustmentCollection',
    'RetailChargeCollection',
    'CreditGrantCollection',
  ],
  support: [
    'ServiceTimeEntryCollection',
    'SupportAiRunCollection',
    'SupportCaseEventCollection',
    'SupportCaseCollection',
    'SupportChannelBindingCollection',
    'SupportCompensationPlanCollection',
    'SupportInteractionCollection',
    'SupportPlanCollection',
    'SupportPolicyCollection',
    'SupportServiceTargetCollection',
    'SupportEscalationCollection',
    'SupportChargeCollection',
    'SupportCompensationCollection',
    'SupportSpecialistCollection',
    'SupportQualificationCollection',
    'SupportAvailabilityCollection',
    'SupportWorkLinkCollection',
  ],
  tags: ['TagAliasCollection', 'TagCollection'],
  timesheets: [
    'AttendanceCorrectionCollection',
    'AttendancePunchCollection',
    'AttendanceBreakCollection',
    'AttendanceSegmentCollection',
    'AttendanceReplayCollection',
    'PeriodTimecardCollection',
    'TimecardAdjustmentCollection',
    'TimecardReopeningCollection',
  ],
  users: [
    'AccessRequestCollection',
    'UsersCliAuthRequestCollection',
    'GroupCollection',
    'GroupMemberCollection',
    'GroupRoleCollection',
    'UsersMagicLinkTokenCollection',
    'MembershipCollection',
    'MembershipOverrideCollection',
    'UsersOAuthClientCollection',
    'UsersOAuthAuthorizationCodeCollection',
    'UsersOAuthRefreshGrantCollection',
    'UsersOAuthAccessTokenRevocationCollection',
    'UsersOAuthAuthorizationCollection',
    'UsersOAuthRefreshFamilyCollection',
    'PermissionCollection',
    'ResourceGrantCollection',
    'RoleCollection',
    'RolePermissionCollection',
    'SessionCollection',
    'TenantCollection',
    'TenantIntegrationCollection',
    'TenantPermissionOverrideCollection',
    'UserCollection',
  ],
  video: [
    'CharacterCollection',
    'VideoCompositionCollection',
    'VideoSequenceCollection',
    'VideoShotCharacterCollection',
    'VideoShotCollection',
  ],
};

const SENSITIVE = [
  'profiles:ApiKeyCollection',
  'profiles:MagicLinkTokenCollection',
  'profiles:NostrIdentityCollection',
  'secrets:SecretCollection',
  'secrets:TenantKeyCollection',
  'timesheets:AttendanceCorrectionCollection',
  'timesheets:AttendanceReplayCollection',
  'timesheets:PeriodTimecardCollection',
  'timesheets:TimecardAdjustmentCollection',
  'timesheets:TimecardReopeningCollection',
  'users:UsersCliAuthRequestCollection',
  'users:UsersMagicLinkTokenCollection',
  'users:UsersOAuthClientCollection',
  'users:UsersOAuthAuthorizationCodeCollection',
  'users:UsersOAuthRefreshGrantCollection',
  'users:UsersOAuthAccessTokenRevocationCollection',
  'users:UsersOAuthAuthorizationCollection',
  'users:UsersOAuthRefreshFamilyCollection',
  'users:SessionCollection',
];

interface ManifestObject {
  className: string;
  qualifiedName: string;
  extends?: string;
  extendsTypeArg?: string;
}

interface CollectionSurface {
  key: string;
  item: string;
  mcpActions: string[];
  cliWrites: string[];
  restActions: string[];
}

const packageNames = Object.keys(
  JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'))
    .devDependencies as Record<string, string>,
).filter((name) => name.startsWith('@happyvertical/smrt-'));

function readManifest(packageName: string) {
  const dir = packageName.replace('@happyvertical/smrt-', '');
  // Svelte-packaged libraries publish their manifest under `dist/lib/`.
  for (const relative of ['dist/manifest.json', 'dist/lib/manifest.json']) {
    try {
      return JSON.parse(
        readFileSync(path.join(packagesDir, dir, relative), 'utf8'),
      ) as { objects: Record<string, ManifestObject> };
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/** The model a collection class pages over, from its declared generic. */
function collectionItem(
  objects: Record<string, ManifestObject>,
  def: ManifestObject,
): string | undefined {
  const packagePrefix = def.qualifiedName.slice(
    0,
    def.qualifiedName.lastIndexOf(':') + 1,
  );
  let current: ManifestObject | undefined = def;
  let isCollection = false;
  const seen = new Set<string>();
  let typeArg: string | undefined;
  while (current) {
    typeArg ??= current.extendsTypeArg;
    const parent: string | undefined = current.extends;
    if (!parent || seen.has(parent)) break;
    if (COLLECTION_BASES.has(parent)) {
      isCollection = true;
      break;
    }
    seen.add(parent);
    current = objects[`${packagePrefix}${parent}`];
  }
  if (!isCollection) return undefined;
  // The same order the registry resolves it in: the class's own generic, then
  // its `FooCollection` -> `Foo` name, then an inherited generic.
  const candidates = [
    def.extendsTypeArg,
    def.className.endsWith('Collection')
      ? def.className.slice(0, -'Collection'.length)
      : undefined,
    typeArg,
  ];
  for (const candidate of candidates) {
    if (candidate && objects[`${packagePrefix}${candidate}`]) {
      return `${packagePrefix}${candidate}`;
    }
  }
  return undefined;
}

/** CRUD verbs a surface config opens, as plain strings. */
function crudVerbs(value: unknown): string[] {
  return exposedCrudVerbs(value);
}

function includeList(value: unknown): string[] | undefined {
  return value && typeof value === 'object'
    ? ((value as { include?: string[] }).include ?? undefined)
    : undefined;
}

const surfaces = new Map<string, CollectionSurface>();

describe('collection classes never publish more than their model', () => {
  beforeAll(async () => {
    for (const packageName of packageNames) {
      const manifest = readManifest(packageName);
      try {
        await import(/* @vite-ignore */ packageName);
      } catch {
        // A package whose entry needs a bundler (Svelte components) still
        // registers its classes from its published manifest.
        if (manifest) {
          ObjectRegistry.registerPackageManifest(
            structuredClone(manifest) as unknown as SmartObjectManifest,
          );
        }
      }
    }
    for (const packageName of packageNames) {
      const manifest = readManifest(packageName);
      if (!manifest) continue;
      const classNames = Object.keys(manifest.objects).filter((key) =>
        ObjectRegistry.getAllClasses().has(key),
      );
      if (classNames.length === 0) continue;
      const generator = new MCPGenerator({ classNames });
      const actions = new Map<string, string[]>();
      for (const tool of await generator.generateTools()) {
        const identity = generator.getToolIdentity(tool);
        const key = identity.qualifiedName ?? identity.objectName;
        actions.set(key, [...(actions.get(key) ?? []), identity.action]);
      }
      for (const [key, def] of Object.entries(manifest.objects)) {
        const item = collectionItem(manifest.objects, def);
        if (!item) continue;
        // Routes are emitted from the manifest; give the definition the
        // effective runtime surface, so a manifest built before inheritance
        // existed is held to the same rule.
        const restDef = {
          ...def,
          decoratorConfig: {
            ...((def as { decoratorConfig?: object }).decoratorConfig ?? {}),
            api: ObjectRegistry.getConfig(key).api,
          },
        } as unknown as Parameters<typeof resolveApiActionSet>[0];
        surfaces.set(key, {
          restActions: [
            ...resolveApiActionSet(
              restDef,
              manifest as unknown as SmartObjectManifest,
            ),
          ],
          key,
          item,
          mcpActions: actions.get(key) ?? [],
          cliWrites: exposedCrudVerbs(ObjectRegistry.getConfig(key).cli).filter(
            (verb) => WRITES.includes(verb),
          ),
        });
      }
    }
  }, 240_000);

  it('found the collections it checks', () => {
    expect(surfaces.size).toBeGreaterThan(200);
  });

  it('opens no MCP or CLI CRUD write the model keeps closed', () => {
    const escalations: string[] = [];
    for (const surface of surfaces.values()) {
      const model = ObjectRegistry.getConfig(surface.item);
      const modelMcp = model.abstract ? [] : crudVerbs(model.mcp);
      const modelCli = model.abstract ? [] : crudVerbs(model.cli);
      for (const verb of WRITES) {
        if (surface.mcpActions.includes(verb) && !modelMcp.includes(verb)) {
          escalations.push(`${surface.key} mcp ${verb}`);
        }
        if (surface.cliWrites.includes(verb) && !modelCli.includes(verb)) {
          escalations.push(`${surface.key} cli ${verb}`);
        }
      }
    }
    expect(escalations).toEqual([]);
  });

  it('publishes no MCP write and no undeclared MCP method on a sensitive or narrowed model', () => {
    const leaks: string[] = [];
    for (const surface of surfaces.values()) {
      const model = ObjectRegistry.getConfig(surface.item);
      const narrowed =
        model.sensitive === true ||
        model.mcp === false ||
        includeList(model.mcp) !== undefined;
      if (!narrowed) continue;
      if (model.sensitive === true) {
        for (const verb of WRITES) {
          if (surface.mcpActions.includes(verb)) {
            leaks.push(`${surface.key} ${verb} (sensitive model)`);
          }
        }
      }
      const declared = (
        includeList(ObjectRegistry.getConfig(surface.key).mcp) ?? []
      ).map((name) => name.toLowerCase());
      for (const action of surface.mcpActions) {
        if (CRUD.includes(action)) continue;
        if (!declared.includes(action.toLowerCase())) {
          leaks.push(`${surface.key} ${action}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('generates no REST route for a collection method a narrowed model closes', () => {
    const leaks: string[] = [];
    for (const surface of surfaces.values()) {
      const model = ObjectRegistry.getConfig(surface.item);
      if (model.api !== false && includeList(model.api) === undefined) {
        continue;
      }
      const own = ObjectRegistry.getConfig(surface.key).api;
      const declared = own === false ? [] : (includeList(own) ?? []);
      for (const action of surface.restActions) {
        if (!declared.includes(action)) leaks.push(`${surface.key} ${action}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('covers every collection from the exposure inventory', () => {
    const missing: string[] = [];
    for (const [dir, classNames] of Object.entries(INVENTORY)) {
      for (const className of classNames) {
        const key = `@happyvertical/smrt-${dir}:${className}`;
        if (NOT_REGISTERED.has(key)) {
          expect(ObjectRegistry.getAllClasses().has(key), key).toBe(false);
          continue;
        }
        if (!surfaces.has(key)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives each sensitive collection from the inventory no write and no method on MCP or CLI', () => {
    for (const entry of SENSITIVE) {
      const [dir, className] = entry.split(':');
      const surface = surfaces.get(`@happyvertical/smrt-${dir}:${className}`);
      expect(surface, entry).toBeDefined();
      expect(
        surface?.mcpActions.filter(
          (action) => !['list', 'get'].includes(action),
        ),
        entry,
      ).toEqual([]);
      const model = ObjectRegistry.getConfig(surface?.item ?? '');
      const modelCli = crudVerbs(model.cli);
      expect(
        surface?.cliWrites.filter((verb) => !modelCli.includes(verb)),
        entry,
      ).toEqual([]);
    }
  });
});
