import { SmrtCollection } from '@happyvertical/smrt-core';
import { MessagingEndpoint } from '../models/MessagingEndpoint.js';

export class MessagingEndpointCollection extends SmrtCollection<MessagingEndpoint> {
  static readonly _itemClass = MessagingEndpoint;
}
