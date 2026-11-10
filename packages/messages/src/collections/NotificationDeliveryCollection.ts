import { SmrtCollection } from '@happyvertical/smrt-core';
import { NotificationDelivery } from '../models/NotificationDelivery.js';

export class NotificationDeliveryCollection extends SmrtCollection<NotificationDelivery> {
  static readonly _itemClass = NotificationDelivery;
}
