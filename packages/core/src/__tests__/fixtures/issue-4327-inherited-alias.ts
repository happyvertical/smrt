/**
 * #4327 fixture: a subclass in ANOTHER module that inherits `tag()` from
 * `ForeignAlias4327` and declares its own, differently-bound alias of the same
 * name. The inherited parameter keeps the resolution made in the method's
 * declaring module.
 */
import { smrt } from '../../registry.js';
import { ForeignAlias4327 } from './issue-4327-foreign-alias.js';

type ActionOptions4327 = number;

@smrt({ mcp: { include: ['tag', 'count'] } })
export class InheritedAlias4327 extends ForeignAlias4327 {
  static async count(value: ActionOptions4327): Promise<unknown> {
    return { receiver: 'inherited', value };
  }
}
