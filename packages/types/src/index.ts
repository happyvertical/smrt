/**
 * @happyvertical/smrt-types - Shared type definitions for the SMRT SDK
 *
 * This package provides shared TypeScript type definitions and interfaces
 * used across multiple SMRT SDK packages to prevent circular dependencies.
 */

// Module standardization types
export type {
  AiTokenUsage,
  AiUsageGroupBy,
  AiUsageHandler,
  AiUsageListOptions,
  AiUsageSnapshot,
  AiUsageStats,
  AiUsageSummaryOptions,
  SmrtAiUsageEvent,
  SmrtAiUsageRecord,
} from './ai-usage.js';
export type {
  DomainKnowledgeConfig,
  DomainKnowledgeFreshnessResult,
  DomainKnowledgeManifest,
  DomainKnowledgeObject,
  DomainKnowledgeSurface,
  DomainKnowledgeSurfaceKind,
} from './knowledge.js';
export type {
  ModuleComponentType,
  ModuleUIBaseProps,
  ModuleUIRegistryInterface,
  ModuleUISlot,
  SmrtModuleMeta,
} from './module.js';
export type {
  SmrtRouteDefinition,
  SmrtRouteLoadKind,
  SmrtRouteModule,
  SmrtRouteNavigationItem,
  SmrtRouteNavigationMeta,
} from './routes.js';
export type { Signal, SignalAdapter, SignalType } from './signals.js';

// User status enums (browser-safe, no server dependencies)
export {
  MembershipStatus,
  OverrideEffect,
  SessionStatus,
  TenantPermissionEffect,
  TenantStatus,
  UserStatus,
} from './user.js';
