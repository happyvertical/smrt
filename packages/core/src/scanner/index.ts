/**
 * Manifest generation for SMRT objects
 *
 * Note: AST scanning is now handled by @happyvertical/smrt-scanner package
 * which uses OXC (Rust-based parser) for 2-3x faster performance.
 *
 * For scanning capabilities, import from '@happyvertical/smrt-scanner':
 *   import { OxcScanner, ManifestAdapter } from '@happyvertical/smrt-scanner';
 */

export { generateManifest, ManifestGenerator } from './manifest-generator';
export type {
  AgentAdminRouteManifest,
  AgentComponentDeclaration,
  AgentFeature,
  AgentManifest,
  AgentMenuItem,
  AgentPermission,
  AgentUISlotManifest,
  FieldDefinition,
  MethodDefinition,
  ScanOptions,
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
} from './types';
