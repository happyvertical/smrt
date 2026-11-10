# Packed producer isolation (#4003)

The real packed MCP regression executes normal core prepack during root tests.
Previously that hook rebuilt the live producer and temporarily removed its dist,
causing parallel package imports to fail. This tracked readiness fix is included
in PR4000 under the user's single-PR override.

| Invariant | Trigger | Positive case | Negative case | Actor/context | Executor | Runtime | External edge | Level | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| Packing does not mutate live producer output | Packed MCP test during root tests | Artifact mtime unchanged; observer continuously sees database.js | Old helper deletes artifact and changes mtime | Local developer/root suite | Normal prepack in copied producer workspace | Pinned Node/pnpm | Real package lifecycle | Integration | mcp-get-serializer-packed-consumer.test.ts and observer logs |
| Packed consumer cannot borrow producer types | Strict declaration verification | Both Bundler and NodeNext compile installed tarballs | Existing negative type assertions reject any/unresolved types | Separate consumer directory | Real pnpm pack/install/tsc | Pinned Node/pnpm | Installed external dependencies | Integration | verify-packed-declarations.mjs |
| Workspace dependency closure stays usable | Core/profiles/inventory packaging | Required workspace packages packed from copies with internal links retargeted | Missing package fails closed | Trusted repository build inputs | Copied root configs/scripts; external installed tools shared read-only by convention | Node | Fixture disables pnpm relinking, not lifecycle scripts | Integration | Packed declarations and actual prepack logs |
| Cleanup and release behavior | Success or failed packaging | Temporary producer removed; ordinary prepack unchanged | Failure propagates; no CI/VITEST exception | Test/tooling caller | try/finally cleanup | Node filesystem | Consumer remains outside producer node_modules ancestry | Integration | Helper implementation and full root tests |

The helper does not sandbox arbitrary repository scripts. Lifecycle scripts are
trusted code; copied workspace packages own their build outputs. No production
prepack flag, hook skip, concurrency override, or cache deletion is introduced.
