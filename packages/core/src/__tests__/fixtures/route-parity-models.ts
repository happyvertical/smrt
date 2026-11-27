/**
 * The models both transports serve in the route-parity test (#5195).
 *
 * This is source text, not an import: the harness writes it into a temporary
 * project, scans it with the real manifest builder (so the generated routes are
 * emitted from what the scanner read), and loads the same file at run time (so
 * the runtime REST handler serves the classes the decorators registered). One
 * source, two readings of it: neither path can be tested against a model the
 * other does not see.
 */
export const PARITY_MODELS_SOURCE = `import { field, smrt, SmrtCollection, SmrtObject } from '@happyvertical/smrt-core';

/** Private (api.public false): a signed-in caller with the permission. */
@smrt({
  tenantScoped: { mode: 'optional', autoPopulate: false },
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'archive', 'tally', 'touch', 'monthly'],
    writable: ['title'],
    routes: {
      archive: { method: 'POST', scope: 'collection' },
      tally: { method: 'GET', scope: 'collection' },
      touch: { method: 'POST', scope: 'item' },
      monthly: { method: 'GET', scope: 'collection', path: 'reports/monthly' },
    },
  },
})
export class ParityNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  /** Outside \`api.writable\`: a caller may not change it (#5604). */
  @field({ type: 'text' })
  secret = '';

  tenantId: string | null = null;

  /** An item-scope action: only the generated routes serve it. */
  async touch(): Promise<{ touched: boolean }> {
    return { touched: true };
  }
}

export class ParityNoteCollection extends SmrtCollection<ParityNote> {
  static readonly _itemClass = ParityNote;

  async archive(): Promise<{ archived: boolean }> {
    return { archived: true };
  }

  async tally(): Promise<{ count: number }> {
    return { count: await this.count({}) };
  }

  /** A multi-segment action path: only the generated routes serve it. */
  async monthly(): Promise<{ months: number }> {
    return { months: 1 };
  }
}

/** The same, opted in to the super-admin bypass. */
@smrt({
  tenantScoped: {
    mode: 'optional',
    autoPopulate: false,
    allowSuperAdminBypass: true,
  },
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class ParityBypass extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  tenantId: string | null = null;
}

export class ParityBypassCollection extends SmrtCollection<ParityBypass> {
  static readonly _itemClass = ParityBypass;
}

/** Reads are open to anyone; writes are not. */
@smrt({
  api: { public: 'read', include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class ParityReadable extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

export class ParityReadableCollection extends SmrtCollection<ParityReadable> {
  static readonly _itemClass = ParityReadable;
}

/** Every operation is open to anyone. */
@smrt({
  api: { public: true, include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class ParityOpen extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

export class ParityOpenCollection extends SmrtCollection<ParityOpen> {
  static readonly _itemClass = ParityOpen;
}

/**
 * An STI family. The base is open to everyone; its subtype is private, so a
 * write that lands in the subtype (selected on create, or the row's own model
 * on update and delete) needs the subtype's own permission, whichever route
 * it is reached through.
 */
@smrt({
  tableStrategy: 'sti',
  tenantScoped: { mode: 'optional', autoPopulate: false },
  api: { public: true, include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class ParityVehicle extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  tenantId: string | null = null;
}

export class ParityVehicleCollection extends SmrtCollection<ParityVehicle> {
  static readonly _itemClass = ParityVehicle;
}

@smrt({
  // Its own permission collection: \`paritytrucks.<action>\`, not the base's.
  collection: 'paritytrucks',
  tenantScoped: { mode: 'optional', autoPopulate: false },
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class ParityTruck extends ParityVehicle {
  @field({ type: 'text' })
  payload = '';
}

export class ParityTruckCollection extends SmrtCollection<ParityTruck> {
  static readonly _itemClass = ParityTruck;
}
`;
