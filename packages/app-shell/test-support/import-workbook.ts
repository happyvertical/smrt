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

/** A month of sales: title block, text order numbers, repeat categories/year. */
export function realisticBusinessWorkbook() {
  const customers = createSheet('Customers');
  const orders = createSheet('Orders');
  const put = (sheet: typeof orders, row: number, col: number, value: string | number) => sheet.cells.set(row, col, { value, type: typeof value === 'number' ? 'number' : 'text' });
  const names = ['Birch Café', 'Cedar Studio', 'Elm Market', 'Fir Workshop', 'Maple Bakery', 'Oak Books', 'Pine Farm', 'Willow Shop'];
  ['Name', 'Email'].forEach((v, j) => put(customers, 1, j + 1, v));
  names.forEach((name, i) => { put(customers, i + 2, 1, name); put(customers, i + 2, 2, `customer${i + 1}@example.test`); });
  put(orders, 1, 1, 'Monthly sales register');
  put(orders, 2, 1, 'October 2026');
  put(orders, 3, 1, 'All prices in CAD');
  ['Order number', 'Customer', 'Unit price', 'Quantity', 'Total', 'Status', 'Year'].forEach((v, j) => put(orders, 5, j + 1, v));
  for (let i = 0; i < 42; i++) {
    const row = i + 6, price = (1000 + i * 25) / 100, qty = i % 5 + 1;
    [`SO-${1001 + i}`, names[i % names.length], price, qty, price * qty, ['Open', 'Paid', 'Shipped'][i % 3], 2026].forEach((v, j) => put(orders, row, j + 1, v));
    orders.cells.set(row, 5, { value: price * qty, type: 'number', formula: { text: `C${row}*D${row}`, dialect: 'excel-a1', references: [], functions: [] } });
  }
  const { plan } = businessWorkbook();
  const sales = plan.tables[0];
  sales.source = { sheet: 'Orders', range: 'A5:G47', headerRow: 5 };
  sales.fields[0].reference!.columns = [2];
  sales.fields[1].column = 3;
  sales.fields[1].label = 'Unit price';
  sales.fields[2].column = 4;
  sales.fields[3].cachedColumn = 5;
  sales.fields[4].column = 6;
  sales.fields[4].choices = ['Open', 'Paid', 'Shipped'];
  sales.fields.unshift({ key: 'order_number', label: 'Order number', type: 'text', column: 1, required: true });
  sales.fields.push({ key: 'year', label: 'Year', type: 'integer', column: 7 });
  plan.tables[1].source.range = 'A1:B9';
  return { workbook: createWorkbook([customers, orders]), plan };
}
