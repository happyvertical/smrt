---
'@happyvertical/smrt-agents': patch
---

Refactor agent identity and summary method handling so agent-specific methods
like `summaryArticle()` remain opt-in prototype methods instead of base-class
properties. This release also makes `manageProcessSignals` explicitly opt-in;
single-agent CLIs can enable it, while multi-agent hosts should coordinate
shutdown themselves.
