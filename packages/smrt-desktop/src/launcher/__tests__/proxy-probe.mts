// Child process for loopback-fetch.test.ts. Started with NODE_USE_ENV_PROXY=1
// so global fetch is routed through HTTP_PROXY; reports what each transport
// reached.
import { loopbackFetch } from '../loopback-fetch.js';

const origin = process.env.PROBE_ORIGIN as string;
const init = {
  method: 'POST',
  headers: { authorization: 'Bearer probe-secret' },
  body: '{}',
};
const result: Record<string, unknown> = {};
const direct = await loopbackFetch(`${origin}/api/mcp`, init);
result.direct = direct.status;
await direct.body?.cancel();
try {
  const control = await fetch(`${origin}/api/mcp`, init);
  result.control = control.status;
  await control.body?.cancel();
} catch (error) {
  result.control = `error: ${(error as Error).message}`;
}
process.stdout.write(JSON.stringify(result));
