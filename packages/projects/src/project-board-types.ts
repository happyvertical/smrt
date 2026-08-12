/**
 * Browser-safe project-board move payload.
 *
 * This is the only board mutation data permitted to cross the browser/server
 * boundary. Authorization and provider access are established server-side.
 */
export interface ProjectBoardMoveIntent {
  projectId: string;
  itemId: string;
  status: string;
}
