import type { CatalogField } from '../catalog/types.ts';
import type { DataSource, ModelRecord, RecordWrite } from '../data/source.ts';
import type {
  RecipeFormField,
  RecipeFormRecord,
  VariantGridForm,
} from '../recipes/types.ts';
import type { ActiveForm } from './active.ts';
import {
  contextFrom,
  findRows,
  type ModelLookup,
  mappedValues,
  parseTarget,
  slug,
  startingValue,
  targetField,
  toWriteValues,
} from './shared.ts';

/** One size x color (or whatever the axes are) combination. */
export interface GridCombo {
  /** Stable key: the values in axis order, as JSON. */
  key: string;
  /** `{ size: 'M', color: 'navy' }`: what `Sku.attributes` pins. */
  attributes: Record<string, string>;
  /** The values in axis order, for labels. */
  values: string[];
}

/** What a variant-grid form holds while it is open. */
export interface GridState {
  /** Product inputs by form field id. */
  values: Record<string, unknown>;
  /** Values on offer per axis name, in the order shown. */
  axes: Record<string, string[]>;
  /** Per-cell extension inputs: cell key, then form field id. */
  cells: Record<string, Record<string, unknown>>;
}

/** The rows a saved product already has, so a save can update and prune. */
export interface ExistingGrid {
  productId: string;
  variants: ModelRecord[];
  skus: ModelRecord[];
}

const comboKey = (values: readonly string[]) => JSON.stringify(values);

/**
 * Split pasted lists on commas, trim, drop blanks and repeats
 * (case-insensitively), keep the order.
 */
export function cleanValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values.flatMap((value) => value.split(','))) {
    const value = raw.trim();
    const folded = value.toLowerCase();
    if (!value || seen.has(folded)) continue;
    seen.add(folded);
    out.push(value);
  }
  return out;
}

/**
 * Every combination of the axes' values, rows in axis order. An axis with no
 * values is left out, so a product with only sizes still gets a cell per size;
 * no values anywhere means no cells.
 */
export function combinations(
  axes: readonly { name: string; values: readonly string[] }[],
): GridCombo[] {
  const used = axes
    .map((axis) => ({ name: axis.name, values: cleanValues(axis.values) }))
    .filter((axis) => axis.values.length > 0);
  if (used.length === 0) return [];
  let combos: { name: string; value: string }[][] = [[]];
  for (const axis of used) {
    combos = combos.flatMap((prefix) =>
      axis.values.map((value) => [...prefix, { name: axis.name, value }]),
    );
  }
  return combos.map((parts) => ({
    key: comboKey(parts.map((p) => p.value)),
    attributes: Object.fromEntries(parts.map((p) => [p.name, p.value])),
    values: parts.map((p) => p.value),
  }));
}

/** The grid's combinations for its current state. */
export function gridCombos(
  form: VariantGridForm,
  state: Pick<GridState, 'axes'>,
): GridCombo[] {
  return combinations(
    form.axes.map((axis) => ({
      name: axis.name,
      values: state.axes[axis.name] ?? [],
    })),
  );
}

/** Product inputs plus the per-cell inputs the extensions add. */
export function gridParts(active: ActiveForm<VariantGridForm>): {
  productFields: RecipeFormField[];
  cellFields: RecipeFormField[];
  cellRecords: RecipeFormRecord[];
} {
  return {
    productFields: active.form.fields,
    cellFields: active.extensions.flatMap((ext) => ext.fields ?? []),
    cellRecords: active.extensions.flatMap((ext) => ext.records ?? []),
  };
}

/** Product inputs with the catalog field they map onto, for rendering. */
export function gridProductInputs(
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
): { field: RecipeFormField; catalogField: CatalogField }[] {
  return active.form.fields.map((field) => ({
    field,
    catalogField: targetField(field, [active.form.product], models),
  }));
}

/** Cell inputs with the catalog field they map onto. */
export function gridCellInputs(
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
): { field: RecipeFormField; catalogField: CatalogField }[] {
  const { cellFields, cellRecords } = gridParts(active);
  const records = [skuRecord(active.form), ...cellRecords];
  return cellFields.map((field) => ({
    field,
    catalogField: targetField(field, records, models),
  }));
}

const skuRecord = (form: VariantGridForm): RecipeFormRecord => ({
  as: 'sku',
  model: form.skus,
});

/** An empty grid: starting values for the product inputs and every axis. */
export function blankGrid(
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
): GridState {
  return {
    values: Object.fromEntries(
      gridProductInputs(active, models).map(({ field, catalogField }) => [
        field.id,
        startingValue(field, catalogField),
      ]),
    ),
    axes: Object.fromEntries(
      active.form.axes.map((axis) => [axis.name, [...axis.values]]),
    ),
    cells: {},
  };
}

/** The starting inputs of one cell. */
export function blankCell(
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
): Record<string, unknown> {
  return Object.fromEntries(
    gridCellInputs(active, models).map(({ field, catalogField }) => [
      field.id,
      startingValue(field, catalogField),
    ]),
  );
}

/** Parse a JSON-string field (`allowedValues`, `attributes`), leniently. */
export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function attributesOf(sku: ModelRecord): Record<string, string> {
  const parsed = parseJson(sku.attributes);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, string>)
    : {};
}

function skuKey(form: VariantGridForm, sku: ModelRecord): string | undefined {
  const attributes = attributesOf(sku);
  const parts = form.axes
    .filter((axis) => axis.name in attributes)
    .map((axis) => String(attributes[axis.name]));
  return parts.length ? comboKey(parts) : undefined;
}

