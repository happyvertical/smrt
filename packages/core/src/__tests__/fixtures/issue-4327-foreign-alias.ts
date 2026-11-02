/**
 * #4327 fixture: a SECOND module that declares an alias with the same name as
 * the one in `generators/issue-4327-action-alias-schema.test.ts`, but bound to
 * a different type. Each class's action parameters must resolve through ITS
 * OWN declaring module's alias, never a project-wide flattened map.
 */
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

type ActionOptions4327 = string;

@smrt({ mcp: { include: ['tag'] } })
export class ForeignAlias4327 extends SmrtObject {
  static async tag(label: ActionOptions4327): Promise<unknown> {
    return { receiver: 'foreign', label };
  }
}
