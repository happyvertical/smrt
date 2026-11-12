/**
 * Consumer model for the #4922 gate: an app `Attachment` with the same name
 * as smrt-messages' own-table `Attachment`, which it extends. It makes the
 * inherited `filename` required and adds `virusScanned`; the parent's other
 * fields (`contentType`, `size`, ...) are not restated. The spec scans this
 * file with the real OXC scanner to produce the app's `.smrt/manifest.json`;
 * the app model itself is registered from that manifest (server.ts).
 */
import { field, SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { Attachment as MessagesAttachment } from '@happyvertical/smrt-messages';

@smrt()
export class Attachment extends MessagesAttachment {
  @field({ required: true }) override filename: string = '';
  @field() virusScanned: boolean = false;
}

export class AttachmentCollection extends SmrtCollection<Attachment> {
  static readonly _itemClass = Attachment;
}
