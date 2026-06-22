/**
 * SvelteKit-specific type definitions for session management
 * @packageDocumentation
 */

import type { Membership } from '../models/Membership.js';
import type { User } from '../models/User.js';

/**
 * Extended locals interface for SvelteKit
 *
 * Add to your app.d.ts:
 * ```typescript
 * declare global {
 *   namespace App {
 *     interface Locals extends SessionLocals {}
 *   }
 * }
 * ```
 */
export interface SessionLocals {
  /** The authenticated user (null if not authenticated) */
  user: User | null;
  /** Active membership for the current tenant (null if none) */
  membership?: Membership | null;
  /** User's resolved permissions */
  permissions: string[];
  /** Current tenant context (null if no tenant selected) */
  tenantId: string | null;
  /** Session ID (null if no session) */
  sessionId: string | null;
}

/**
 * Default session locals values
 */
export const defaultSessionLocals: SessionLocals = {
  user: null,
  membership: null,
  permissions: [],
  tenantId: null,
  sessionId: null,
};
