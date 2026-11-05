import { SmrtCollection } from '@happyvertical/smrt-core';
import { NotificationOptOut } from '../models/NotificationOptOut.js';

export class NotificationOptOutCollection extends SmrtCollection<NotificationOptOut> {
  static readonly _itemClass = NotificationOptOut;
}
