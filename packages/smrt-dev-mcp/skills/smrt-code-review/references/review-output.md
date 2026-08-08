# SMRT Review Output

Use this stricter template when the user asks for a formal review.

## Findings

List findings first, ordered by severity. Each finding should include:

- severity: blocker, high, medium, or low
- file and line reference when available
- the concrete bug, regression, or risk
- why it matters in SMRT terms
- the smallest practical fix or validation path

## Open Questions

Include only questions that block a correct review or implementation decision.

## Validation

State which checks were run or which checks are still needed. For SMRT doc,
package, or expertise changes, include deterministic knowledge freshness:

```bash
pnpm knowledge:check --strict --format markdown
```

## Summary

Keep the summary brief and secondary. Do not let a summary hide unresolved
findings.
