/**
 * Size budgets of `@happyvertical/smrt-planner` (#5707): 0.71.0 packed to
 * 44.6 MB, almost all of it ONNX Runtime WebAssembly shipped four times. Raise
 * a budget only for content the planner needs, and say what it is in the pull
 * request. Used by the widget build (`packages/planner/scripts/build-mcp.ts`)
 * and the packed-tarball check (`verify-packed-planner.mjs`).
 */
export const PACKED_BYTES_BUDGET = 10_000_000;
export const MCP_WIDGET_BYTES_BUDGET = 5_500_000;

/**
 * Problems with the self-contained MCP widget's HTML.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function mcpWidgetProblems(html) {
  const problems = [];
  const bytes = Buffer.byteLength(html);
  if (bytes > MCP_WIDGET_BYTES_BUDGET) {
    problems.push(
      `app/mcp.html is ${bytes} bytes, over its ${MCP_WIDGET_BYTES_BUDGET} byte budget`,
    );
  }
  if (html.includes('data:application/wasm')) {
    problems.push('app/mcp.html inlines a WebAssembly binary');
  }
  return problems;
}
