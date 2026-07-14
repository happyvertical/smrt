import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

export interface OidcProfileEmailReservationOptions extends SmrtObjectOptions {
  emailKey?: string;
  profileId?: string;
}

/** Private database arbiter for canonical OIDC email provisioning races. */
@smrt({
  tableName: 'oidc_profile_email_reservations',
  api: false,
  mcp: false,
  cli: false,
})
export class OidcProfileEmailReservation extends SmrtObject {
  @foreignKey('Profile', { required: true, unique: true })
  profileId?: string;

  @field({ type: 'text', required: true, unique: true, readonly: true })
  emailKey: string = '';

  constructor(options: OidcProfileEmailReservationOptions = {}) {
    super(options);
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.emailKey !== undefined) this.emailKey = options.emailKey;
  }
}
