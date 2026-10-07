/**
 * Selector-slot discovery (#3599).
 *
 * A package declares its UI slots in a module-scope `Record<string,
 * ModuleUISlot>` constant (conventionally `src/ui.ts`). A slot carrying
 * `selects: '@scope/pkg:Model'` marks that component as the selector for the
 * model. This reads those declarations statically, with no package code
 * loaded, so they can ride the manifest for hosts that render generic forms.
 *
 * Only slots that declare `selects` are collected: the manifest records
 * selector bindings, not the package's whole UI inventory.
 */

import { readFileSync } from 'node:fs';
import { parseSync } from 'oxc-parser';
import { extractModuleObjectConstants } from './oxc-parser.js';
import type { ScanError, UiSelectorDeclaration } from './types.js';

const QUALIFIED_NAME = /^@[^/\s:]+\/[^/\s:]+:[A-Za-z_$][\w$]*$/;

/** Locale-independent order: manifests must be byte-stable across machines. */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Result of reading one file for selector slots. */
export interface UiSelectorFileResult {
  selectors: UiSelectorDeclaration[];
  errors: ScanError[];
}

function langOf(filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts')) return 'ts';
  if (filePath.endsWith('.jsx')) return 'jsx';
  return 'js';
}

function collect(
  value: unknown,
  fallbackId: string | undefined,
  filePath: string,
  out: UiSelectorDeclaration[],
  errors: ScanError[],
  seen: Set<unknown>,
): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value)
      collect(entry, undefined, filePath, out, errors, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, 'selects')) {
    const slotId =
      typeof record.id === 'string' && record.id !== ''
        ? record.id
        : fallbackId;
    if (
      typeof record.selects !== 'string' ||
      !QUALIFIED_NAME.test(record.selects)
    ) {
      errors.push({
        message: `UI slot "${slotId ?? '?'}" declares selects ${JSON.stringify(record.selects)}; it must be a string literal qualified model name ("@scope/package:ClassName").`,
        filePath,
        severity: 'error',
      });
    } else if (!slotId) {
      errors.push({
        message: `A UI slot selecting ${record.selects} has no string \`id\`.`,
        filePath,
        severity: 'error',
      });
    } else {
      out.push({
        slotId,
        selects: record.selects as UiSelectorDeclaration['selects'],
        ...(typeof record.label === 'string' ? { label: record.label } : {}),
        ...(typeof record.description === 'string'
          ? { description: record.description }
          : {}),
        filePath,
      });
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'selects') continue;
    collect(child, key, filePath, out, errors, seen);
  }
}

/** Read one file for selector slots. Unreadable or unparsable files yield nothing. */
export function parseUiSelectorsFile(filePath: string): UiSelectorFileResult {
  const empty: UiSelectorFileResult = { selectors: [], errors: [] };
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, 'utf-8');
  } catch {
    return empty;
  }
  if (!sourceText.includes('selects')) return empty;
  try {
    const program = parseSync(filePath, sourceText, {
      lang: langOf(filePath),
      preserveParens: false,
    }).program;
    if (!program?.body) return empty;
    const constants = extractModuleObjectConstants(
      program.body as unknown as Parameters<
        typeof extractModuleObjectConstants
      >[0],
      sourceText,
    );
    const selectors: UiSelectorDeclaration[] = [];
    const errors: ScanError[] = [];
    const seen = new Set<unknown>();
    for (const [name, constant] of constants) {
      collect(constant.value, name, filePath, selectors, errors, seen);
    }
    return { selectors, errors };
  } catch {
    return empty;
  }
}

/**
 * Merge per-file declarations into one deterministic, id-keyed record.
 * A slot id declared twice, or one model claimed by two slots, is an error:
 * a host must be able to resolve exactly one selector per model.
 */
export function mergeUiSelectors(
  files: UiSelectorFileResult[],
  relativize: (filePath: string) => string = (p) => p,
): {
  selectors: Record<string, UiSelectorDeclaration>;
  errors: ScanError[];
} {
  const errors: ScanError[] = files.flatMap((file) => file.errors);
  const all = files
    .flatMap((file) => file.selectors)
    .sort(
      (a, b) => ordinal(a.slotId, b.slotId) || ordinal(a.filePath, b.filePath),
    );
  const selectors: Record<string, UiSelectorDeclaration> = {};
  const byModel = new Map<string, string>();
  for (const decl of all) {
    if (selectors[decl.slotId]) {
      errors.push({
        message: `UI slot id "${decl.slotId}" is declared more than once.`,
        filePath: decl.filePath,
        severity: 'error',
      });
      continue;
    }
    const other = byModel.get(decl.selects);
    if (other) {
      errors.push({
        message: `UI slots "${other}" and "${decl.slotId}" both select ${decl.selects}; a model has one selector.`,
        filePath: decl.filePath,
        severity: 'error',
      });
      continue;
    }
    byModel.set(decl.selects, decl.slotId);
    selectors[decl.slotId] = { ...decl, filePath: relativize(decl.filePath) };
  }
  return { selectors, errors };
}
