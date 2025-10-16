// ../../vite.config.base.ts
import { resolve } from "node:path";
import { defineConfig } from "file:///Users/will/Work/happyvertical/repos/smrt/node_modules/.pnpm/vite@7.1.7_@types+node@24.0.0_jiti@2.6.1_tsx@4.20.6_yaml@2.8.1/node_modules/vite/dist/node/index.js";
import dts from "file:///Users/will/Work/happyvertical/repos/smrt/node_modules/.pnpm/vite-plugin-dts@4.5.4_@types+node@24.0.0_rollup@4.52.4_typescript@5.9.3_vite@7.1.7_@types+nod_qzspapd4yrvkg234hurj4rojq4/node_modules/vite-plugin-dts/dist/index.mjs";
var __vite_injected_original_dirname = "/Users/will/Work/happyvertical/repos/smrt";
function createPackageConfig(packageName) {
  const packageDir = resolve(__vite_injected_original_dirname, "packages", packageName);
  return defineConfig({
    build: {
      lib: {
        entry: resolve(packageDir, "src/index.ts"),
        formats: ["es"],
        fileName: () => "index.js"
      },
      rollupOptions: {
        output: {
          dir: resolve(packageDir, "dist"),
          format: "es",
          preserveModules: false,
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js"
        },
        external: [
          // Node.js built-ins - externalize completely
          /^node:/,
          /^bun:/,
          "fs",
          "path",
          "url",
          "os",
          "crypto",
          "stream",
          "util",
          "events",
          "child_process",
          "buffer",
          "Buffer",
          "zlib",
          "assert",
          "http",
          "https",
          "net",
          "tls",
          "dns",
          "cluster",
          "worker_threads",
          "perf_hooks",
          "readline",
          "repl",
          "vm",
          "v8",
          "inspector",
          // External dependencies - don't bundle these
          "cheerio",
          "crawlee",
          "puppeteer",
          "playwright",
          "playwright-core",
          "sqlite3",
          "better-sqlite3",
          "pg",
          "mysql2",
          "typeorm",
          "prisma",
          "@prisma/client",
          "sharp",
          "canvas",
          "pdf-parse",
          "pdf2pic",
          "tesseract.js",
          "openai",
          /^openai\//,
          "anthropic",
          "@anthropic-ai/sdk",
          "@google/generative-ai",
          "@google/genai",
          "@aws-sdk/client-bedrock-runtime",
          "@langchain/core",
          "@langchain/openai",
          "@langchain/anthropic",
          "@langchain/community",
          "date-fns",
          "pluralize",
          "uuid",
          "@paralleldrive/cuid2",
          "yaml",
          "jsdom",
          "happy-dom",
          "axios",
          "node-fetch",
          "express",
          "cors",
          "dotenv",
          "typescript",
          "@googlemaps/google-maps-services-js",
          "@google-cloud/translate",
          "deepl-node",
          "redis",
          "@modelcontextprotocol/sdk",
          /^@modelcontextprotocol\//,
          "undici",
          "unpdf",
          "pngjs",
          "jpeg-js",
          "@gutenye/ocr-node",
          "cosmiconfig",
          "@libsql/client",
          // Internal SMRT packages - externalize to avoid cross-package bundling
          /^@smrt\//,
          // External SDK packages
          /^@have\//,
          // Virtual modules from SMRT framework
          "@smrt/routes",
          "@smrt/client",
          "@smrt/mcp",
          "@smrt/manifest"
        ]
      },
      minify: false,
      // Keep code readable for library usage
      sourcemap: true,
      target: "es2022",
      reportCompressedSize: false
      // Speed up build
    },
    plugins: [
      dts({
        outDir: resolve(packageDir, "dist"),
        include: [resolve(packageDir, "src/**/*.ts")],
        exclude: [
          // Test files
          "**/*.test.ts",
          "**/*.spec.ts",
          "**/*.test.*.ts",
          // Config files
          "**/*.config.ts",
          "**/*.config.js",
          // Declaration files
          "**/*.d.ts"
        ],
        insertTypesEntry: false,
        // We handle this in package.json
        rollupTypes: false,
        // Use package-specific tsconfig
        tsconfigPath: resolve(packageDir, "tsconfig.json")
      })
    ]
  });
}

