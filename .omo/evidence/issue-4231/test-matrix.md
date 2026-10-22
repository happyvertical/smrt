# Participant request intake (#4231)

Risk: tenancy, mutation atomicity/idempotency, nullable integration public contract.

| Behavior/invariant | Trigger | Positive | Negative | Actor/context | Executor/transaction | Runtime/dialect | Edge | Level | Command |
|---|---|---|---|---|---|---|---|---|---|
| Truthful participant provenance | submit | nullable integration, participant history | malformed/empty fields rejected | server-authorized participant | request/history same caller db transaction | SQLite; portable INSERT ON CONFLICT SQL | no provider | integration | projects vitest participant-development-request-service |
| Isolated retry identity | repeated submit | same payload returns same id/history | changed payload conflicts; foreign active tenant denied | actor × tenant/project/requester | PK conflict serialized by database | SQLite | stable request key | integration | same |
| Atomic creation | history insertion fails | request/history commit together | rollback leaves neither | participant | same tx executor | SQLite | storage failure | integration | same |
| Existing managed boundary | managed client | valid authenticated integration remains | capability/requester isolation remains | managed integration | existing executor | SQLite | managed client | integration | projects vitest managed-integration |
| Participant split | triage split | null integration preserved; participant history | repeated split no duplicates | internal triager | existing service transaction caller | SQLite | work adapter N/A split only | integration | projects vitest participant-development-request-service |

Postgres/DuckDB matrix execution is integration-owner responsibility; worker starts no containers. Bug regression N/A additive behavior.
