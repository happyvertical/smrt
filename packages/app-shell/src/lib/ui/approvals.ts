// Plain-language reading of an approval's preview and action.
import { publishLines } from './publish.ts';
import type { ApprovalView, PublishPreview } from './types.ts';

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface CodeBlock {
  /** `Model.method()`. */
  title: string;
  code: string;
}

export interface ApprovalDescription {
  /** Short sentences saying what will happen. */
  lines: string[];
  /** Code to show in read-only blocks (new methods): what is approved is what is shown. */
  blocks: CodeBlock[];
  /** True when something is lost for good (not restorable by undo). */
  destructive: boolean;
}

function commandLines(
  command: Record<string, unknown>,
  preview: Record<string, unknown>,
): ApprovalDescription {
  const op = String(command.type ?? '');
  const base: ApprovalDescription = {
    lines: [],
    blocks: [],
    destructive: false,
  };
  const model = String(preview.modelLabel ?? command.model ?? 'records');
  const field = String(preview.fieldLabel ?? command.field ?? 'the field');
  switch (op) {
    case 'mergeRecords': {
      const references = obj(preview.references);
      const labels = obj(preview.referenceLabels);
      return {
        ...base,
        lines: [
          `Merges ${plural(num(preview.removed), `${model} record`)} into ${preview.keepLabel ?? 'the selected record'}.`,
          ...Object.entries(references).map(
            ([name, count]) =>
              `${plural(num(count), 'reference')} in ${labels[name] ?? name} will point to the kept record.`,
          ),
          'The merged records are removed. Undo restores them until old archives are cleaned up.',
        ],
      };
    }
    case 'extractModel':
      return {
        ...base,
        lines: [
          `Turns ${field} in ${model} into links to ${preview.intoLabel ?? command.into}.`,
          `${plural(num(preview.rows), 'record')} will be linked: ${num(preview.create)} linked records created and ${num(preview.matched)} existing records matched.`,
          `${plural(num(preview.distinct), 'distinct value')}; ${num(preview.folded)} values combined by normalization. Undo restores the original values until old archives are cleaned up.`,
        ],
      };
    case 'loadRecords':
      return {
        ...base,
        lines: [
          `Loads records into ${model}: ${num(preview.insert)} inserted, ${num(preview.update)} updated, ${num(preview.unchanged)} unchanged, ${num(preview.rejected)} rejected.`,
          'Updates overwrite stored values. Undo restores the originals until old archives are cleaned up.',
        ],
      };
    case 'setCalculation':
      return {
        ...base,
        lines: [
          `Calculates ${field} in ${model}.`,
          ...(typeof preview.rows === 'number'
            ? [`${plural(num(preview.rows), 'record')} will be recalculated.`]
            : []),
          'This replaces ordinary stored values with calculated values. Future edits cannot set this field directly. Undo restores the original values until old archives are cleaned up.',
        ],
      };

    case 'removeField': {
      const n = num(preview.valuesArchived);
      return {
        ...base,
        lines: [
          `Removes the field ${preview.model}.${preview.field}.`,
          `${plural(n, 'stored value')} will be archived. Undo restores them until old archives are cleaned up.`,
        ],
      };
    }
    case 'removeModel': {
      const n = num(preview.rows);
      return {
        ...base,
        lines: [
          `Removes the model ${preview.model}.`,
          `${plural(n, 'record')} will be moved aside. Undo restores them until old archives are cleaned up.`,
        ],
      };
    }
    case 'changeFieldType': {
      const failing = num(preview.failingCount);
      const withValue = num(preview.withValue);
      const lines = [
        `Changes ${preview.model}.${preview.field} from ${preview.from} to ${preview.to}.`,
        `${plural(withValue, 'record')} hold a value; ${num(preview.convertible)} convert cleanly.`,
      ];
      if (failing > 0)
        lines.push(
          `${plural(failing, 'value')} cannot convert and will become empty. The originals are archived so undo restores them.`,
        );
      return { ...base, lines };
    }
    case 'addMethod':
      return {
        ...base,
        lines: [
          `Adds code that will run on your data: ${preview.model}.${preview.method}().`,
          String(preview.description ?? ''),
          'It runs in a sandbox and can only propose changes to your records. Read it before you approve.',
        ].filter(Boolean),
        blocks:
          typeof preview.code === 'string'
            ? [
                {
                  title: `${preview.model}.${preview.method}()`,
                  code: preview.code,
                },
              ]
            : [],
      };
    case 'cleanUp': {
      const versions = Array.isArray(preview.versions)
        ? preview.versions.length
        : 0;
      return {
        ...base,
        destructive: true,
        lines: [
          `${plural(versions, 'older change')} can no longer be undone.`,
          `${plural(num(preview.archivedValues), 'archived value')} and ${plural(num(preview.archivedTables), 'archived table')} will be deleted for good.`,
        ],
      };
    }
    case 'importTemplate': {
      const models = Array.isArray(preview.models) ? preview.models.length : 0;
      const methods = Array.isArray(preview.methods)
        ? preview.methods.map(obj)
        : [];
      const lines = [
        `Builds the app from a template: ${plural(models, 'model')}, ${plural(methods.length, 'code method')}, ${plural(num(preview.records), 'starter record')}.`,
      ];
      if (methods.length > 0)
        lines.push(
          'The template carries code that will run on your data. Read all of it before you approve.',
        );
      return {
        ...base,
        lines,
        blocks: methods.flatMap((m) =>
          typeof m.code === 'string'
            ? [
                {
                  title: `${m.model}.${m.name}()${m.description ? `: ${m.description}` : ''}`,
                  code: m.code,
                },
              ]
            : [],
        ),
      };
    }
    case 'undoTo':
    case 'undo': {
      const fields = (Array.isArray(preview.fields) ? preview.fields : [])
        .map(obj)
        .map((f) => `${f.model}.${f.field}`);
      const replaced = num(preview.replaced);
      return {
        ...base,
        destructive: replaced > 0,
        lines: [
          `Undoes a type change: every row of ${fields.join(', ') || 'the field'} goes back to its original value.`,
          replaced > 0
            ? `${plural(replaced, 'record')} changed since will be overwritten with the original value. This cannot be taken back.`
            : 'No value written since the change will be lost.',
        ],
      };
    }
    default:
      return base;
  }
}