// vite.config.ts
var vite_config_default = createPackageConfig("agents");
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vdml0ZS5jb25maWcuYmFzZS50cyIsICJ2aXRlLmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9Vc2Vycy93aWxsL1dvcmsvaGFwcHl2ZXJ0aWNhbC9yZXBvcy9zbXJ0XCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvd2lsbC9Xb3JrL2hhcHB5dmVydGljYWwvcmVwb3Mvc21ydC92aXRlLmNvbmZpZy5iYXNlLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9Vc2Vycy93aWxsL1dvcmsvaGFwcHl2ZXJ0aWNhbC9yZXBvcy9zbXJ0L3ZpdGUuY29uZmlnLmJhc2UudHNcIjtpbXBvcnQgeyByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcbmltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IGR0cyBmcm9tICd2aXRlLXBsdWdpbi1kdHMnO1xuXG4vKipcbiAqIFNoYXJlZCBWaXRlIGNvbmZpZ3VyYXRpb24gZmFjdG9yeSBmb3IgYWxsIFNNUlQgcGFja2FnZXNcbiAqXG4gKiBDcmVhdGVzIGEgc3RhbmRhcmRpemVkIGJ1aWxkIGNvbmZpZ3VyYXRpb24gZm9yIE5vZGUuanMtb25seSBwYWNrYWdlc1xuICogd2l0aCBUeXBlU2NyaXB0IGRlY2xhcmF0aW9uIGdlbmVyYXRpb24uXG4gKlxuICogQWRhcHRlZCBmcm9tIEBoYXZlL3NkayB2aXRlLmNvbmZpZy5iYXNlLnRzIHBhdHRlcm4gKFBSIDIzOClcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVBhY2thZ2VDb25maWcocGFja2FnZU5hbWU6IHN0cmluZykge1xuICBjb25zdCBwYWNrYWdlRGlyID0gcmVzb2x2ZShfX2Rpcm5hbWUsICdwYWNrYWdlcycsIHBhY2thZ2VOYW1lKTtcblxuICByZXR1cm4gZGVmaW5lQ29uZmlnKHtcbiAgICBidWlsZDoge1xuICAgICAgbGliOiB7XG4gICAgICAgIGVudHJ5OiByZXNvbHZlKHBhY2thZ2VEaXIsICdzcmMvaW5kZXgudHMnKSxcbiAgICAgICAgZm9ybWF0czogWydlcyddIGFzIGNvbnN0LFxuICAgICAgICBmaWxlTmFtZTogKCkgPT4gJ2luZGV4LmpzJyxcbiAgICAgIH0sXG4gICAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICAgIG91dHB1dDoge1xuICAgICAgICAgIGRpcjogcmVzb2x2ZShwYWNrYWdlRGlyLCAnZGlzdCcpLFxuICAgICAgICAgIGZvcm1hdDogJ2VzJyBhcyBjb25zdCxcbiAgICAgICAgICBwcmVzZXJ2ZU1vZHVsZXM6IGZhbHNlLFxuICAgICAgICAgIGVudHJ5RmlsZU5hbWVzOiAnW25hbWVdLmpzJyxcbiAgICAgICAgICBjaHVua0ZpbGVOYW1lczogJ2NodW5rcy9bbmFtZV0tW2hhc2hdLmpzJyxcbiAgICAgICAgfSxcbiAgICAgICAgZXh0ZXJuYWw6IFtcbiAgICAgICAgICAvLyBOb2RlLmpzIGJ1aWx0LWlucyAtIGV4dGVybmFsaXplIGNvbXBsZXRlbHlcbiAgICAgICAgICAvXm5vZGU6LyxcbiAgICAgICAgICAvXmJ1bjovLFxuICAgICAgICAgICdmcycsXG4gICAgICAgICAgJ3BhdGgnLFxuICAgICAgICAgICd1cmwnLFxuICAgICAgICAgICdvcycsXG4gICAgICAgICAgJ2NyeXB0bycsXG4gICAgICAgICAgJ3N0cmVhbScsXG4gICAgICAgICAgJ3V0aWwnLFxuICAgICAgICAgICdldmVudHMnLFxuICAgICAgICAgICdjaGlsZF9wcm9jZXNzJyxcbiAgICAgICAgICAnYnVmZmVyJyxcbiAgICAgICAgICAnQnVmZmVyJyxcbiAgICAgICAgICAnemxpYicsXG4gICAgICAgICAgJ2Fzc2VydCcsXG4gICAgICAgICAgJ2h0dHAnLFxuICAgICAgICAgICdodHRwcycsXG4gICAgICAgICAgJ25ldCcsXG4gICAgICAgICAgJ3RscycsXG4gICAgICAgICAgJ2RucycsXG4gICAgICAgICAgJ2NsdXN0ZXInLFxuICAgICAgICAgICd3b3JrZXJfdGhyZWFkcycsXG4gICAgICAgICAgJ3BlcmZfaG9va3MnLFxuICAgICAgICAgICdyZWFkbGluZScsXG4gICAgICAgICAgJ3JlcGwnLFxuICAgICAgICAgICd2bScsXG4gICAgICAgICAgJ3Y4JyxcbiAgICAgICAgICAnaW5zcGVjdG9yJyxcblxuICAgICAgICAgIC8vIEV4dGVybmFsIGRlcGVuZGVuY2llcyAtIGRvbid0IGJ1bmRsZSB0aGVzZVxuICAgICAgICAgICdjaGVlcmlvJyxcbiAgICAgICAgICAnY3Jhd2xlZScsXG4gICAgICAgICAgJ3B1cHBldGVlcicsXG4gICAgICAgICAgJ3BsYXl3cmlnaHQnLFxuICAgICAgICAgICdwbGF5d3JpZ2h0LWNvcmUnLFxuICAgICAgICAgICdzcWxpdGUzJyxcbiAgICAgICAgICAnYmV0dGVyLXNxbGl0ZTMnLFxuICAgICAgICAgICdwZycsXG4gICAgICAgICAgJ215c3FsMicsXG4gICAgICAgICAgJ3R5cGVvcm0nLFxuICAgICAgICAgICdwcmlzbWEnLFxuICAgICAgICAgICdAcHJpc21hL2NsaWVudCcsXG4gICAgICAgICAgJ3NoYXJwJyxcbiAgICAgICAgICAnY2FudmFzJyxcbiAgICAgICAgICAncGRmLXBhcnNlJyxcbiAgICAgICAgICAncGRmMnBpYycsXG4gICAgICAgICAgJ3Rlc3NlcmFjdC5qcycsXG4gICAgICAgICAgJ29wZW5haScsXG4gICAgICAgICAgL15vcGVuYWlcXC8vLFxuICAgICAgICAgICdhbnRocm9waWMnLFxuICAgICAgICAgICdAYW50aHJvcGljLWFpL3NkaycsXG4gICAgICAgICAgJ0Bnb29nbGUvZ2VuZXJhdGl2ZS1haScsXG4gICAgICAgICAgJ0Bnb29nbGUvZ2VuYWknLFxuICAgICAgICAgICdAYXdzLXNkay9jbGllbnQtYmVkcm9jay1ydW50aW1lJyxcbiAgICAgICAgICAnQGxhbmdjaGFpbi9jb3JlJyxcbiAgICAgICAgICAnQGxhbmdjaGFpbi9vcGVuYWknLFxuICAgICAgICAgICdAbGFuZ2NoYWluL2FudGhyb3BpYycsXG4gICAgICAgICAgJ0BsYW5nY2hhaW4vY29tbXVuaXR5JyxcbiAgICAgICAgICAnZGF0ZS1mbnMnLFxuICAgICAgICAgICdwbHVyYWxpemUnLFxuICAgICAgICAgICd1dWlkJyxcbiAgICAgICAgICAnQHBhcmFsbGVsZHJpdmUvY3VpZDInLFxuICAgICAgICAgICd5YW1sJyxcbiAgICAgICAgICAnanNkb20nLFxuICAgICAgICAgICdoYXBweS1kb20nLFxuICAgICAgICAgICdheGlvcycsXG4gICAgICAgICAgJ25vZGUtZmV0Y2gnLFxuICAgICAgICAgICdleHByZXNzJyxcbiAgICAgICAgICAnY29ycycsXG4gICAgICAgICAgJ2RvdGVudicsXG4gICAgICAgICAgJ3R5cGVzY3JpcHQnLFxuICAgICAgICAgICdAZ29vZ2xlbWFwcy9nb29nbGUtbWFwcy1zZXJ2aWNlcy1qcycsXG4gICAgICAgICAgJ0Bnb29nbGUtY2xvdWQvdHJhbnNsYXRlJyxcbiAgICAgICAgICAnZGVlcGwtbm9kZScsXG4gICAgICAgICAgJ3JlZGlzJyxcbiAgICAgICAgICAnQG1vZGVsY29udGV4dHByb3RvY29sL3NkaycsXG4gICAgICAgICAgL15AbW9kZWxjb250ZXh0cHJvdG9jb2xcXC8vLFxuICAgICAgICAgICd1bmRpY2knLFxuICAgICAgICAgICd1bnBkZicsXG4gICAgICAgICAgJ3BuZ2pzJyxcbiAgICAgICAgICAnanBlZy1qcycsXG4gICAgICAgICAgJ0BndXRlbnllL29jci1ub2RlJyxcbiAgICAgICAgICAnY29zbWljb25maWcnLFxuICAgICAgICAgICdAbGlic3FsL2NsaWVudCcsXG5cbiAgICAgICAgICAvLyBJbnRlcm5hbCBTTVJUIHBhY2thZ2VzIC0gZXh0ZXJuYWxpemUgdG8gYXZvaWQgY3Jvc3MtcGFja2FnZSBidW5kbGluZ1xuICAgICAgICAgIC9eQHNtcnRcXC8vLFxuXG4gICAgICAgICAgLy8gRXh0ZXJuYWwgU0RLIHBhY2thZ2VzXG4gICAgICAgICAgL15AaGF2ZVxcLy8sXG5cbiAgICAgICAgICAvLyBWaXJ0dWFsIG1vZHVsZXMgZnJvbSBTTVJUIGZyYW1ld29ya1xuICAgICAgICAgICdAc21ydC9yb3V0ZXMnLFxuICAgICAgICAgICdAc21ydC9jbGllbnQnLFxuICAgICAgICAgICdAc21ydC9tY3AnLFxuICAgICAgICAgICdAc21ydC9tYW5pZmVzdCcsXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgICAgbWluaWZ5OiBmYWxzZSwgLy8gS2VlcCBjb2RlIHJlYWRhYmxlIGZvciBsaWJyYXJ5IHVzYWdlXG4gICAgICBzb3VyY2VtYXA6IHRydWUsXG4gICAgICB0YXJnZXQ6ICdlczIwMjInLFxuICAgICAgcmVwb3J0Q29tcHJlc3NlZFNpemU6IGZhbHNlLCAvLyBTcGVlZCB1cCBidWlsZFxuICAgIH0sXG4gICAgcGx1Z2luczogW1xuICAgICAgZHRzKHtcbiAgICAgICAgb3V0RGlyOiByZXNvbHZlKHBhY2thZ2VEaXIsICdkaXN0JyksXG4gICAgICAgIGluY2x1ZGU6IFtyZXNvbHZlKHBhY2thZ2VEaXIsICdzcmMvKiovKi50cycpXSxcbiAgICAgICAgZXhjbHVkZTogW1xuICAgICAgICAgIC8vIFRlc3QgZmlsZXNcbiAgICAgICAgICAnKiovKi50ZXN0LnRzJyxcbiAgICAgICAgICAnKiovKi5zcGVjLnRzJyxcbiAgICAgICAgICAnKiovKi50ZXN0LioudHMnLFxuICAgICAgICAgIC8vIENvbmZpZyBmaWxlc1xuICAgICAgICAgICcqKi8qLmNvbmZpZy50cycsXG4gICAgICAgICAgJyoqLyouY29uZmlnLmpzJyxcbiAgICAgICAgICAvLyBEZWNsYXJhdGlvbiBmaWxlc1xuICAgICAgICAgICcqKi8qLmQudHMnLFxuICAgICAgICBdLFxuICAgICAgICBpbnNlcnRUeXBlc0VudHJ5OiBmYWxzZSwgLy8gV2UgaGFuZGxlIHRoaXMgaW4gcGFja2FnZS5qc29uXG4gICAgICAgIHJvbGx1cFR5cGVzOiBmYWxzZSxcbiAgICAgICAgLy8gVXNlIHBhY2thZ2Utc3BlY2lmaWMgdHNjb25maWdcbiAgICAgICAgdHNjb25maWdQYXRoOiByZXNvbHZlKHBhY2thZ2VEaXIsICd0c2NvbmZpZy5qc29uJyksXG4gICAgICB9KSxcbiAgICBdLFxuICB9KTtcbn1cbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiL1VzZXJzL3dpbGwvV29yay9oYXBweXZlcnRpY2FsL3JlcG9zL3NtcnQvcGFja2FnZXMvYWdlbnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvVXNlcnMvd2lsbC9Xb3JrL2hhcHB5dmVydGljYWwvcmVwb3Mvc21ydC9wYWNrYWdlcy9hZ2VudHMvdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL1VzZXJzL3dpbGwvV29yay9oYXBweXZlcnRpY2FsL3JlcG9zL3NtcnQvcGFja2FnZXMvYWdlbnRzL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsgY3JlYXRlUGFja2FnZUNvbmZpZyB9IGZyb20gJy4uLy4uL3ZpdGUuY29uZmlnLmJhc2UuanMnO1xuXG5leHBvcnQgZGVmYXVsdCBjcmVhdGVQYWNrYWdlQ29uZmlnKCdhZ2VudHMnKTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBdVQsU0FBUyxlQUFlO0FBQy9VLFNBQVMsb0JBQW9CO0FBQzdCLE9BQU8sU0FBUztBQUZoQixJQUFNLG1DQUFtQztBQVlsQyxTQUFTLG9CQUFvQixhQUFxQjtBQUN2RCxRQUFNLGFBQWEsUUFBUSxrQ0FBVyxZQUFZLFdBQVc7QUFFN0QsU0FBTyxhQUFhO0FBQUEsSUFDbEIsT0FBTztBQUFBLE1BQ0wsS0FBSztBQUFBLFFBQ0gsT0FBTyxRQUFRLFlBQVksY0FBYztBQUFBLFFBQ3pDLFNBQVMsQ0FBQyxJQUFJO0FBQUEsUUFDZCxVQUFVLE1BQU07QUFBQSxNQUNsQjtBQUFBLE1BQ0EsZUFBZTtBQUFBLFFBQ2IsUUFBUTtBQUFBLFVBQ04sS0FBSyxRQUFRLFlBQVksTUFBTTtBQUFBLFVBQy9CLFFBQVE7QUFBQSxVQUNSLGlCQUFpQjtBQUFBLFVBQ2pCLGdCQUFnQjtBQUFBLFVBQ2hCLGdCQUFnQjtBQUFBLFFBQ2xCO0FBQUEsUUFDQSxVQUFVO0FBQUE7QUFBQSxVQUVSO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUE7QUFBQSxVQUdBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQTtBQUFBLFVBR0E7QUFBQTtBQUFBLFVBR0E7QUFBQTtBQUFBLFVBR0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUFBLE1BQ0EsUUFBUTtBQUFBO0FBQUEsTUFDUixXQUFXO0FBQUEsTUFDWCxRQUFRO0FBQUEsTUFDUixzQkFBc0I7QUFBQTtBQUFBLElBQ3hCO0FBQUEsSUFDQSxTQUFTO0FBQUEsTUFDUCxJQUFJO0FBQUEsUUFDRixRQUFRLFFBQVEsWUFBWSxNQUFNO0FBQUEsUUFDbEMsU0FBUyxDQUFDLFFBQVEsWUFBWSxhQUFhLENBQUM7QUFBQSxRQUM1QyxTQUFTO0FBQUE7QUFBQSxVQUVQO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQTtBQUFBLFVBRUE7QUFBQSxVQUNBO0FBQUE7QUFBQSxVQUVBO0FBQUEsUUFDRjtBQUFBLFFBQ0Esa0JBQWtCO0FBQUE7QUFBQSxRQUNsQixhQUFhO0FBQUE7QUFBQSxRQUViLGNBQWMsUUFBUSxZQUFZLGVBQWU7QUFBQSxNQUNuRCxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0YsQ0FBQztBQUNIOzs7QUMzSkEsSUFBTyxzQkFBUSxvQkFBb0IsUUFBUTsiLAogICJuYW1lcyI6IFtdCn0K
