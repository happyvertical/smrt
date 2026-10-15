import { getDatabase } from '@happyvertical/sql';
const db = await getDatabase({ type: 'sqlite', url: '/tmp/claude-probe.db' });
console.log('root url', db.url, Object.keys(db).slice(0,30));
await db.transaction(async (tx) => { console.log('tx url', tx.url, tx === db, Object.keys(tx).slice(0,30)); });
const t = await db.beginTransaction(); console.log('begin url', t.url, Object.keys(t).slice(0,30)); await t.rollback();
await db.close?.();
