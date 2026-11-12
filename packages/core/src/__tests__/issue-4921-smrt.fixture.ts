/** Stands in for a smrt package (#4921). Loaded by issue-4921-same-name-subclass.test.ts. */
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject, smrt } from '../index.js';
import { SmrtJunction } from '../junction.js';

// A smrt class whose subclasses share its table.
@smrt({ packageName: '@happyvertical/smrt-fixture4921', tableStrategy: 'sti' })
export class Shared4921 extends SmrtObject {
  name: string = '';
  @field({ nullable: true }) phone: string | null = null;
}
export class SmrtSharedCollection4921 extends SmrtCollection<Shared4921> {
  static readonly _itemClass = Shared4921;
}

// A smrt class with its own table (the default strategy).
@smrt({ packageName: '@happyvertical/smrt-fixture4921' })
export class Own4921 extends SmrtObject {
  name: string = '';
  @field({ nullable: true }) phone: string | null = null;
}
export class SmrtOwnCollection4921 extends SmrtCollection<Own4921> {
  static readonly _itemClass = Own4921;
}

// A smrt class the app never replaces.
@smrt({ packageName: '@happyvertical/smrt-fixture4921' })
export class Untouched4921 extends SmrtObject {
  name: string = '';
}
export class SmrtUntouchedCollection4921 extends SmrtCollection<Untouched4921> {
  static readonly _itemClass = Untouched4921;
}

// A smrt class whose app-side sibling has the same name but is unrelated.
@smrt({ packageName: '@happyvertical/smrt-fixture4921' })
export class Account4921 extends SmrtObject {
  name: string = '';
}
export class SmrtAccountCollection4921 extends SmrtCollection<Account4921> {
  static readonly _itemClass = Account4921;
}

// A smrt junction model. `setLinks()` batches only models with the base
// lifecycle, so it must judge the class it will actually build.
@smrt({
  packageName: '@happyvertical/smrt-fixture4921',
  conflictColumns: ['owner_id', 'asset_id'],
})
export class Link4921 extends SmrtObject {
  @field({ required: true }) ownerId = '';
  @field({ required: true }) assetId = '';
  @field() sortOrder = 0;
}
export class SmrtLinks4921 extends SmrtJunction<Link4921> {
  static readonly _itemClass = Link4921;
  protected leftField = 'ownerId';
  protected rightField = 'assetId';
}
