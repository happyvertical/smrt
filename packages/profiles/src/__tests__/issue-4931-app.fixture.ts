import { smrt } from '@happyvertical/smrt-core';
import { ApiKey as SmrtApiKey } from '../models/ApiKey.js';
import { AuditLog as SmrtAuditLog } from '../models/AuditLog.js';
import { MagicLinkToken as SmrtMagicLinkToken } from '../models/MagicLinkToken.js';
import { NostrIdentity as SmrtNostrIdentity } from '../models/NostrIdentity.js';
import { OidcIdentity as SmrtOidcIdentity } from '../models/OidcIdentity.js';
import { OidcProfileEmailReservation as SmrtOidcProfileEmailReservation } from '../models/OidcProfileEmailReservation.js';
import { ProfileType as SmrtProfileType } from '../models/ProfileType.js';
import { Person as SmrtPerson } from '../models/ProfileTypes.js';

// Register only after the framework models and a registry snapshot are loaded.
export function registerAppModels(): {
  ProfileType: typeof SmrtProfileType;
  ApiKey: typeof SmrtApiKey;
  AuditLog: typeof SmrtAuditLog;
  MagicLinkToken: typeof SmrtMagicLinkToken;
  NostrIdentity: typeof SmrtNostrIdentity;
  OidcIdentity: typeof SmrtOidcIdentity;
  OidcProfileEmailReservation: typeof SmrtOidcProfileEmailReservation;
  Person: typeof SmrtPerson;
} {
  class ApiKey extends SmrtApiKey {}
  smrt({ packageName: '@local/issue-4931-profiles' })(ApiKey);
  class AuditLog extends SmrtAuditLog {}
  smrt({ packageName: '@local/issue-4931-profiles' })(AuditLog);
  class MagicLinkToken extends SmrtMagicLinkToken {}
  smrt({ packageName: '@local/issue-4931-profiles' })(MagicLinkToken);
  class NostrIdentity extends SmrtNostrIdentity {}
  smrt({ packageName: '@local/issue-4931-profiles' })(NostrIdentity);
  class OidcIdentity extends SmrtOidcIdentity {}
  smrt({ packageName: '@local/issue-4931-profiles' })(OidcIdentity);
  class OidcProfileEmailReservation extends SmrtOidcProfileEmailReservation {}
  smrt({ packageName: '@local/issue-4931-profiles' })(
    OidcProfileEmailReservation,
  );
  class Person extends SmrtPerson {}
  smrt({ packageName: '@local/issue-4931-profiles' })(Person);
  class ProfileType extends SmrtProfileType {}
  smrt({ packageName: '@local/issue-4931-profiles' })(ProfileType);
  return {
    ProfileType,
    ApiKey,
    AuditLog,
    MagicLinkToken,
    NostrIdentity,
    OidcIdentity,
    OidcProfileEmailReservation,
    Person,
  };
}
