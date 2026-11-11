/** Human-language adapter only: persistence, validation and publication belong to the editor. */
import { createHash } from 'node:crypto';
import type { CookbookModelField } from '@happyvertical/smrt-types';
import { ObjectRegistry } from '../registry.js';
import { pluralize, toSnakeCase } from '../utils/naming.js';
import { coveredModels } from './engine/document.js';
import { buildNav, humanize, modelParts, navItemId } from './engine/nav.js';
import type { AppToolName } from './index.js';
import type { AppModelEdit, AppModelSnapshot } from './model-editor.js';
import { cookbookModelCatalog, isCustomIdentifier } from './models.js';
import type { CookbookToolOptions, CookbookToolResult } from './tools.js';

/** Clarification and collisions are data the assistant/client can render without parsing prose. */
export class AppToolQuestion extends Error {
  constructor(readonly result: CookbookToolResult) {
    super(result.summary);
  }
}
const question = (
  status: 'clarification_required' | 'collision',
  summary: string,
  candidates: unknown[] = [],
): never => {
  throw new AppToolQuestion({ status, summary, candidates });
};
const normalize = (value: string) =>
  pluralize(
    value
      .toLowerCase()
      .trim()
      .replace(/^the\s+/, '')
      .replace(/\s+(list|field)$/, '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  );

export function describeApp(
  snapshot: AppModelSnapshot,
  source: CookbookToolOptions['catalog'],
) {
  const doc = snapshot.cookbook;
  const catalog = cookbookModelCatalog(source, doc.models);
  const nav = buildNav(catalog, doc).flatMap((section) => section.items);
  // Prerequisites are active framework capabilities, not person-facing lists.
  // Only an explicit recipe menu or feature placement gives them a list name.
  const placed = new Set([
    ...doc.features,
    ...catalog.recipes
      .filter((recipe) => doc.recipes.includes(recipe.id))
      .flatMap((recipe) => recipe.nav.map((entry) => entry.model)),
  ]);
  return [...coveredModels(catalog, doc)]
    .filter((id) => placed.has(id))
    .map((id) => {
      const parts = modelParts(catalog, id);
      const list = id.startsWith(`${doc.models?.packageName}:`)
        ? doc.models?.lists[parts.name]
        : undefined;
      const itemId = navItemId(parts.packageId, parts.name);
      const recipeItems = source.recipes
        .filter((recipe) => doc.recipes.includes(recipe.id))
        .flatMap((recipe) =>
          recipe.nav
            .filter((entry) => entry.model === id)
            .map((entry) => navItemId(parts.packageId, parts.name, entry.key)),
        );
      const item =
        nav.find((entry) => recipeItems.includes(entry.id)) ??
        nav.find((entry) => entry.id === itemId);
      const effective = ObjectRegistry.getClass(id)?.qualifiedName ?? id;
      const definition = snapshot.webDefinitions.find(
        (entry) => entry.objectRef === effective || entry.objectRef === id,
      );
      const customFields = list?.fields ?? doc.models?.fields[id] ?? {};
      const aliases = source.recipes
        .filter(
          (recipe) =>
            doc.recipes.includes(recipe.id) && recipe.models.includes(id),
        )
        .flatMap((recipe) => recipe.synonyms ?? []);
      return {
        id,
        name: parts.name,
        label: item?.label ?? list?.label ?? humanize(parts.name),
        icon: item?.icon ?? list?.icon ?? 'fileText',
        origin: list ? 'yours' : 'pre-built',
        synonyms: aliases,
        fields: Object.entries(definition?.fields ?? {}).map(
          ([name, field]) => {
            const policy = doc.policies.find(
              (row) =>
                (row.objectRef === id || row.objectRef === effective) &&
                row.fieldName === name &&
                row.scopeType === 'app',
            );
            return {
              name,
              label: policy?.label ?? humanize(name),
              type: customFields[name]?.type ?? field.type,
              origin:
                customFields[name] || definition?.customFields.includes(name)
                  ? 'yours'
                  : 'pre-built',
              hidden: policy?.visibility === 'hidden',
              ...(customFields[name]?.choices
                ? { options: customFields[name].choices }
                : {}),
              ...(customFields[name]?.target
                ? { target: customFields[name].target }
                : {}),
            };
          },
        ),
      };
    });
}
type AppList = ReturnType<typeof describeApp>[number];
function resolveList(lists: AppList[], reference: string): AppList {
  const key = normalize(reference);
  const exact = lists.filter(
    (list) => list.id === reference || normalize(list.label) === key,
  );
  const matches = exact.length
    ? exact
    : lists.filter((list) =>
        list.synonyms.some((alias) => normalize(alias) === key),
      );
  if (matches.length !== 1)
    return question(
      'clarification_required',
      matches.length
        ? 'Which list did you mean?'
        : 'Which list would you like to change?',
      (matches.length ? matches : lists)
        .slice(0, 8)
        .map((list) => ({ id: list.id, label: list.label })),
    );
  return matches[0];
}
function resolveField(list: AppList, reference: string) {
  const fields = list.fields.filter(
    (field) =>
      field.name === reference ||
      normalize(field.label) === normalize(reference),
  );
  if (fields.length !== 1)
    return question(
      'clarification_required',
      'Which field did you mean?',
      (fields.length ? fields : list.fields).slice(0, 8),
    );
  return fields[0];
}
/** Safe internal names are derived, never requested from the person. The editor remains the authority. */
function identifier(label: string, model = false): string {
  const words =
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .match(/[a-zA-Z0-9]+/g) ?? [];
  let name = words
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join('');
  if (!name || /^\d/.test(name))
    name = `${model ? 'List' : 'Field'}${name || createHash('sha256').update(label).digest('hex').slice(0, 10)}`;
  if (!model) name = name[0].toLowerCase() + name.slice(1);
  name = name.slice(0, 56);
  if (!isCustomIdentifier(name as unknown, model))
    name = `${model ? 'Custom' : 'custom'}${name[0].toUpperCase()}${name.slice(1)}`;
  return name;
}
/** Names from the existing Shell section icon picker; core never imports Svelte components. */
function iconFor(meaning: string) {
  const choices: [RegExp, string][] = [
    [/customer|client|people|member|contact/i, 'users'],
    [/invoice|receipt|bill|payment/i, 'receipt'],
    [/event|date|appointment|class|schedule/i, 'calendar'],
    [/mat|stock|inventory|product/i, 'package'],
    [/delivery|vehicle|truck/i, 'truck'],
    [/repair|mechanic|tool/i, 'wrench'],
    [/book|library|reading/i, 'book'],
    [/job|work|project/i, 'briefcase'],
  ];
  return choices.find(([pattern]) => pattern.test(meaning))?.[1] ?? 'folder';
}
function checkCollision(
  name: string,
  label: string,
  fields: AppList['fields'],
  money = false,
) {
  const names = [name, ...(money ? [`${name}Currency`] : [])].map(toSnakeCase);
  const conflicts = fields.filter(
    (field) =>
      names.includes(toSnakeCase(field.name)) ||
      normalize(field.label) === normalize(label),
  );
  if (conflicts.length)
    question(
      'collision',
      `“${label}” is already used; choose a different field label.`,
      conflicts,
    );
}

export function planAppEdit(
  name: AppToolName,
  args: Record<string, unknown>,
  snapshot: AppModelSnapshot,
  catalog: CookbookToolOptions['catalog'],
): { edit: AppModelEdit; summary: string; data?: unknown } {
  const lists = describeApp(snapshot, catalog);
  function fieldFrom(input: Record<string, unknown>): CookbookModelField {
    const kinds: Record<string, CookbookModelField['type']> = {
      text: 'text',
      'long text': 'longText',
      number: 'decimal',
      money: 'money',
      date: 'date',
      'date-time': 'datetime',
      'yes/no': 'boolean',
      choice: 'choice',
      link: 'reference',
    };
    const type = kinds[String(input.kind)];
    if (!type) throw new Error('Unknown field kind.');
    if (type === 'money' && !input.currency)
      question(
        'clarification_required',
        'Which currency should this money field use?',
        [
          { label: 'Canadian dollars', currency: 'CAD' },
          { label: 'US dollars', currency: 'USD' },
          { label: 'Euros', currency: 'EUR' },
        ],
      );
    if (type === 'choice' && !input.options)
      question(
        'clarification_required',
        'What choices should this field offer?',
      );
    return {
      type,
      ...(type === 'money' ? { currency: String(input.currency) } : {}),
      ...(type === 'choice' ? { choices: input.options as string[] } : {}),
      ...(type === 'reference'
        ? { target: resolveList(lists, String(input.linkTo)).id }
        : {}),
    };
  }
  if (name === 'app.undo')
    return { edit: { type: 'undo' }, summary: 'Undid the last change.' };
  if (name === 'app.addList') {
    const label = String(args.label).trim();
    const listName = identifier(label, true);
    if (
      lists.some((list) => normalize(list.label) === normalize(label)) ||
      [...ObjectRegistry.getAllClasses().values()].some(
        (entry) => entry.name.toLowerCase() === listName.toLowerCase(),
      ) ||
      snapshot.cookbook.models?.lists[listName]
    )
      question(
        'collision',
        `“${label}” is already used; choose a different list name.`,
      );
    const fields: Record<string, CookbookModelField> = {};
    const labels: Record<string, string> = {};
    const seen: AppList['fields'] = [];
    for (const input of args.fields as Record<string, unknown>[]) {
      const fieldLabel = String(input.label).trim();
      const fieldName = identifier(fieldLabel);
      checkCollision(fieldName, fieldLabel, seen, input.kind === 'money');
      fields[fieldName] = fieldFrom(input);
      labels[fieldName] = fieldLabel;
      seen.push({
        name: fieldName,
        label: fieldLabel,
        type: fields[fieldName].type,
        origin: 'yours',
        hidden: false,
      });
      if (fields[fieldName].type === 'money')
        seen.push({
          name: `${fieldName}Currency`,
          label: `${fieldLabel} currency`,
          type: 'text',
          origin: 'yours',
          hidden: false,
        });
    }
    const display = Object.entries(labels).filter(
      ([, label]) => normalize(label) === normalize(String(args.nameField)),
    );
    if (display.length !== 1)
      question(
        'clarification_required',
        'Which field names each record?',
        seen,
      );
    return {
      edit: {
        type: 'create_list',
        name: listName,
        list: {
          label,
          icon: iconFor(String(args.iconMeaning ?? label)),
          displayField: display[0][0],
          fields,
        },
        fieldLabels: labels,
      },
      summary: `Added the ${label} list.`,
    };
  }
  const list = resolveList(lists, String(args.list));
  if (name === 'app.renameList')
    return {
      edit: {
        type: 'relabel_list',
        name: list.origin === 'yours' ? list.name : list.id,
        label: String(args.label).trim(),
        icon: iconFor(String(args.iconMeaning ?? args.label)),
      },
      summary: `Renamed ${list.label} to ${String(args.label).trim()}.`,
    };
  if (name === 'app.removeList') {
    if (list.origin !== 'yours')
      throw new Error(
        'Pre-built lists are managed by recipes.disable; only your own lists can be removed here.',
      );
    return {
      edit: { type: 'remove_list', name: list.name },
      summary: `Removed the ${list.label} list and kept its data.`,
    };
  }
  if (name === 'app.addField') {
    const label = String(args.label).trim();
    const fieldName = identifier(label);
    checkCollision(fieldName, label, list.fields, args.kind === 'money');
    return {
      edit: {
        type: 'add_field',
        model: list.id,
        name: fieldName,
        field: fieldFrom(args),
        label,
      },
      summary: `Added ${label} to ${list.label}.`,
      data: { field: fieldName, label },
    };
  }
  const field = resolveField(list, String(args.field));
  if (name === 'app.renameField')
    return {
      edit: {
        type: 'label_field',
        model: list.id,
        name: field.name,
        label: String(args.label).trim(),
      },
      summary: `Renamed ${field.label} to ${String(args.label).trim()}.`,
    };
  if (name === 'app.removeField')
    return {
      edit: { type: 'remove_field', model: list.id, name: field.name },
      summary: `Removed ${field.label} from ${list.label} and kept its data.`,
    };
  return {
    edit: {
      type: 'hide_field',
      model: list.id,
      name: field.name,
      hidden: name === 'app.hideField',
    },
    summary: `${name === 'app.hideField' ? 'Hid' : 'Showed'} ${field.label} in ${list.label}.`,
  };
}
