<script lang="ts">
/**
 * BomEditor — edits the lines of one assembly's bill of materials: materials,
 * bought items and sub-assemblies. Each sub-assembly says whether it has its
 * own active bill and, with `loadBill`, expands to show that bill read-only,
 * to any depth. A sub-assembly's own bill is edited on that assembly.
 *
 * Presentational: the host loads the bill with
 * `AssemblyService.getBillStructure` and adapts it with `toBomEditorLines`,
 * and saves through `BomLine`. The editor hands the host checked values. A
 * save the package refuses (for example a `BomCycleError`, a line that would
 * make the assembly contain itself) comes back to the host, which shows its
 * message through `error`.
 */

import { Alert, Badge, Button } from '@happyvertical/smrt-ui';
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type BomComponentOption,
  type BomEditorLine,
  type BomLineDraft,
  type BomLineDraftField,
  componentKindLabelKey,
  validateBomLineInput,
} from '../types.js';
import BomStructureTree from './BomStructureTree.svelte';

const { t } = useI18n();

/** What a host handler returns: `false` keeps the editor's draft. */
// biome-ignore lint/suspicious/noConfusingVoidType: a handler may return nothing.
type HandlerResult = boolean | void | Promise<boolean | void>;

export interface BomEditorProps {
  /** The bill's lines, in the host's order. */
  lines: BomEditorLine[];
  /** Components offered when adding a line; omit to hide the add form. */
  components?: BomComponentOption[];
  /** Adds a line. Return `false` (or reject) to keep the draft. */
  onadd?: (draft: BomLineDraft) => HandlerResult;
  /** Saves an edited line's quantity, unit and waste. Omit for read-only rows. */
  onupdate?: (id: string, draft: BomLineDraft) => HandlerResult;
  /** Removes a line. Omit to hide the remove buttons. */
  onremove?: (id: string) => HandlerResult;
  /** Loads a sub-assembly's bill lines by bill id, for the read-only expansion. */
  loadBill?: (bomId: string) => Promise<BomEditorLine[]>;
  /** The id of the bill being edited; its own bill is never expanded inside it. */
  bomId?: string;
  /** A message from the host, such as a refused save. */
  error?: string | null;
  /** Blocks every control while the host saves. */
  disabled?: boolean;
  /** Unit prefilled for a new line. */
  defaultUom?: string;
}

const {
  lines,
  components,
  onadd,
  onupdate,
  onremove,
  loadBill,
  bomId,
  error = null,
  disabled = false,
  defaultUom = 'each',
}: BomEditorProps = $props();

const uid = $props.id();

type RowDraft = { qtyPerUnit: string; uom: string; wastePercent: string };

let rowDrafts = $state<Record<string, RowDraft>>({});
let rowInvalid = $state<Record<string, BomLineDraftField[]>>({});
let open = $state<Record<string, boolean>>({});
let loadedBills = $state<
  Record<
    string,
    | { state: 'loading' }
    | { state: 'ready'; lines: BomEditorLine[] }
    | { state: 'failed' }
  >
>({});

let addComponent = $state('');
let addQty = $state('1');
// The prefilled unit is read once; `add()` resets to the current prop.
function initialUom(): string {
  return defaultUom;
}

let addUom = $state(initialUom());
let addWaste = $state('0');
let addInvalid = $state<BomLineDraftField[]>([]);
let busy = $state(false);

const blocked = $derived(disabled || busy);

function draftOf(line: BomEditorLine): RowDraft {
  return (
    rowDrafts[line.id] ?? {
      qtyPerUnit: String(line.qtyPerUnit),
      uom: line.uom,
      wastePercent: String(line.wastePercent),
    }
  );
}

function edit(line: BomEditorLine, field: keyof RowDraft, value: string) {
  rowDrafts[line.id] = { ...draftOf(line), [field]: value };
}

function isDirty(line: BomEditorLine): boolean {
  const draft = rowDrafts[line.id];
  if (!draft) return false;
  return (
    draft.qtyPerUnit !== String(line.qtyPerUnit) ||
    draft.uom !== line.uom ||
    draft.wastePercent !== String(line.wastePercent)
  );
}

function componentText(line: BomEditorLine): string {
  return line.skuCode && line.skuCode !== line.componentName
    ? `${line.componentName} (${line.skuCode})`
    : line.componentName;
}