/** Load an existing product into a grid: its axes, then a cell per Sku. */
export async function loadGrid(
  source: DataSource,
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
  productId: string,
): Promise<{ state: GridState; existing: ExistingGrid } | undefined> {
  const { form } = active;
  const product = await source.get(models(form.product.model), productId);
  if (!product) return undefined;
  const variants = (await source.list(models(form.variants))).filter(
    (row) => row.productId === productId,
  );
  const skus = (await source.list(models(form.skus))).filter(
    (row) => row.productId === productId,
  );

  const state = blankGrid(active, models);
  for (const input of gridProductInputs(active, models)) {
    const { field } = parseTarget(input.field.to);
    const value = product[field];
    if (value !== undefined) state.values[input.field.id] = value;
  }
  for (const axis of form.axes) {
    const row = variants.find((v) => v.axisName === axis.name);
    const stored = parseJson(row?.allowedValues);
    state.axes[axis.name] = row
      ? Array.isArray(stored)
        ? cleanValues(stored.map(String))
        : []
      : [];
  }

  const { cellFields, cellRecords } = gridParts(active);
  const blank = blankCell(active, models);
  for (const sku of skus) {
    const key = skuKey(form, sku);
    if (!key) continue;
    const rows = await findRows(
      source,
      [skuRecord(form), ...cellRecords],
      { product, sku },
      models,
    );
    state.cells[key] = Object.fromEntries(
      cellFields.map((field) => {
        const { alias, field: name } = parseTarget(field.to);
        const value = rows[alias]?.[name];
        return [field.id, value === undefined ? blank[field.id] : value];
      }),
    );
  }
  return { state, existing: { productId, variants, skus } };
}

/** The Sku code of a new cell: product, then each value, upper-cased. */
export function skuCode(productName: unknown, combo: GridCombo): string {
  return [slug(productName) || 'SKU', ...combo.values.map(slug)]
    .filter(Boolean)
    .join('-');
}

/**
 * The related writes that save a variant grid: the product, one
 * `ProductVariant` per axis that has values (and a delete for one that no
 * longer does), a `Sku` per combination with its `attributes` pinned (Skus of
 * combinations that went away are deleted with the rows the extensions keep
 * under them), then each extension's rows per cell. Pure; `apply` runs it
 * all or nothing.
 */
export function planGridSave(
  active: ActiveForm<VariantGridForm>,
  models: ModelLookup,
  state: GridState,
  existing?: ExistingGrid,
): RecordWrite[] {
  const { form } = active;
  const { cellFields, cellRecords } = gridParts(active);
  const writes: RecordWrite[] = [];
  const productContext = contextFrom(form.fields, state.values);

  const productValues = mappedValues(
    form.fields,
    form.product.as,
    state.values,
  );
  writes.push({
    op: 'save',
    as: 'product',
    model: models(form.product.model),
    ...(existing ? { id: existing.productId } : {}),
    onCreate: toWriteValues(form.product.values, productContext),
    values: productValues,
  });

  const variantModel = models(form.variants);
  form.axes.forEach((axis, index) => {
    const values = cleanValues(state.axes[axis.name] ?? []);
    const match = { productId: { ref: 'product' }, axisName: axis.name };
    if (values.length === 0) {
      writes.push({ op: 'delete', model: variantModel, match });
      return;
    }
    writes.push({
      op: 'save',
      model: variantModel,
      match,
      onCreate: { label: axis.label.replace(/s$/i, '') },
      values: { allowedValues: JSON.stringify(values), sortOrder: index },
    });
  });

  const skuModel = models(form.skus);
  const combos = gridCombos(form, state);
  const wanted = new Set(combos.map((c) => c.key));
  const byKey = new Map(
    (existing?.skus ?? []).flatMap((sku) => {
      const key = skuKey(form, sku);
      return key ? [[key, sku] as const] : [];
    }),
  );

  // Skus whose combination left the grid go, with what hangs off them.
  for (const sku of existing?.skus ?? []) {
    const key = skuKey(form, sku);
    if (key && wanted.has(key)) continue;
    for (const record of cellRecords) {
      const match = Object.fromEntries(
        Object.entries(record.match ?? {}).flatMap(([field, value]) =>
          typeof value === 'object' && value?.ref === 'sku'
            ? [[field, sku.id]]
            : [],
        ),
      );
      if (Object.keys(match).length) {
        writes.push({ op: 'delete', model: models(record.model), match });
      }
    }
    writes.push({ op: 'delete', model: skuModel, id: sku.id });
  }

  const productName = productContext['product.name'];
  combos.forEach((combo, i) => {
    const current = byKey.get(combo.key);
    const label = combo.values.join(' / ');
    const name = `${String(productName ?? '').trim() || 'Item'} (${label})`;
    const code = skuCode(productName, combo);
    const skuAlias = `sku#${i}`;
    const values = {
      name,
      attributes: JSON.stringify(combo.attributes),
    };
    writes.push(
      current
        ? { op: 'save', as: skuAlias, model: skuModel, id: current.id, values }
        : {
            op: 'save',
            as: skuAlias,
            model: skuModel,
            match: { productId: { ref: 'product' }, code },
            onCreate: { active: true },
            values,
          },
    );

    const cell = state.cells[combo.key] ?? {};
    const rename = (alias: string) =>
      alias === 'product'
        ? alias
        : alias === 'sku'
          ? skuAlias
          : `${alias}#${i}`;
    const context = {
      ...productContext,
      'sku.name': name,
      'sku.code': current ? String(current.code ?? code) : code,
    };
    for (const record of cellRecords) {
      const mapped = mappedValues(cellFields, record.as, cell);
      writes.push({
        op: 'save',
        as: rename(record.as),
        model: models(record.model),
        ...(record.match
          ? { match: toWriteValues(record.match, context, rename) }
          : {}),
        onCreate: toWriteValues(record.values, context, rename),
        values: mapped,
      });
    }
  });
  return writes;
}
