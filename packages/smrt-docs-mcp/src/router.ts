import { getAllPackages, type PackageMetadata } from './registry.js';

/**
 * Package match with confidence score
 */
export interface PackageMatch {
  package: PackageMetadata;
  score: number;
  matchedKeywords: string[];
}

/**
 * Extract keywords from query text
 * Converts to lowercase and splits on word boundaries
 */
function extractQueryKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2); // Ignore very short words
}

/**
 * Calculate relevance score for a package based on keyword matches
 */
function calculateScore(
  queryKeywords: string[],
  packageKeywords: string[],
): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;

  for (const queryKeyword of queryKeywords) {
    for (const packageKeyword of packageKeywords) {
      // Exact match
      if (queryKeyword === packageKeyword) {
        score += 10;
        matched.push(packageKeyword);
      }
      // Partial match (query keyword contains package keyword or vice versa)
      else if (
        queryKeyword.includes(packageKeyword) ||
        packageKeyword.includes(queryKeyword)
      ) {
        score += 5;
        if (!matched.includes(packageKeyword)) {
          matched.push(packageKeyword);
        }
      }
    }
  }

  // Bonus points for package name match
  for (const queryKeyword of queryKeywords) {
    if (packageKeywords.some((pkg) => pkg.toLowerCase() === queryKeyword)) {
      score += 15;
    }
  }

  return { score, matched };
}

/**
 * Route query to relevant packages based on keyword matching
 * Returns packages sorted by relevance score
 *
 * @param query - User query string
 * @param minScore - Minimum score threshold for including a package (default: 5)
 * @returns Array of package matches sorted by score (descending)
 */
export async function routeQuery(
  query: string,
  minScore: number = 5,
): Promise<PackageMatch[]> {
  const packages = await getAllPackages();
  const queryKeywords = extractQueryKeywords(query);

  const matches: PackageMatch[] = [];

  for (const pkg of packages) {
    const { score, matched } = calculateScore(queryKeywords, pkg.keywords);

    if (score >= minScore) {
      matches.push({
        package: pkg,
        score,
        matchedKeywords: matched,
      });
    }
  }

  // Sort by score descending
  matches.sort((a, b) => b.score - a.score);

  return matches;
}

/**
 * Get packages by names
 * Useful when user explicitly specifies packages
 */
export async function getPackagesByNames(
  names: string[],
): Promise<PackageMetadata[]> {
  const packages = await getAllPackages();
  const nameSet = new Set(names.map((n) => n.toLowerCase()));

  return packages.filter((pkg) => nameSet.has(pkg.name.toLowerCase()));
}

/**
 * Get top N packages for a query
 */
export async function getTopPackages(
  query: string,
  limit: number = 3,
): Promise<PackageMatch[]> {
  const matches = await routeQuery(query);
  return matches.slice(0, limit);
}
