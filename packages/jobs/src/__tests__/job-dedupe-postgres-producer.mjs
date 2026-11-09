/** Plain Node producer: deliberately imports built public packages, with no Vitest/source loader. */
let db;
let jobs;
let withTenant;
let config;
let phase = 'initialization';
let stopping = false;

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.connected) return reject(new Error('Parent disconnected'));
    process.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(code), 1_000);
  try { await db?.close?.(); } finally {
    clearTimeout(force);
    process.exitCode = code;
    if (process.connected) process.disconnect();
  }
}

async function fatal(error) {
  // Do not send connection strings or raw adapter messages through test output.
  try { await send({ type: 'fatal', phase, name: error?.name, code: error?.code }); }
  finally { await stop(1); }
}

const deadline = setTimeout(() => {
  void fatal(new Error('Producer deadline exceeded'));
}, 45_000);

process.on('disconnect', () => { clearTimeout(deadline); void stop(1); });
process.on('message', (message) => {
  void (async () => {
    if (message?.type === 'init' && phase === 'initialization' && !config) {
      config = message;
      const [{ getDatabase }, publicJobs, tenancy] = await Promise.all([
        import('@happyvertical/sql'),
        import('@happyvertical/smrt-jobs'),
        import('@happyvertical/smrt-tenancy'),
      ]);
      withTenant = tenancy.withTenant;
      const url = new URL(config.url);
      url.searchParams.set('application_name', config.applicationName);
      // One real SQL pool/client per producer; no test-schema interceptor in this process.
      db = await getDatabase({ type: 'postgres', url: url.toString(), max: 1 });
      await db.query("SET statement_timeout = '30s'");
      jobs = await publicJobs.SmrtJobCollection.create({ db });
      phase = 'ready';
      await send({ type: 'ready', pid: process.pid });
      return;
    }
    if (message?.type !== 'go' || phase !== 'ready') throw new Error('Invalid producer IPC state');
    phase = 'enqueue';
    const job = await withTenant({ tenantId: config.tenantId }, () => jobs.enqueueJob({
      objectType: 'DedupePostgresProbe', method: 'run', queue: config.queue,
      dedupeKey: config.dedupeKey, args: config.args,
    }));
    const result = { type: 'done', id: job.id, tenantId: job.tenantId,
      status: job.status, dedupeKey: job.dedupeKey, args: job.args };
    phase = 'close';
    await db.close();
    db = undefined;
    clearTimeout(deadline);
    await send(result);
    phase = 'done';
    await stop(0);
  })().catch(fatal);
});
