export {
  AGENT_SURFACE_HASH_PREFIX,
  discoverScopedPackageDirectories,
  MODULE_DOC_HASH_PREFIX,
  readAgentModuleDocs,
  readPackageAgentDoc,
  resolveAgentModuleDocPaths,
  type ScopedPackageDirectory,
} from './knowledge-discovery.js';
export {
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
} from './knowledge-graph.js';