async function run(handler: () => HandlerResult): Promise<boolean> {
  busy = true;
  try {
    return (await handler()) !== false;
  } catch {
    return false;
  } finally {
    busy = false;
  }
}

async function saveRow(line: BomEditorLine) {
  if (!onupdate) return;
  const draft = draftOf(line);
  const result = validateBomLineInput({
    componentSkuId: line.componentSkuId,
    ...draft,
  });
  if (!result.ok) {
    rowInvalid[line.id] = result.invalid;
    return;
  }
  rowInvalid[line.id] = [];
  if (await run(() => onupdate(line.id, result.value))) {
    delete rowDrafts[line.id];
  }
}

async function removeRow(line: BomEditorLine) {
  if (!onremove) return;
  if (await run(() => onremove(line.id))) {
    delete rowDrafts[line.id];
    delete rowInvalid[line.id];
  }
}

async function toggle(line: BomEditorLine) {
  const subBomId = line.subBomId;
  if (!subBomId || !loadBill) return;
  open[line.id] = !open[line.id];
  if (!open[line.id] || loadedBills[subBomId]?.state === 'ready') return;
  loadedBills[subBomId] = { state: 'loading' };
  try {
    loadedBills[subBomId] = {
      state: 'ready',
      lines: await loadBill(subBomId),
    };
  } catch {
    loadedBills[subBomId] = { state: 'failed' };
  }
}

async function add() {
  if (!onadd) return;
  const result = validateBomLineInput({
    componentSkuId: addComponent,
    qtyPerUnit: addQty,
    uom: addUom,
    wastePercent: addWaste,
  });
  if (!result.ok) {
    addInvalid = result.invalid;
    return;
  }
  addInvalid = [];
  if (await run(() => onadd(result.value))) {
    addComponent = '';
    addQty = '1';
    addUom = defaultUom;
    addWaste = '0';
  }
}

function errorText(field: BomLineDraftField): string {
  switch (field) {
    case 'componentSkuId':
      return t(M['manufacturing.bom_editor.error_component']);
    case 'qtyPerUnit':
      return t(M['manufacturing.bom_editor.error_qty']);
    case 'uom':
      return t(M['manufacturing.bom_editor.error_uom']);
    default:
      return t(M['manufacturing.bom_editor.error_waste']);
  }
}

const showActions = $derived(Boolean(onupdate || onremove));
const ancestors = $derived(bomId ? [bomId] : []);
</script>

