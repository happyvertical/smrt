/** Stable UUID identities make tenant tax bootstrap retry and race safe. */
export async function deterministicTaxId(
  tenantId: string,
  kind: 'code' | 'component' | 'settings' | 'report',
  key: string,
): Promise<string> {
  if (!tenantId.trim() || !key.trim())
    throw new Error('Tax bootstrap identity requires tenant and key');
  const bytes = new TextEncoder().encode(
    JSON.stringify(['commerce-tax', tenantId, kind, key]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = Array.from(uuid, (byte) => byte.toString(16).padStart(2, '0'));
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** A racing deterministic insert loses safely and reloads the committed row. */
export async function createOrLoadTaxSeed<T>(
  create: () => Promise<T>,
  load: () => Promise<T | null | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await create();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'RUNTIME_REVISION_CONFLICT' && attempt < 2) continue;
      if (code !== 'VALIDATION_UNIQUE_CONSTRAINT' && code !== '23505')
        throw error;
      const winner = await load();
      if (!winner) throw error;
      return winner;
    }
  }
  throw new Error('Tax seed retry exhausted');
}
