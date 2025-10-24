import { getAI } from '@happyvertical/ai';
import type { PackageMetadata } from '../registry.js';
import { getPackagesByNames, routeQuery } from '../router.js';

/**
 * Ask tool input schema
 */
export interface AskInput {
  query: string;
  packages?: string[];
}

/**
 * Get AI client instance
 * Uses environment variables for configuration (HAVE_AI_*)
 */
async function getAIClient() {
  try {
    // Try to get AI client from environment configuration
    return await getAI({});
  } catch (error) {
    throw new Error(
      `AI client initialization failed. Please configure AI provider using HAVE_AI_* environment variables. Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build context from package CLAUDE.md files
 */
function buildContext(packages: PackageMetadata[]): string {
  if (packages.length === 0) {
    return 'No relevant packages found.';
  }

  const contextParts: string[] = [];

  for (const pkg of packages) {
    contextParts.push(
      `## Package: @happyvertical/smrt-${pkg.name}\n\n${pkg.claudeMd}\n\n---\n`,
    );
  }

  return contextParts.join('\n');
}

/**
 * Ask tool - Routes queries to package experts and synthesizes responses
 *
 * @param input - Query and optional package list
 * @returns AI-generated response based on package documentation
 */
export async function ask(input: AskInput) {
  const { query, packages: requestedPackages } = input;

  try {
    // Determine which packages to consult
    let packages: PackageMetadata[];

    if (requestedPackages && requestedPackages.length > 0) {
      // User specified packages
      packages = await getPackagesByNames(requestedPackages);

      if (packages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `None of the requested packages (${requestedPackages.join(', ')}) were found. Use list-packages to see available packages.`,
            },
          ],
          isError: true,
        };
      }
    } else {
      // Auto-route based on query
      const matches = await routeQuery(query);

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No relevant packages found for query: "${query}". Try using list-packages to browse available packages or specify packages explicitly.`,
            },
          ],
          isError: false,
        };
      }

      // Take top 3 matches
      packages = matches.slice(0, 3).map((m) => m.package);
    }

    // Build context from CLAUDE.md files
    const context = buildContext(packages);

    // Get AI client
    const ai = await getAIClient();

    // Generate response using AI with expert context
    const systemPrompt = `You are an expert SMRT framework documentation assistant.
You have access to the full documentation (CLAUDE.md files) for the following packages: ${packages.map((p) => `@happyvertical/smrt-${p.name}`).join(', ')}.

Your role is to:
1. Answer questions about the SMRT framework using the provided package documentation
2. Provide code examples when relevant
3. Reference specific packages and documentation sections
4. Be concise but thorough
5. Include package names in your response (e.g., "@happyvertical/smrt-core", "@happyvertical/smrt-agents")

Use the documentation provided below to answer the user's question accurately.

---
${context}
---`;

    const response = await ai.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: query },
      ],
      {
        temperature: 0.7,
        maxTokens: 2000,
      },
    );

    // Build response with package references
    const packageList = packages
      .map((p) => `@happyvertical/smrt-${p.name}`)
      .join(', ');
    const footer = `\n\n---\n*Consulted packages: ${packageList}*`;

    return {
      content: [
        {
          type: 'text',
          text: response.content + footer,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error processing query: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
