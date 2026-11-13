import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  type Command,
  EngineError,
  type FieldDef,
  type MethodDef,
} from '../../engine/index.ts';
import { type BuilderResult, runCommand } from '../server/builder.ts';
import {
  describeCopy,
  historyFor,
  previewDraft,
  requestDiscard,
  requestPublish,
  startDraft,
} from '../server/drafts.ts';
import { assertOwner } from '../server/owner.ts';
import { currentScope } from '../server/target.ts';

// The decorator config must be a literal: the smrt() scanner reads it
// statically (a shared constant would be invisible to it and every generated
// surface would default to full CRUD). The collection repeats it exactly:
// core applies a collection's @smrt() config to its item class.
//
// `operationPermissions` maps each custom operation onto the collection's own
// CRUD grant; the owner-only rule itself is `assertOwner()` inside every
// method (defense in depth: the generated routes also check the grant, but a
// member role may hold it).

/**
 * A JSON object argument that may arrive as a JSON string (MCP clients). A
 * wrong shape is a 400 that says what to send, never a server error.
 */
function obj(
  value: unknown,
  what: string,
  example = '{...}',
): Record<string, unknown> {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new EngineError(
        `${what} must be an object like ${example}`,
        'invalid',
      );
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new EngineError(
      `${what} must be an object like ${example}`,
      'invalid',
    );
  return v as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value)
    throw new EngineError(`${what} must be a non-empty string`, 'invalid');
  return value;
}

const FIELD_EXAMPLE = "{type: 'integer'}";

/**
 * Run a builder command on the copy the REQUEST named (`withScope`, entered by
 * the REST route or the tool dispatch; all-live when nothing entered it).
 */
async function run(command: Command): Promise<BuilderResult> {
  const owner = await assertOwner();
  return runCommand(command, owner.id, currentScope().structure);
}

/**
 * The shell's one app: a singleton row holding the current definition. Its
 * static methods are the builder operations (so smrt generates their REST,
 * MCP and CLI). All are owner only. A risky one does not apply: it returns
 * `{ status: 'pending_approval', approvalId, summary, preview }` and waits for
 * the owner's decision (`Approval.decide`).
 */
@smrt({
  tableName: 'apps',
  conflictColumns: ['id'],
  api: {
    include: [
      'defineModel',
      'addField',
      'hideField',
      'renameField',
      'removeField',
      'changeFieldType',
      'removeModel',
      'addMethod',
      'enableRecipe',
      'undo',
      'cleanUp',
      'exportTemplate',
      'importTemplate',
      'describe',
      'history',
      'undoTo',
      'startDraft',
      'previewPublish',
      'publishDraft',
      'discardDraft',
    ],
  },
  mcp: {
    include: [
      'defineModel',
      'addField',
      'hideField',
      'renameField',
      'removeField',
      'changeFieldType',
      'removeModel',
      'addMethod',
      'enableRecipe',
      'undo',
      'cleanUp',
      'exportTemplate',
      'importTemplate',
      'describe',
      'history',
      'undoTo',
      'startDraft',
      'previewPublish',
      'publishDraft',
      'discardDraft',
    ],
  },
  cli: {
    include: [
      'defineModel',
      'addField',
      'hideField',
      'renameField',
      'removeField',
      'changeFieldType',
      'removeModel',
      'addMethod',
      'enableRecipe',
      'undo',
      'cleanUp',
      'exportTemplate',
      'importTemplate',
      'describe',
      'history',
      'undoTo',
      'startDraft',
      'previewPublish',
      'publishDraft',
      'discardDraft',
    ],
  },
  operationPermissions: {
    defineModel: { action: 'update' },
    addField: { action: 'update' },
    hideField: { action: 'update' },
    renameField: { action: 'update' },
    removeField: { action: 'update' },
    changeFieldType: { action: 'update' },
    removeModel: { action: 'update' },
    addMethod: { action: 'update' },
    enableRecipe: { action: 'update' },
    undo: { action: 'update' },
    cleanUp: { action: 'update' },
    exportTemplate: { action: 'read' },
    importTemplate: { action: 'update' },
    describe: { action: 'read' },
    history: { action: 'read' },
    undoTo: { action: 'update' },
    startDraft: { action: 'update' },
    previewPublish: { action: 'read' },
    publishDraft: { action: 'update' },
    discardDraft: { action: 'update' },
  },
})
export class App extends SmrtObject {
  /** Display name of the user app. */
  @field({ type: 'text' })
  name: string = 'My app';

  /** The current version number, `-1` before the first start. */
  @field({ type: 'integer' })
  currentVersion: number = -1;

  /** The current definition, JSON text (a copy of the AppVersion row). */
  @field({ type: 'text' })
  definition: string = '';

  /** Add a model with its fields. */
  static async defineModel(
    name: string,
    fields?: Record<string, FieldDef>,
    label?: string,
  ) {
    // The shell's own tools are `app_*` and `approval_*`; an app model with
    // either name would generate colliding tool names.
    if (/^(app|approval)$/i.test(String(name)))
      throw new Error(`"${name}" is reserved for the shell`);
    return run({
      type: 'defineModel',
      name: str(name, 'name'),
      ...(label ? { label: str(label, 'label') } : {}),
      ...(fields === undefined
        ? {}
        : {
            fields: obj(fields, 'fields', "{title: {type: 'text'}}") as Record<
              string,
              FieldDef
            >,
          }),
    });
  }

