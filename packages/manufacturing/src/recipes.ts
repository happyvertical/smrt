/**
 * Declared recipes for smrt-manufacturing (#4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Assembly } from './models/Assembly.js';
import { BillOfMaterials } from './models/BillOfMaterials.js';
import { BomLine } from './models/BomLine.js';
import { Operation } from './models/Operation.js';
import { ProductionRun } from './models/ProductionRun.js';
import { ProductionRunCompletion } from './models/ProductionRunCompletion.js';
import { RoutingStep } from './models/RoutingStep.js';

/** Assemblies: Define what you make, what goes into it and the steps to make it. */
export class AssembliesRecipe extends SmrtRecipe {
  static id = 'manufacturing.assemblies';
  static help = './assemblies.recipe.md';
  static label = 'Assemblies';
  static summary =
    'Define what you make, what goes into it and the steps to make it.';
  static synonyms = [
    'bill of materials',
    'bills of materials',
    'bom',
    'recipes',
    'products you make',
    'routing',
  ];
  static section = {
    id: 'make',
    label: 'Make',
    icon: 'wrench',
    description: 'Make what you sell from the parts you hold.',
  };
  static models = [Assembly, BillOfMaterials, BomLine, Operation, RoutingStep];
  static nav = [
    {
      label: 'Assemblies',
      model: Assembly,
      icon: 'package',
      description: 'The things you make, each built from parts.',
      noun: 'assembly',
    },
    {
      label: 'Bills of materials',
      model: BillOfMaterials,
      icon: 'fileText',
      description: 'The list of parts and amounts that go into each assembly.',
      noun: 'bill of materials',
    },
    {
      label: 'Operations',
      model: Operation,
      icon: 'wrench',
      description: 'The kinds of work done to make something, like cutting.',
    },
  ];
  static requiresAny = [['products.simple', 'products.clothing']];
  static options = {
    Assembly: {
      fields: {
        name: { order: 1 },
        partReference: { order: 2 },
        description: { order: 3 },
        price: { order: 4 },
        estimatedLabourMinutes: { label: 'Minutes to make one', order: 5 },
        defaultOperationId: { label: 'Usual operation', order: 6 },
        tenantId: { visibility: 'hidden' },
        productType: { visibility: 'hidden' },
        category: { visibility: 'advanced' },
        manufacturer: { visibility: 'hidden' },
        model: { visibility: 'hidden' },
        inStock: { visibility: 'hidden', default: true },
        specifications: { visibility: 'hidden' },
        tags: { visibility: 'advanced' },
        defaultSalesTaxCodeId: { visibility: 'hidden' },
        defaultPurchaseTaxCodeId: { visibility: 'hidden' },
      },
    },
    BillOfMaterials: {
      fields: {
        productId: { label: 'Assembly', order: 1 },
        version: { order: 2 },
        status: { order: 3 },
        effectiveDate: { order: 4 },
        notes: { order: 5 },
        tenantId: { visibility: 'hidden' },
        currency: { visibility: 'advanced' },
      },
    },
    BomLine: {
      fields: {
        bomId: { label: 'Bill of materials', order: 1 },
        componentSkuId: { label: 'Part', order: 2 },
        qtyPerUnit: { label: 'Amount per unit', order: 3 },
        uom: { label: 'Unit of measure', order: 4 },
        wastePercent: { visibility: 'advanced' },
        notes: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
      },
    },
    Operation: {
      fields: {
        name: { order: 1 },
        code: { order: 2 },
        category: { order: 3 },
        isActive: { visibility: 'advanced' },
        requiredQualificationId: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
      },
    },
    RoutingStep: {
      fields: {
        bomId: { label: 'Bill of materials', order: 1 },
        operationId: { label: 'Operation', order: 2 },
        sequence: { label: 'Step number', order: 3 },
        estimatedMinutes: { order: 4 },
        notes: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}

/** Production: Plan how many to make, record what came out and see each run through to done. */
export class ProductionRecipe extends SmrtRecipe {
  static id = 'manufacturing.production';
  static help = './production.recipe.md';
  static label = 'Production';
  static summary =
    'Plan how many to make, record what came out and see each run through to done.';
  static synonyms = [
    'production runs',
    'work orders',
    'manufacturing',
    'batches',
    'build orders',
  ];
  static section = {
    id: 'make',
    label: 'Make',
    icon: 'wrench',
    description: 'Make what you sell from the parts you hold.',
  };
  static models = [ProductionRun, ProductionRunCompletion];
  static nav = [
    {
      label: 'Production runs',
      model: ProductionRun,
      icon: 'layers',
      description: 'Each batch you plan to make, and how far along it is.',
      noun: 'production run',
    },
  ];
  static requires = ['manufacturing.assemblies'];
  static options = {
    ProductionRun: {
      fields: {
        bomId: { label: 'Bill of materials', order: 1 },
        targetQty: { label: 'How many to make', order: 2 },
        completedQty: { label: 'How many made so far', locked: true, order: 3 },
        status: { locked: true, order: 4 },
        tenantId: { visibility: 'hidden' },
      },
    },
    ProductionRunCompletion: {
      fields: {
        runId: { label: 'Production run', order: 1 },
        qty: { label: 'How many finished', order: 2 },
        completedAt: { label: 'Finished on', order: 3 },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}
