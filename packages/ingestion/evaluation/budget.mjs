import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Integer nano-USD. This ceiling covers the whole account evaluation, all stages. */
export const TOTAL_CAP = 5_000_000_000;
const digest = /^[a-f0-9]{64}$/;
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`Invalid ${name}`);
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value))
    throw new Error('Invalid call identity');
  return value;
}
function hash(value) {
  if (typeof value !== 'string' || !digest.test(value))
    throw new Error('Invalid immutable digest');
  return value;
}

/** Caller must establish token/media bounds from the actual owning provider contract. */
export function tokenChargeBound({
  inputTokens,
  outputTokens,
  inputNanoUSD,
  outputNanoUSD,
}) {
  const result =
    BigInt(integer(inputTokens, 'input tokens')) *
      BigInt(integer(inputNanoUSD, 'input rate', 1)) +
    BigInt(integer(outputTokens, 'output tokens')) *
      BigInt(integer(outputNanoUSD, 'output rate', 1));
  if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Unsupported charge bound');
  return Number(result);
}

/** Standalone evaluation artifact, never an application database or SMRT model. */
export class BudgetLedger {
  constructor(path) {
    if (path === ':memory:' || !path)
      throw new Error('Persistent ledger required');
    mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(path), { timeout: 10000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS budget (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        ceiling INTEGER NOT NULL CHECK(ceiling=${TOTAL_CAP}),
        halted INTEGER NOT NULL CHECK(halted IN (0,1))
      );
      INSERT OR IGNORE INTO budget VALUES(1,${TOTAL_CAP},0);
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, run_hash TEXT NOT NULL,
        stage TEXT NOT NULL, bound INTEGER NOT NULL CHECK(bound>0),
        charged INTEGER NOT NULL CHECK(charged>=0 AND charged<=bound),
        state TEXT NOT NULL CHECK(state IN ('reserved','settled','unknown','overrun')),
        observed_charge INTEGER CHECK(observed_charge>=0),
        failure TEXT CHECK(failure IS NULL OR failure='charge_bound_exceeded')
      );`);
    const ceiling = this.db
      .prepare('SELECT ceiling FROM budget WHERE singleton=1')
      .get();
    if (ceiling?.ceiling !== TOTAL_CAP)
      throw new Error('Budget ceiling mismatch');
  }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  snapshot() {
    const rows = this.db.prepare('SELECT * FROM calls ORDER BY id').all();
    const charged = rows.reduce((sum, row) => sum + row.charged, 0);
    if (!Number.isSafeInteger(charged) || charged > TOTAL_CAP)
      throw new Error('Corrupt aggregate budget');
    const halted = Boolean(
      this.db.prepare('SELECT halted FROM budget WHERE singleton=1').get()
        .halted,
    );
    return {
      halted,
      ceiling: TOTAL_CAP,
      charged,
      remaining: halted ? 0 : TOTAL_CAP - charged,
      // Decimal strings avoid losing exactness if an external overrun is enormous.
      observedActualNanoUSD: rows
        .reduce((sum, row) => sum + BigInt(row.observed_charge ?? 0), 0n)
        .toString(),
      accountedExposureNanoUSD: rows
        .reduce(
          (sum, row) =>
            sum + BigInt(Math.max(row.charged, row.observed_charge ?? 0)),
          0n,
        )
        .toString(),
      unknownChargeCalls: rows.filter((row) => row.observed_charge === null)
        .length,
      calls: rows,
    };
  }
  reserve({ id, requestHash, runHash, stage, maximumCharge }) {
    identifier(id);
    hash(requestHash);
    hash(runHash);
    identifier(stage);
    integer(maximumCharge, 'maximum charge', 1);
    return this.transaction(() => {
      // Even an identical retry must not execute again after a process crash.
      if (
        this.db.prepare('SELECT halted FROM budget WHERE singleton=1').get()
          .halted
      )
        throw new Error('Evaluation budget halted');
      if (this.db.prepare('SELECT id FROM calls WHERE id=?').get(id))
        throw new Error('Call already reserved; remote outcome may be unknown');
      if (maximumCharge > this.snapshot().remaining)
        throw new Error('Aggregate evaluation budget exhausted');
      this.db
        .prepare('INSERT INTO calls VALUES(?,?,?,?,?,?,?,NULL,NULL)')
        .run(
          id,
          requestHash,
          runHash,
          stage,
          maximumCharge,
          maximumCharge,
          'reserved',
        );
      return { id, maximumCharge };
    });
  }
  settle(id, actualCharge) {
    identifier(id);
    integer(actualCharge, 'actual charge');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);
      if (row?.state !== 'reserved') throw new Error('Call not unsettled');
      if (actualCharge > row.bound) {
        this.db.prepare('UPDATE budget SET halted=1 WHERE singleton=1').run();
        this.db
          .prepare(
            "UPDATE calls SET observed_charge=?,state='overrun',failure='charge_bound_exceeded' WHERE id=?",
          )
          .run(actualCharge, id);
        return false;
      }
      this.db
        .prepare(
          "UPDATE calls SET charged=?,observed_charge=?,state='settled' WHERE id=?",
        )
        .run(actualCharge, actualCharge, id);
      return true;
    });
  }
  unknown(id) {
    identifier(id);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM calls WHERE id=?').get(id);
      if (row?.state !== 'reserved') throw new Error('Call not unsettled');
      this.db.prepare("UPDATE calls SET state='unknown' WHERE id=?").run(id);
    });
  }
  close() {
    this.db.close();
  }
}

/** One callback invocation, no retries. No network adapter is supplied by this module.
 * Only a trusted adapter may supply a final trustworthy charge; unknown retains all.
 */
export async function runReservedCall(ledger, request, invoke) {
  const id = request.id;
  ledger.reserve(request);
  let response;
  try {
    response = await invoke();
  } catch (error) {
    ledger.unknown(id);
    throw error;
  }
  if (response?.charge?.kind === 'verified-final') {
    if (!ledger.settle(id, response.charge.nanoUSD))
      throw new Error('Provider exceeded reserved bound; evaluation halted');
  } else {
    ledger.unknown(id);
  }
  return response;
}
