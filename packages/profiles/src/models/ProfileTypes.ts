/**
 * Profile subclasses for STI (Single Table Inheritance)
 *
 * These classes inherit from Profile and automatically use the shared
 * profiles table with _meta_type discriminator.
 */

import { smrt } from '@happyvertical/smrt-core';
import { Profile, type ProfileOptions } from './Profile';

/**
 * Person profile type
 *
 * Represents individual people/users.
 */
@smrt({
  tableStrategy: 'sti',
})
export class Person extends Profile {
  constructor(options: ProfileOptions = {}) {
    super(options);
    // Person-specific initialization can go here
  }
}

/**
 * Organization profile type
 *
 * Represents companies, groups, institutions, and other organizational entities.
 */
@smrt({
  tableStrategy: 'sti',
})
export class Organization extends Profile {
  constructor(options: ProfileOptions = {}) {
    super(options);
    // Organization-specific initialization can go here
  }
}

/**
 * Bot profile type
 *
 * Represents automated agents, bots, and AI entities.
 */
@smrt({
  tableStrategy: 'sti',
})
export class Bot extends Profile {
  constructor(options: ProfileOptions = {}) {
    super(options);
    // Bot-specific initialization can go here
  }
}
