/** Resolve server hashing only when called; recipe/model roots remain browser-safe. */
export function groupSharingDigest(value: string | Uint8Array): string {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto)
    throw new Error('Group sharing operations require a Node server');
  return crypto.createHash('sha256').update(value).digest('hex');
}
