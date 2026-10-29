/** Shared source convention: metadata parents contain independent originals;
 * descendants of a supported image/PDF original are its renditions. */
export const supportedIntakeOriginal = (type: string) =>
  ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(type);

export function intakeOriginalEvidence<
  T extends {
    id: string;
    parentEvidenceId: string | null;
    mediaType: string;
    partId: string;
  },
>(evidence: readonly T[]): T[] {
  const byId = new Map(evidence.map((entry) => [entry.id, entry]));
  return evidence
    .filter((entry) => {
      let parentId = entry.parentEvidenceId;
      const visited = new Set([entry.id]);
      while (parentId) {
        if (visited.has(parentId))
          throw new Error('Invalid family evidence lineage');
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) throw new Error('Incomplete family evidence lineage');
        if (supportedIntakeOriginal(parent.mediaType)) return false;
        parentId = parent.parentEvidenceId;
      }
      return true;
    })
    .sort((a, b) => a.partId.localeCompare(b.partId));
}
