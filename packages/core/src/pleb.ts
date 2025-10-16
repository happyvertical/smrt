import type { SmrtObjectOptions } from './object';
import { SmrtObject } from './object';

/**
 * Configuration options for Pleb objects
 *
 * @interface PlebOptions
 * @extends SmrtObjectOptions
 */
export interface PlebOptions extends SmrtObjectOptions {}

/**
 * Basic implementation class extending SmrtObject
 *
 * Pleb provides a simple SmrtObject implementation for quick prototyping
 * and testing without requiring custom field definitions.
 *
 * @class Pleb
 * @extends SmrtObject
 * @example
 * ```typescript
 * const pleb = await Pleb.create({
 *   name: 'Test Object',
 *   db: { url: 'sqlite://test.db' }
 * });
 * ```
 */
export class Pleb extends SmrtObject {
  /**
   * Creates a new Pleb instance
   *
   * @param options - Configuration options for the Pleb object
   */
  constructor(options: PlebOptions = {}) {
    super(options);
  }

  /**
   * Creates and initializes a new Pleb instance
   *
   * @param options - Configuration options for the Pleb object
   * @returns Promise resolving to the initialized Pleb instance
   * @example
   * ```typescript
   * const pleb = await Pleb.create({
   *   name: 'Sample Object',
   *   db: { url: 'sqlite://data.db' }
   * });
   * ```
   */
  static async create(options: PlebOptions) {
    const pleb = new Pleb(options);
    await pleb.initialize();
    return pleb;
  }

  /**
   * Initializes the Pleb instance and sets up database connections
   *
   * @returns Promise that resolves to this instance for chaining
   */
  public async initialize(): Promise<this> {
    return await super.initialize();
  }
}
