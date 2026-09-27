/** Compatibility exports; graph algorithms are owned by the lightweight scanner. */
export {
  type BuildKnowledgeGraphOptions,
  buildKnowledgeGraph,
  checkKnowledgeGraphFreshness,
  discoverKnowledgeArtifactPaths,
  type KnowledgeGraphEdge,
  type KnowledgeGraphEdgeType,
  type KnowledgeGraphFreshnessIssue,
  type KnowledgeGraphInput,
  type KnowledgeGraphObjectNode,
  type KnowledgeGraphPackageNode,
  type SmrtKnowledgeGraph,
  stableStringify,
} from '@happyvertical/smrt-scanner/knowledge';
