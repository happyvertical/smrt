// Plain-language reading of an approval's preview and action.
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { commandSummary } from './command-summary.ts';
import { humanize } from './fields.ts';
import { formulaWords } from './formula.ts';
import { publishLines, publishMethodLabel } from './publish.ts';
import type { ApprovalView, FieldDef, PublishPreview } from './types.ts';

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

function typeWords(value: unknown): string {
  return (
    (
      {
        integer: 'whole numbers',
        decimal: 'numbers',
        text: 'text',
        boolean: 'yes/no',
        date: 'dates',
        reference: 'links',
        json: 'structured data',
        choice: 'choices',
      } as Record<string, string>
    )[String(value)] ?? 'the selected type'
  );
}

/** Use the same owner-facing heading for the card and decision status. */
export function approvalHeading(view: ApprovalView): string {
  if (view.humanSummary) return view.humanSummary;
  const preview = obj(view.preview);
  if (view.action?.kind === 'command' && /^[a-z]/.test(view.summary))
    return commandSummary(view.action.command, undefined, undefined, preview);
  if (
    view.action?.kind === 'record-delete' ||
    view.action?.kind === 'rest' ||
    view.action?.kind === 'tool'
  )
    return `${view.action.kind !== 'tool' || view.action.name.endsWith('_delete') ? 'Delete record' : 'Run action'}${preview.modelLabel ? ` in ${preview.modelLabel}` : ''}`;
  return view.summary;
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
  refusal?: string;
  labels?: string[];
  keptLabel?: string;
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
  const model = String(
    preview.modelLabel ??
      humanize(String(command.model ?? preview.model ?? 'records')),
  );
  const field = String(
    preview.fieldLabel ??
      humanize(String(command.field ?? preview.field ?? 'the field')),
  );
  switch (op) {
    case 'mergeRecords': {
      const references = obj(preview.references);
      const labels = obj(preview.referenceLabels);
      return {
        ...base,
        keptLabel: String(preview.keepLabel || 'the selected record'),
        labels: Array.isArray(preview.removedLabels)
          ? preview.removedLabels.map(String)
          : [],
        lines: [
          `Merges ${plural(num(preview.removed), 'record')} in ${model} into the kept record.`,
          ...Object.entries(references).map(
            ([name, count]) =>
              `${plural(num(count), 'reference')} in ${labels[name] ?? humanize(name)} will point to the kept record.`,
          ),
          `Removes ${plural(num(preview.removed), 'record')} in total.`,
          'The merged records are removed. Undo restores them until old archives are cleaned up.',
        ],
      };
    }
    case 'extractModel':
      return {
        ...base,
        lines: [
          `Turns ${field} in ${model} into links to ${preview.intoLabel ?? humanize(String(command.into ?? 'linked records'))}.`,
          `${plural(num(preview.rows), 'record')} will be linked: ${plural(num(preview.create), 'linked record')} created and ${plural(num(preview.matched), 'existing record')} matched.`,
          `${plural(num(preview.distinct), 'distinct value')}; ${plural(num(preview.folded), 'value')} combined by normalization. Undo restores the original values until old archives are cleaned up.`,
        ],
      };
    case 'loadRecords':
      return {
        ...base,
        lines: [
          `Loads records into ${model}: ${num(preview.insert)} inserted, ${num(preview.update)} updated, ${num(preview.unchanged)} unchanged, ${num(preview.rejected)} rejected.`,
          ...(num(preview.update) > 0
            ? [
                'Updates overwrite stored values. Undo restores the originals until old archives are cleaned up.',
              ]
            : [
                'Undo removes the loaded records until old archives are cleaned up.',
              ]),
        ],
      };
    case 'setCalculation': {
      const fields = obj(preview.fields) as Record<string, FieldDef>;
      const from = preview.from as GeneratedExpression | null | undefined;
      const to = preview.to as GeneratedExpression | null | undefined;
      const words = (expression: GeneratedExpression) =>
        formulaWords(expression, fields);
      if (to === null)
        return {
          ...base,
          lines: [
            `Removes the calculation from ${field} in ${model}${from ? `: ${words(from)}` : ''}.`,
            `${plural(num(preview.rows), 'record')} ${num(preview.rows) === 1 ? 'keeps its' : 'keep their'} current ${num(preview.rows) === 1 ? 'value' : 'values'}. Future edits can set this field directly.`,
            'Undo restores the calculation until old archives are cleaned up.',
          ],
        };
      return {
        ...base,
        lines: [
          from && to
            ? `Changes the calculation for ${field} in ${model} from ${words(from)} to ${words(to)}.`
            : `Calculates ${field} in ${model}${to ? ` as ${words(to)}` : ''}.`,
          `${plural(num(preview.rows), 'record')} will be recalculated.`,
          ...(!from && num(preview.withValue) > 0
            ? [
                `${plural(num(preview.withValue), 'stored value')} will be overwritten with calculated values.`,
              ]
            : []),
          'Future edits cannot set this field directly. Undo restores the original values until old archives are cleaned up.',
        ],
      };
    }

    case 'removeField': {
      const n = num(preview.valuesArchived);
      return {
        ...base,
        lines: [
          `Removes ${field} from ${model}.`,
          `${plural(n, 'stored value')} will be archived. Undo restores ${n === 1 ? 'it' : 'them'} until old archives are cleaned up.`,
        ],
      };
    }
    case 'removeModel': {
      const n = num(preview.rows);
      return {
        ...base,
        lines: [
          `Removes the model ${model}.`,
          `${plural(n, 'record')} will be moved aside. Undo restores ${n === 1 ? 'it' : 'them'} until old archives are cleaned up.`,
        ],
      };
    }
    case 'changeFieldType': {
      const failing = num(preview.failingCount);
      const withValue = num(preview.withValue);
      const lines = [
        `Changes ${field} in ${model} from ${typeWords(preview.from)} to ${typeWords(preview.to)}.`,
        `${plural(withValue, 'record')} ${withValue === 1 ? 'holds' : 'hold'} a value; ${num(preview.convertible)} ${num(preview.convertible) === 1 ? 'converts' : 'convert'} cleanly.`,
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
          `Adds ${humanize(String(preview.method ?? command.name ?? 'the method'))} code to ${model}.`,
          String(preview.description ?? ''),
          'It runs in a sandbox and can only propose changes to your records. Read it before you approve.',
        ].filter(Boolean),
        blocks:
          typeof preview.code === 'string'
            ? [
                {
                  title: `${humanize(String(preview.method ?? command.name ?? 'the method'))} in ${model}`,
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
                  title: `${humanize(String(m.name))} in ${obj(preview.modelLabels)[String(m.model)] ?? humanize(String(m.model))}${m.description ? `: ${m.description}` : ''}`,
                  code: m.code,
                },
              ]
            : [],
        ),
      };
    }
    case 'undoTo':
    case 'undo': {
      const kinds = (
        Array.isArray(preview.undoKinds) ? preview.undoKinds : []
      ).map(obj);
      const lines = kinds.map((step) => {
        const model = String(step.modelLabel ?? 'the model');
        const field = String(step.fieldLabel ?? 'the field');
        switch (step.kind) {
          case 'loadRecords':
            return `Undoes the load in ${model}: removes ${plural(num(step.inserted), 'inserted record')} and restores ${plural(num(step.restoredValues), 'updated value')}. Other fields keep later edits.`;
          case 'mergeRecords':
            return `Undoes the merge in ${model}: recreates ${plural(num(step.recreated), 'removed record')} and points ${plural(num(step.references), 'reference')} back to those records.`;
          case 'extractModel':
            return `Undoes the extraction of ${field} in ${model}: restores ${plural(num(step.restoredValues), 'original text value')} and removes ${plural(num(step.inserted), 'created linked record')}.`;
          case 'calculation':
            return step.calculationRestore === 'calculation'
              ? `Restores the previous calculation for ${field} in ${model}.`
              : `Removes the calculation for ${field} in ${model} and restores ${plural(num(step.restoredValues), 'original stored value')}.`;
          case 'convertColumn':
            return `Undoes the type change for ${field} in ${model}: restores ${plural(num(step.restoredValues), 'archived original value')}. Values written since the type change can be overwritten.`;
          default:
            return 'Undoes the selected change.';
        }
      });
      const refusal =
        typeof preview.refusal === 'string' ? preview.refusal : undefined;
      return {
        ...base,
        refusal,
        lines: [
          ...(lines.length ? lines : ['Undoes the selected change.']),
          ...(refusal
            ? [refusal]
            : kinds.some((step) => step.kind === 'convertColumn')
              ? []
              : [
                  'Undo checks again and refuses conflicts that would discard later edits.',
                ]),
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
          'This approval is pinned to the reviewed changes. Draft records are thrown away.',
        ],
        blocks: p.methods.map((m) => ({
          title: publishMethodLabel(m, p),
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
          `Deletes ${preview.recordLabel ? `“${preview.recordLabel}” in ${preview.modelLabel ?? humanize(action.model)}` : `one record in ${preview.modelLabel ?? humanize(action.model)}`}. This cannot be undone from History.`,
        ],
      };
    case 'tool': {
      const kind = action.name.endsWith('_delete')
        ? `Deletes ${preview.recordLabel ? `“${preview.recordLabel}”` : 'the selected record'}${preview.modelLabel ? ` in ${preview.modelLabel}` : ''}`
        : `Runs ${preview.methodLabel ?? 'the selected action'}${preview.modelLabel ? ` in ${preview.modelLabel}` : ''}`;
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
            ? `Deletes ${preview.recordLabel ? `“${preview.recordLabel}”` : 'the selected record'}${preview.modelLabel ? ` in ${preview.modelLabel}` : ''}. This cannot be undone from History.`
            : 'Runs the selected request.',
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
