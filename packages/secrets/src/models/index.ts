/**
 * Secret management models
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

export { Secret, type SecretStatus } from './Secret.js';
export {
  createAuditEntry,
  type SecretAuditAction,
  SecretAuditLog,
  type SecretAuditResult,
} from './SecretAuditLog.js';
export { TenantKey, type TenantKeyStatus } from './TenantKey.js';
