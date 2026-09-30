---
'@happyvertical/smrt-chat': minor
---

`AssistantDock` can offer the person a few options to pick from. A page
registers an `AssistantChoiceSource` (`createAssistantChoiceSourceRegistry`,
passed as `choiceSources`); each is offered to the model as the read tool
`assistant_offer_<id>`. The source builds 1–4 options, the dock shows them as
picture cards in the chat, and only the person's click applies one through the
source's `apply`. Card images are limited to same-origin paths. See
`docs/assistant-dock.md` ("Choices").