/** What an approval will do, in plain language. */
export function describeApproval(view: ApprovalView): ApprovalDescription {
  const preview = obj(view.preview);
  const action = view.action;
  const empty: ApprovalDescription = {
    lines: [],
    blocks: [],
    destructive: false,
  };
  if (!action) return empty;
  switch (action.kind) {
    case 'publish-draft': {
      const p = preview as unknown as PublishPreview;
      return {
        ...empty,
        lines: [
          `Publishes “${action.draftName}”.`,
          ...publishLines(p),
          'Counts can change until publish. Draft records are thrown away.',
        ],
        blocks: p.methods.map((m) => ({
          title: `${m.model}.${m.name}()`,
          code: m.code,
        })),
      };
    }
    case 'discard-draft':
      return {
        ...empty,
        destructive: true,
        lines: [
          `Discards “${action.draftName}” and its test records. Your live app stays unchanged.`,
        ],
      };
    case 'command':
      return commandLines(action.command, preview);
    case 'record-delete':
      return {
        ...empty,
        destructive: true,
        lines: [
          `Deletes one ${action.model} record. This cannot be undone from History.`,
        ],
      };
    case 'tool': {
      const kind = action.name.endsWith('_delete')
        ? 'Deletes a record'
        : `Calls ${action.name}`;
      return {
        ...empty,
        destructive: action.name.endsWith('_delete'),
        lines: [`${kind}. This cannot be undone from History.`],
      };
    }
    case 'rest':
      return {
        ...empty,
        destructive: action.method === 'DELETE',
        lines: [
          action.method === 'DELETE'
            ? `Deletes ${action.url.replace(/^\/api\//, '')}. This cannot be undone from History.`
            : `${action.method} ${action.url}`,
        ],
      };
  }
}

const OUTCOME: Record<string, string> = {
  approved: 'Approved',
  denied: 'Denied',
  failed: 'Failed',
  pending: 'Waiting',
};

export function statusLabel(status: string): string {
  return OUTCOME[status] ?? status;
}

/** The error text of a failed approval, if its result carries one. */
export function failureText(view: ApprovalView): string | null {
  if (view.status !== 'failed') return null;
  const r = obj(view.result);
  return typeof r.error === 'string' ? r.error : null;
}

export function splitApprovals(approvals: ApprovalView[]): {
  pending: ApprovalView[];
  decided: ApprovalView[];
} {
  return {
    pending: approvals.filter((a) => a.status === 'pending'),
    decided: approvals.filter((a) => a.status !== 'pending'),
  };
}
