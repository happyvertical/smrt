/** Development preview binding: a single Kitchen plan and loopback bridge. */
export interface LiveKitchenBinding {
  planId: string;
  port: number;
}
const KEY = 'smrt-planner:live-kitchen:v1';
const PLAN_ID = /^plan-[a-f0-9-]{8,36}$/;

function valid(value: unknown): value is LiveKitchenBinding {
  const binding = value as LiveKitchenBinding | null;
  return (
    !!binding &&
    PLAN_ID.test(binding.planId) &&
    Number.isInteger(binding.port) &&
    binding.port > 0 &&
    binding.port <= 65535
  );
}

export function liveKitchenBinding(search: string): LiveKitchenBinding | null {
  const params = new URLSearchParams(search);
  const planId = params.get('kitchenPlan');
  const port = Number(params.get('kitchenPort'));
  const fromUrl = { planId, port };
  if (valid(fromUrl)) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(fromUrl));
    } catch {
      /* URL still binds this tab. */
    }
    return fromUrl;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as unknown;
    return valid(saved) ? saved : null;
  } catch {
    return null;
  }
}

export async function callLiveKitchen(
  binding: LiveKitchenBinding,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (args.planId !== binding.planId)
    throw new Error('Preview plan id changed.');
  const root = `http://127.0.0.1:${binding.port}/plans/${binding.planId}`;
  const response =
    name === 'get_plan'
      ? await fetch(root, { cache: 'no-store' })
      : name === 'run_commands'
        ? await fetch(`${root}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
          })
        : null;
  if (!response) throw new Error(`Preview tool ${name} is unavailable.`);
  if (!response.ok)
    throw new Error(`Kitchen preview answered ${response.status}.`);
  return response.json() as Promise<unknown>;
}
