/**
 * @have/types - Shared type definitions for the HAVE SDK
 *
 * This package provides shared TypeScript type definitions and interfaces
 * used across multiple HAVE SDK packages to prevent circular dependencies.
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
  ModuleComponentType,
  ModuleUIBaseProps,
  ModuleUIRegistryInterface,
  ModuleUISlot,
  SmrtModuleMeta,
} from './module.js';
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
