import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
const partitions = ['train', 'development', 'heldout'];
const classes = ['draft', 'attachment', 'abstain'];
function fail(message) {
  throw new Error(`Invalid corpus: ${message}`);
}
function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const REQUIRED_HELDOUT_SUBTYPES = [
  'unknown_category',
  'ambiguous_entity',
  'unreadable',
  'prompt_injection',
  'confidential_scope',
];
export function validateCorpus(
  manifest,
  root,
  { requireHeldoutCoverage = false } = {},
) {
  if (
    !text(manifest.version) ||
    !Array.isArray(manifest.cases) ||
    !manifest.cases.length
  )
    fail('version/cases');
  const ids = new Set();
  const hashes = new Map();
  const families = new Map();
  const familyClasses = new Map();
  const counts = Object.fromEntries(partitions.map((key) => [key, 0]));
  const heldout = Object.fromEntries(classes.map((key) => [key, 0]));
  const heldoutSubtypes = Object.fromEntries(
    REQUIRED_HELDOUT_SUBTYPES.map((key) => [key, 0]),
  );
  const realRoot = realpathSync(root);
  for (const item of manifest.cases) {
    if (!text(item.id) || ids.has(item.id)) fail('duplicate/missing id');
    ids.add(item.id);
    if (
      !text(item.group) ||
      !partitions.includes(item.partition) ||
      !classes.includes(item.category)
    )
      fail('group/partition/category');
    if (families.has(item.group) && families.get(item.group) !== item.partition)
      fail('template family split leakage');
    families.set(item.group, item.partition);
    if (
      familyClasses.has(item.group) &&
      familyClasses.get(item.group) !== item.category
    )
      fail('template family crosses action classes');
    familyClasses.set(item.group, item.category);
    if (
      !text(item.provenance?.author) ||
      !text(item.provenance?.generator) ||
      !text(item.provenance?.annotation) ||
      !text(item.provenance?.adjudication)
    )
      fail('provenance');
    if (!Array.isArray(item.sources) || !item.sources.length)
      fail('missing source');
    for (const source of item.sources) {
      if (!text(source.path) || isAbsolute(source.path)) fail('source path');
      const path = realpathSync(resolve(realRoot, source.path));
      const rel = relative(realRoot, path);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        fail('source escapes corpus');
      const bytes = readFileSync(path);
      if (sha256(bytes) !== source.sha256 || bytes.length !== source.byteLength)
        fail('source hash/length mismatch');
      if (!text(source.mediaType)) fail('source media type');
      if (
        hashes.has(source.sha256) &&
        hashes.get(source.sha256) !== item.partition
      )
        fail('identical source split leakage');
      hashes.set(source.sha256, item.partition);
    }
    if (typeof item.supported !== 'boolean' || !Array.isArray(item.expected))
      fail('expected labels');
    if (item.category === 'abstain') {
      if (item.expected.length || !text(item.abstainReason))
        fail('abstention label');
    } else {
      if (!item.supported || !item.expected.length) fail('actionable label');
      for (const action of item.expected) {
        if (
          action.kind !== item.category ||
          !text(action.handler) ||
          !object(action.fields)
        )
          fail('action label');
        if (
          action.kind === 'draft' &&
          (!text(action.fields.title) || typeof action.fields.body !== 'string')
        )
          fail('required draft fields');
        if (
          action.kind === 'attachment' &&
          (!text(action.target) ||
            action.fields.contentId !== action.target ||
            !text(action.fields.evidenceId))
        )
          fail('attachment target/fields');
      }
    }
    if (requireHeldoutCoverage && item.coverage?.includes('ambiguous_entity')) {
      if (
        !Array.isArray(item.candidates) ||
        item.candidates.length < 2 ||
        new Set(item.candidates.map((candidate) => candidate.id)).size !==
          item.candidates.length ||
        new Set(item.candidates.map((candidate) => candidate.title)).size !== 1
      )
        fail('ambiguous case lacks actual distinct same-title candidates');
    }
    if (
      requireHeldoutCoverage &&
      item.coverage?.includes('confidential_scope')
    ) {
      const hidden = item.fixtureContext?.hiddenTargets;
      if (
        !Array.isArray(hidden) ||
        !hidden.some(
          (target) => target.visibility === 'different-confidential-scope',
        ) ||
        hidden.some((target) =>
          item.candidates?.some((candidate) => candidate.id === target.id),
        )
      )
        fail('confidential case lacks isolated hidden target');
    }
    if (
      requireHeldoutCoverage &&
      item.coverage?.includes('unreadable') &&
      (item.lane !== 'deterministic-fault' ||
        item.systemAbstentionReason !== 'corrupt_source')
    )
      fail('unreadable case lacks explicit fault lane');
    counts[item.partition]++;
    if (item.partition === 'heldout') {
      heldout[item.category]++;
      for (const subtype of new Set(item.coverage ?? []))
        if (Object.hasOwn(heldoutSubtypes, subtype)) heldoutSubtypes[subtype]++;
    }
  }
  const total = manifest.cases.length;
  if (
    counts.train * 5 !== total * 3 ||
    counts.development * 5 !== total ||
    counts.heldout * 5 !== total
  )
    fail('case split is not 60/20/20');
  const heldoutCoverageMet = REQUIRED_HELDOUT_SUBTYPES.every(
    (key) => heldoutSubtypes[key] > 0,
  );
  if (requireHeldoutCoverage && !heldoutCoverageMet)
    fail('required heldout subtype missing');
  return {
    heldoutSubtypes,
    heldoutCoverageMet,
    total,
    counts,
    heldout,
    groups: families.size,
    minimumHeldoutMet: classes.every((category) => heldout[category] >= 100),
  };
}
