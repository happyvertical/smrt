import { BudgetLedger, runReservedCall } from './budget.mjs';

const ledger = new BudgetLedger(process.argv[2]);
try {
  await runReservedCall(
    ledger,
    {
      id: process.argv[4] ?? `child-${process.argv[3]}`,
      requestHash: 'a'.repeat(64),
      runHash: 'b'.repeat(64),
      stage: 'concurrency-test',
      maximumCharge: 1_000_000_000,
    },
    async () => {
      process.send('invoked');
      return {};
    },
  );
} catch (error) {
  if (
    !error.message.includes('exhausted') &&
    !error.message.includes('already reserved')
  )
    throw error;
  process.send('denied');
} finally {
  ledger.close();
}
