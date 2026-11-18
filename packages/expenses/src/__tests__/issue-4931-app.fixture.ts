/** Loaded after package models, with their existing physical tables. */
import { smrt } from '@happyvertical/smrt-core';
import {
  ExpenseAllocationBilling as BaseExpenseAllocationBilling,
  ExpenseAllocationPortion as BaseExpenseAllocationPortion,
  ExpenseAllocationRevision as BaseExpenseAllocationRevision,
} from '../models/ExpenseAllocation.js';
@smrt({
  replaceParent: true,
  packageName: '@local/issue4931-expenses',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  tableName: 'expense_allocation_revisions',
})
export class ExpenseAllocationRevision extends BaseExpenseAllocationRevision {}
@smrt({
  replaceParent: true,
  packageName: '@local/issue4931-expenses',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  tableName: 'expense_allocation_portions',
})
export class ExpenseAllocationPortion extends BaseExpenseAllocationPortion {}
@smrt({
  replaceParent: true,
  packageName: '@local/issue4931-expenses',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  tableName: 'expense_allocation_billings',
})
export class ExpenseAllocationBilling extends BaseExpenseAllocationBilling {}