  /** Add a field to a model. */
  static async addField(model: string, field: string, definition: FieldDef) {
    return run({
      type: 'addField',
      model: str(model, 'model'),
      field: str(field, 'field'),
      definition: obj(
        definition,
        'definition',
        FIELD_EXAMPLE,
      ) as unknown as FieldDef,
    });
  }

  /** Hide a field (kept in the data, not shown). */
  static async hideField(model: string, field: string) {
    return run({
      type: 'hideField',
      model: str(model, 'model'),
      field: str(field, 'field'),
    });
  }

  /** Rename a field; its values move with it. */
  static async renameField(model: string, from: string, to: string) {
    return run({
      type: 'renameField',
      model: str(model, 'model'),
      from: str(from, 'from'),
      to: str(to, 'to'),
    });
  }

  /** Remove a field (risky: needs the owner's approval; values are archived). */
  static async removeField(model: string, field: string) {
    return run({
      type: 'removeField',
      model: str(model, 'model'),
      field: str(field, 'field'),
    });
  }

  /** Change a field's type (risky: needs the owner's approval). */
  static async changeFieldType(
    model: string,
    field: string,
    definition: FieldDef,
  ) {
    return run({
      type: 'changeFieldType',
      model: str(model, 'model'),
      field: str(field, 'field'),
      to: obj(definition, 'definition', FIELD_EXAMPLE) as unknown as FieldDef,
    });
  }

  /** Remove a model (risky: needs the owner's approval; its table is moved aside). */
  static async removeModel(model: string) {
    return run({ type: 'removeModel', model: str(model, 'model') });
  }

  /** Add a code method to a model (risky: needs the owner's approval). */
  static async addMethod(model: string, name: string, method: MethodDef) {
    return run({
      type: 'addMethod',
      model: str(model, 'model'),
      name: str(name, 'name'),
      method: obj(
        method,
        'method',
        "{description: '...', code: 'return 1;'}",
      ) as unknown as MethodDef,
    });
  }

  /** Turn on a shipped recipe such as `profiles`. */
  static async enableRecipe(recipe: string) {
    return run({ type: 'enableRecipe', recipe: str(recipe, 'recipe') });
  }

  /**
   * Undo the last change. If that change converted a field's type, going back
   * would overwrite newer values with the archived originals, so it waits for
   * the owner's approval (`pending_approval`).
   */
  static async undo() {
    return run({ type: 'undo' });
  }

  /** Purge old archives, keeping the last `keep` changes (risky). */
  static async cleanUp(keep?: number) {
    const n = keep === undefined ? 5 : Number(keep);
    if (!Number.isInteger(n) || n < 0)
      throw new Error('keep must be a whole number, zero or more');
    return run({ type: 'cleanUp', keep: n });
  }

  /** Export the definition (and optionally the records) as a template. */
  static async exportTemplate(includeRecords?: boolean) {
    return run({
      type: 'exportTemplate',
      includeRecords: includeRecords === true,
    });
  }

  /** Import a template, replacing the definition (risky if it has code). */
  static async importTemplate(data: Record<string, unknown>) {
    return run({
      type: 'importTemplate',
      data: obj(
        data,
        'data',
        '{format: 1, definition: {...}}',
      ) as unknown as Command extends {
        type: 'importTemplate';
        data: infer T;
      }
        ? T
        : never,
    });
  }

  /**
   * Undo every change after `version` in one step (the history leading to now).
   * Waits for the owner's approval when any of them converted a field's type.
   * "Undo this publish": pass the version before the publish's first one.
   */
  static async undoTo(version: number) {
    const n = Number(version);
    if (!Number.isInteger(n))
      throw new EngineError('version must be a whole number', 'invalid');
    return run({ type: 'undoTo', version: n });
  }

  /**
   * Start a draft: a test copy of the app (with its records) to build in while
   * the live app keeps working. Live structure is frozen until the draft is
   * published or discarded. One draft at a time.
   */
  static async startDraft(name?: string) {
    const owner = await assertOwner();
    return startDraft(name, owner.id);
  }

  /**
   * Preview publishing the open draft: what changes, the SQL, every method's
   * code, and a digest. Read only.
   */
  static async previewPublish() {
    await assertOwner();
    return (await previewDraft()).preview;
  }

  /**
   * Publish the open draft's changes to the live app. ALWAYS waits for the
   * owner's approval (`pending_approval`); it applies only if the draft is
   * unchanged since this preview. Pass `expect` (the preview's digest) to
   * refuse a draft that changed since you looked.
   */
  static async publishDraft(expect?: string) {
    const owner = await assertOwner();
    return requestPublish(expect, owner.id);
  }

  /** Throw the open draft away (waits for the owner's approval). The live app is not changed. */
  static async discardDraft() {
    const owner = await assertOwner();
    return requestDiscard(owner.id);
  }

  /** The models, fields and methods of the app now. */
  static async describe() {
    await assertOwner();
    return describeCopy(currentScope().structure);
  }

  /** Every version of the app, newest last. */
  static async history() {
    await assertOwner();
    return historyFor(currentScope().structure);
  }
}

// Undecorated on purpose: the item class carries the whole generated surface.
export class AppCollection extends SmrtCollection<App> {
  static readonly _itemClass = App;
}