<div class="bom-editor">
  {#if error}
    <Alert variant="error">{error}</Alert>
  {/if}

  {#if lines.length === 0}
    <p class="bom-editor-empty">{t(M['manufacturing.bom_editor.empty'])}</p>
  {:else}
    <div class="bom-editor-scroll">
      <table class="bom-editor-table">
        <caption class="bom-editor-caption">{t(M['manufacturing.bom_editor.caption'])}</caption>
        <thead>
          <tr>
            <th scope="col">{t(M['manufacturing.bom_editor.component'])}</th>
            <th scope="col">{t(M['manufacturing.bom_editor.kind'])}</th>
            <th scope="col">{t(M['manufacturing.bom_editor.qty_per_unit'])}</th>
            <th scope="col">{t(M['manufacturing.bom_editor.uom'])}</th>
            <th scope="col">{t(M['manufacturing.bom_editor.waste_percent'])}</th>
            {#if showActions}
              <th scope="col">{t(M['manufacturing.bom_editor.actions'])}</th>
            {/if}
          </tr>
        </thead>
        <tbody>
          {#each lines as line (line.id)}
            {@const draft = draftOf(line)}
            {@const invalid = rowInvalid[line.id] ?? []}
            {@const canOpen =
              line.kind === 'assembly' &&
              line.subBomId !== null &&
              loadBill !== undefined &&
              !ancestors.includes(line.subBomId)}
            {@const subId = `${uid}-sub-${line.id}`}
            {@const errorId = `${uid}-row-error-${line.id}`}
            <tr>
              <th scope="row" class="bom-editor-component">{componentText(line)}</th>
              <td>
                <div class="bom-editor-kind">
                  <Badge size="sm" variant={line.kind === 'missing' ? 'error' : 'default'}>
                    {t(componentKindLabelKey(line.kind))}
                  </Badge>
                  {#if line.kind === 'assembly'}
                    <span class="bom-editor-note">
                      {t(
                        line.subBomId
                          ? M['manufacturing.bom_editor.has_bill']
                          : M['manufacturing.bom_editor.no_bill'],
                      )}
                    </span>
                  {/if}
                  {#if canOpen}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={open[line.id] ? 'true' : 'false'}
                      aria-controls={subId}
                      aria-label={t(
                        open[line.id]
                          ? M['manufacturing.bom_editor.hide_bill_aria']
                          : M['manufacturing.bom_editor.show_bill_aria'],
                        { component: line.componentName },
                      )}
                      onclick={() => toggle(line)}
                    >
                      {t(
                        open[line.id]
                          ? M['manufacturing.bom_editor.hide_bill']
                          : M['manufacturing.bom_editor.show_bill'],
                      )}
                    </Button>
                  {/if}
                </div>
              </td>
              {#if onupdate}
                <td>
                  <Input
                    type="number"
                    inputmode="decimal"
                    step="any"
                    value={draft.qtyPerUnit}
                    oninput={(event) => edit(line, 'qtyPerUnit', (event.currentTarget as HTMLInputElement).value)}
                    disabled={blocked}
                    aria-label={t(M['manufacturing.bom_editor.qty_aria'], { component: line.componentName })}
                    aria-invalid={invalid.includes('qtyPerUnit') ? 'true' : undefined}
                    aria-describedby={invalid.length > 0 ? errorId : undefined}
                  />
                </td>
                <td>
                  <Input
                    type="text"
                    value={draft.uom}
                    oninput={(event) => edit(line, 'uom', (event.currentTarget as HTMLInputElement).value)}
                    disabled={blocked}
                    aria-label={t(M['manufacturing.bom_editor.uom_aria'], { component: line.componentName })}
                    aria-invalid={invalid.includes('uom') ? 'true' : undefined}
                    aria-describedby={invalid.length > 0 ? errorId : undefined}
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    inputmode="decimal"
                    step="any"
                    value={draft.wastePercent}
                    oninput={(event) => edit(line, 'wastePercent', (event.currentTarget as HTMLInputElement).value)}
                    disabled={blocked}
                    aria-label={t(M['manufacturing.bom_editor.waste_aria'], { component: line.componentName })}
                    aria-invalid={invalid.includes('wastePercent') ? 'true' : undefined}
                    aria-describedby={invalid.length > 0 ? errorId : undefined}
                  />
                </td>
              {:else}
                <td class="bom-editor-number">{line.qtyPerUnit}</td>
                <td>{line.uom}</td>
                <td class="bom-editor-number">{line.wastePercent}</td>
              {/if}
              {#if showActions}
                <td>
                  <div class="bom-editor-actions">
                    {#if onupdate}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={blocked || !isDirty(line)}
                        aria-label={t(M['manufacturing.bom_editor.save_aria'], { component: line.componentName })}
                        onclick={() => saveRow(line)}
                      >
                        {t(M['manufacturing.bom_editor.save'])}
                      </Button>
                    {/if}
                    {#if onremove}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={blocked}
                        aria-label={t(M['manufacturing.bom_editor.remove_aria'], { component: line.componentName })}
                        onclick={() => removeRow(line)}
                      >
                        {t(M['manufacturing.bom_editor.remove'])}
                      </Button>
                    {/if}
                  </div>
                  {#if invalid.length > 0}
                    <ul class="bom-editor-errors" id={errorId}>
                      {#each invalid as field (field)}
                        <li>{errorText(field)}</li>
                      {/each}
                    </ul>
                  {/if}
                </td>
              {/if}
            </tr>
            {#if canOpen && open[line.id] && line.subBomId}
              {@const entry = loadedBills[line.subBomId]}
              <tr class="bom-editor-sub">
                <td colspan={showActions ? 6 : 5}>
                  <div id={subId} class="bom-editor-sub-bill">
                    {#if entry?.state === 'ready'}
                      <BomStructureTree
                        lines={entry.lines}
                        {loadBill}
                        ancestors={[...ancestors, line.subBomId]}
                        label={t(M['manufacturing.bom_editor.sub_bill_label'], { component: line.componentName })}
                      />
                    {:else if entry?.state === 'failed'}
                      <p class="bom-editor-note" role="alert">{t(M['manufacturing.bom_editor.load_failed'])}</p>
                    {:else}
                      <p class="bom-editor-note" role="status">{t(M['manufacturing.bom_editor.loading'])}</p>
                    {/if}
                  </div>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if onadd && components}
    <section class="bom-editor-add" aria-labelledby="{uid}-add-heading">
      <h3 id="{uid}-add-heading" class="bom-editor-add-heading">{t(M['manufacturing.bom_editor.add_heading'])}</h3>
      <Form class="bom-editor-add-form" onsubmit={add}>
        <div class="field field-component">
          <label for="{uid}-add-component">{t(M['manufacturing.bom_editor.component'])}</label>
          <Select
            id="{uid}-add-component"
            name="componentSkuId"
            bind:value={addComponent}
            disabled={blocked}
            aria-invalid={addInvalid.includes('componentSkuId') ? 'true' : undefined}
            aria-describedby={addInvalid.length > 0 ? `${uid}-add-errors` : undefined}
          >
            <option value="">{t(M['manufacturing.bom_editor.choose_component'])}</option>
            {#each components as option (option.skuId)}
              <option value={option.skuId}>{option.label}</option>
            {/each}
          </Select>
        </div>
        <div class="field">
          <label for="{uid}-add-qty">{t(M['manufacturing.bom_editor.qty_per_unit'])}</label>
          <Input
            id="{uid}-add-qty"
            name="qtyPerUnit"
            type="number"
            inputmode="decimal"
            step="any"
            bind:value={addQty}
            disabled={blocked}
            aria-invalid={addInvalid.includes('qtyPerUnit') ? 'true' : undefined}
            aria-describedby={addInvalid.length > 0 ? `${uid}-add-errors` : undefined}
          />
        </div>
        <div class="field">
          <label for="{uid}-add-uom">{t(M['manufacturing.bom_editor.uom'])}</label>
          <Input
            id="{uid}-add-uom"
            name="uom"
            type="text"
            bind:value={addUom}
            disabled={blocked}
            aria-invalid={addInvalid.includes('uom') ? 'true' : undefined}
            aria-describedby={addInvalid.length > 0 ? `${uid}-add-errors` : undefined}
          />
        </div>
        <div class="field">
          <label for="{uid}-add-waste">{t(M['manufacturing.bom_editor.waste_percent'])}</label>
          <Input
            id="{uid}-add-waste"
            name="wastePercent"
            type="number"
            inputmode="decimal"
            step="any"
            bind:value={addWaste}
            disabled={blocked}
            aria-invalid={addInvalid.includes('wastePercent') ? 'true' : undefined}
            aria-describedby={addInvalid.length > 0 ? `${uid}-add-errors` : undefined}
          />
        </div>
        <div class="field field-submit">
          <Button type="submit" disabled={blocked}>{t(M['manufacturing.bom_editor.add'])}</Button>
        </div>
      </Form>
      {#if addInvalid.length > 0}
        <ul class="bom-editor-errors" id="{uid}-add-errors">
          {#each addInvalid as field (field)}
            <li>{errorText(field)}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .bom-editor {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .bom-editor-scroll {
    overflow-x: auto;
  }

  .bom-editor-table {
    width: 100%;
    border-collapse: collapse;
  }

  .bom-editor-caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .bom-editor-table th,
  .bom-editor-table td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .bom-editor-table thead th {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-label-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .bom-editor-component {
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }

  .bom-editor-kind,
  .bom-editor-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .bom-editor-number {
    font-variant-numeric: tabular-nums;
  }

  .bom-editor-note,
  .bom-editor-empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .bom-editor-sub-bill {
    padding-left: 1rem;
    border-left: 2px solid var(--smrt-color-outline-variant, transparent);
  }

  .bom-editor-errors {
    margin: 0.25rem 0 0;
    padding-left: 1rem;
    color: var(--smrt-color-error, inherit);
  }

  .bom-editor-add-heading {
    margin: 0 0 0.5rem;
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-title-small-weight, 500);
  }

  .bom-editor-add :global(.bom-editor-add-form) {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-component {
    flex: 1 1 14rem;
  }

  .field label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, inherit);
  }
</style>
