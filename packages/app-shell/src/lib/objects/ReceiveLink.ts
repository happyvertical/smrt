import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * A scoped, single-use link token the verified owner minted so the CLI can hand
 * a desktop app to `POST /api/shell/app/receive` (#5638). Only the SHA-256 of
 * the token's secret is stored; the token itself is shown once, at minting.
 * Written only by `receive-link.ts`; no generated surface.
 */
@smrt({
  tableName: 'receive_links',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
  tenantScoped: { mode: 'optional' },
})
export class ReceiveLink extends SmrtObject {
  /** The owner who minted it; the receive runs as them if they still own the tenant. */
  @field({ type: 'text', required: true, requiredFor: 'authentication' })
  ownerId: string = '';

  /** The one action it permits (`app.receive`). */
  @field({ type: 'text', required: true, requiredFor: 'authentication' })
  scope: string = '';

  /** Hex SHA-256 of the token's secret. */
  @field({ type: 'text', required: true, requiredFor: 'authentication' })
  tokenHash: string = '';

  /** ISO time after which it is dead. */
  @field({ type: 'text', required: true, requiredFor: 'authentication' })
  expiresAt: string = '';

  /** ISO time it was spent or revoked; empty while it can still be used. */
  @field({ type: 'text' })
  usedAt: string = '';
}
export class ReceiveLinkCollection extends SmrtCollection<ReceiveLink> {
  static readonly _itemClass = ReceiveLink;
}
