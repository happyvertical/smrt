import { SmrtCollection } from '@happyvertical/smrt-core';
import { OidcProfileEmailReservation } from '../models/OidcProfileEmailReservation';

/** Internal collection for canonical OIDC email reservations. */
export class OidcProfileEmailReservationCollection extends SmrtCollection<OidcProfileEmailReservation> {
  static readonly _itemClass = OidcProfileEmailReservation;
}
