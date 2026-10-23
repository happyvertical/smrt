# @happyvertical/smrt-reactions

The model-only root exports models/collections/types; `/server` exports ParticipationRuntime. Its factory owns SQLite/PostgreSQL connections and returns reaction/poll services that require trusted host actor/profile binding and record authorization. ParticipationService from smrt-comments/participation exclusively owns entitlement, bans and quota; mutations share its transaction. DuckDB is refused before open pending SDK #1452. Models require package-private executor-bound write authority (unique transaction executors only) and disable generated mutation endpoints: hosts call services. PollVote rows retain immutable snapshot evidence; never amend a recorded vote or poll options. Svelte receives authorized projections/callbacks, never credentials or actor lists.

Run package `test`, `typecheck`, `check`, `build`; PostgreSQL CI uses `test:postgres`. See README.md and agents/test-design.md.
