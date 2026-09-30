import { SmrtCollection } from '@happyvertical/smrt-core';
import { UserNotification } from '../models/UserNotification.js';

export class UserNotificationCollection extends SmrtCollection<UserNotification> {
  static readonly _itemClass = UserNotification;
}
