/**
 * Browser-safe intent emitted by a project board move.
 *
 * The consuming application attaches its server-side authorization before
 * calling ProjectBoardService; no provider credential belongs in this shape.
 */
export interface ProjectBoardMoveIntent {
  projectId: string;
  itemId: string;
  status: string;
}
