---
type: Capability Map
title: From reusable components to a business system
description: Business needs mapped to the component families already visible in source.
tags: []
status: draft
generated:
  by: claude/smrt-4688
  at: '2026-11-05T00:00:00Z'
stale_after: '2027-02-03T00:00:00Z'
audience: internal
previous_ids:
- /capabilities.md
sources:
- id: core
  resource: https://github.com/happyvertical/smrt/blob/78403aeaeec8d36bd76934139a030bd75d001275/packages/core/src/index.ts
  path: packages/core/src/index.ts
  source_revision: 78403aeaeec8d36bd76934139a030bd75d001275
  title: SMRT core exports
- id: overview
  resource: https://github.com/happyvertical/smrt/blob/78403aeaeec8d36bd76934139a030bd75d001275/README.md
  path: README.md
  source_revision: 78403aeaeec8d36bd76934139a030bd75d001275
  title: SMRT framework overview
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/capabilities.md
  path: docs/knowledge/ecosystem/capabilities.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/capabilities.md (commit 4da258f6eb)
---

# How the pieces fit

s-m-r-t provides typed domain objects and application machinery for persistence, schemas, APIs, command-line tools and agent-facing tools. Exposure is configured per object and operation through its `api`, `mcp` and `cli` settings; state them explicitly (`include: []` fails closed) rather than assuming an object is private.[^core][^overview]

The SDK (documented in happyvertical.com) supplies provider interfaces underneath the framework. Business domain packages supply models and operations; application code supplies the specific workflow, interface, authorization, integrations and operating environment. The starter (described in happyvertical.com) illustrates one application composition.

# Find components by business need

| Need | Starting components | Recipe |
| --- | --- | --- |
| Customer enquiries and follow-up | Profiles, sales, messages, jobs, agents | [Customer follow-up](/solutions/customer-followup.md) |
| Repeated document reading and entry | Content, assets, facts, jobs; PDF/OCR where needed | [Document intake](/solutions/documents.md) |
| Requests and escalations | Support, messages, profiles, jobs | [Support triage](/solutions/support.md) |
| Public website or content workflow | Sites, content, assets, web templates and UI | [Website content](/solutions/website-content.md) |
| Product and stock records | Products, inventory, commerce, ledgers | [Stock operations](/solutions/stock.md) |
| Time and receipt administration | Timesheets, expenses, HR, projects, commerce | [Time and expenses](/solutions/time-and-expenses.md) |
| Campaign preparation | Marketing, content, social, analytics | [Marketing](/solutions/marketing.md) |
| Repeated reports | Reports, facts, ledgers, jobs | [Operational reports](/solutions/operations-report.md) |
| Member/customer access | Users, tenancy, subscriptions, features, UI | [Member portal](/solutions/membership.md) |

Each recipe links to the specific component evidence and describes integration still required. These are starting points for discovery, not a price list or a claim that finished applications already exist.

# Agent-assisted work

[Agents](/components/smrt-agents.md), [jobs](/components/smrt-jobs.md), [prompts](/components/smrt-prompts.md), [playbooks](/components/smrt-playbooks.md), and the tool surfaces provide orchestration building blocks. The application still decides what an agent may access, which actions require a person, how retries affect side effects, and who handles failures.

# What to demonstrate

Pick one actual workflow, connect its inputs and outputs, retain a human approval step where appropriate, and measure how much manual effort it removes. Anytown and the ecosystem references (kept in happyvertical.com) are implementation evidence for discussing composition, not substitutes for the customer's own acceptance test.

[^core]: Core exports at the pinned SMRT revision.
[^overview]: Framework architecture and exposure conventions.
