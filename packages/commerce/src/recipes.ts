/**
 * Declared recipes for smrt-commerce (#3590): small, user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 *
 * Deliberately minimal: headers only. Line items, fulfilment, invoices, and
 * payments are later recipes.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Order, PurchaseOrder } from './models/Contract.js';
import { Customer } from './models/Customer.js';
import { Vendor } from './models/Vendor.js';

/** The people and organisations you sell to. */
export class CustomersRecipe extends SmrtRecipe {
  static id = 'commerce.customers';
  static label = 'Customers';
  static summary = 'Keep a list of the customers you sell to.';
  static synonyms = ['clients', 'buyers', 'accounts'];
  static models = [Customer];
  static nav = [{ label: 'Customers', model: Customer }];
}

/** The people and organisations you buy from. */
export class VendorsRecipe extends SmrtRecipe {
  static id = 'commerce.vendors';
  static label = 'Vendors';
  static summary = 'Keep a list of the vendors and suppliers you buy from.';
  static synonyms = ['suppliers', 'sellers'];
  static models = [Vendor];
  static nav = [{ label: 'Vendors', model: Vendor }];
}

/** Customer orders. */
export class SalesRecipe extends SmrtRecipe {
  static id = 'commerce.sales';
  static label = 'Sales';
  static summary = 'Take customer orders and track them.';
  static synonyms = ['sales orders', 'orders', 'customer orders'];
  static models = [Order];
  static nav = [{ label: 'Sales Orders', model: Order }];
  static requires = ['commerce.customers'];
}

/** Orders placed with vendors. */
export class PurchasesRecipe extends SmrtRecipe {
  static id = 'commerce.purchases';
  static label = 'Purchases';
  static summary = 'Place orders with vendors and track them.';
  static synonyms = ['purchase orders', 'buying', 'procurement'];
  static models = [PurchaseOrder];
  static nav = [{ label: 'Purchase Orders', model: PurchaseOrder }];
  static requires = ['commerce.vendors'];
}
