import { createSheet, createWorkbook, getSpreadsheets } from '@happyvertical/spreadsheets';
import type { ImportPlan } from '@happyvertical/smrt-spreadsheets/import';

/** Generated fixture: messy header, relationship, money, choices, cached calculation. */
export function businessWorkbook(badCell = false, badCache = false) {
  const customers = createSheet('Customers');
  const orders = createSheet('Orders');
  const put = (sheet: typeof orders, row: number, col: number, value: string | number) => sheet.cells.set(row, col, { value, type: typeof value === 'number' ? 'number' : 'text' });
  [['Name', 'Email'], ['Ada', 'ada@example.test'], ['Grace', 'grace@example.test']].forEach((r, i) => r.forEach((v, j) => put(customers, i + 1, j + 1, v)));
  put(orders, 1, 1, 'Small business orders');
  ['Customer', 'Price', 'Quantity', 'Total', 'Status'].forEach((v, j) => put(orders, 3, j + 1, v));
  [['Ada', 12.5, 2, 25, 'Paid'], ['Grace', 5, 3, 15, 'Open']].forEach((r, i) => r.forEach((v, j) => put(orders, i + 4, j + 1, v)));
  for (const r of [4, 5]) orders.cells.set(r, 4, { value: badCache && r === 4 ? 99 : r === 4 ? 25 : 15, type: 'number', formula: { text: `B${r}*C${r}`, dialect: 'excel-a1', references: [], functions: [] } });
  if (badCell) orders.cells.set(4, 2, { value: null, type: 'error', error: '#VALUE!' });
  const plan: ImportPlan = { version: 1, reports: [{ key: 'sales', label: 'Sales by status', spec: { version: 1, title: 'Sales by status', source: 'orders', dimensions: [{ field: 'status', as: 'status' }], measures: [{ fn: 'sum', field: 'total', as: 'revenue' }] } }], tables: [
    { key: 'orders', label: 'Orders', source: { sheet: 'Orders', range: 'A3:E5', headerRow: 3 }, fields: [
      { key: 'customer', label: 'Customer', type: 'reference', reference: { table: 'customers', by: ['name'], columns: [1] } },
      { key: 'price', label: 'Price', type: 'money', column: 2, money: { currency: 'CAD', scale: 2 } },
      { key: 'quantity', label: 'Quantity', type: 'integer', column: 3 },
      { key: 'total', label: 'Total', type: 'money', money: { currency: 'CAD', scale: 2 }, cachedColumn: 4, calculated: { op: 'mul', left: { col: 'price' }, right: { col: 'quantity' } } },
      { key: 'status', label: 'Status', type: 'choice', choices: ['Open', 'Paid'], column: 5 },
    ] },
    { key: 'customers', label: 'Customers', source: { sheet: 'Customers', range: 'A1:B3', headerRow: 1 }, lookupKey: ['name'], titleField: 'name', fields: [
      { key: 'name', label: 'Name', type: 'text', column: 1, required: true },
      { key: 'email', label: 'Email', type: 'text', column: 2 },
    ] },
  ] };
  return { workbook: createWorkbook([customers, orders]), plan };
}
export async function businessBytes(badCell = false, badCache = false) {
  return (await getSpreadsheets({ type: 'xlsx' })).write(businessWorkbook(badCell, badCache).workbook);
}
