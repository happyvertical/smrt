/** Stands in for an app extending the #4921 smrt fixture. Loaded by dynamic import. */
import { SmrtCollection } from '../collection.js';
import { SmrtObject, smrt } from '../index.js';
import {
  Link4921 as SmrtLink,
  Own4921 as SmrtOwn,
  Shared4921 as SmrtShared,
} from './issue-4921-smrt.fixture.js';

// Same simple name as the class it extends: replaces it.
@smrt({ packageName: '@local/app-fixture4921' })
export class Shared4921 extends SmrtShared {
  loyaltyTier: string = 'bronze';
  appOnly() {
    return 'app method ran';
  }
}
export class AppSharedCollection4921 extends SmrtCollection<Shared4921> {
  static readonly _itemClass = Shared4921;
}

@smrt({ packageName: '@local/app-fixture4921' })
export class Own4921 extends SmrtOwn {
  loyaltyTier: string = 'bronze';
  appOnly() {
    return 'app method ran';
  }
}
export class AppOwnCollection4921 extends SmrtCollection<Own4921> {
  static readonly _itemClass = Own4921;
}

// A subclass with a DIFFERENT name: a new kind, not a replacement.
@smrt({ packageName: '@local/app-fixture4921' })
export class VipOwn4921 extends SmrtOwn {
  vip: boolean = true;
}

// Unrelated class that merely shares a simple name with a smrt class.
@smrt({ packageName: '@local/app-fixture4921', tableName: 'app_accounts4921' })
export class Account4921 extends SmrtObject {
  name: string = '';
  appOnly() {
    return 'unrelated app account';
  }
}

/** Counts `initialize()` runs of the app's junction subclass. */
export const linkInitializations = { count: 0 };

// Same-named junction subclass that overrides a lifecycle method.
@smrt({ packageName: '@local/app-fixture4921' })
export class Link4921 extends SmrtLink {
  override async initialize(): Promise<this> {
    linkInitializations.count += 1;
    return super.initialize();
  }
}
