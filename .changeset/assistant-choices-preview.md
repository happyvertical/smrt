---
'@happyvertical/smrt-chat': minor
---

Choice offers can be previewed before they are applied. A source that implements `preview` shows a clicked card in place on the page without applying it; another click swaps the preview, the offer's `original` card puts the page back, and only the primary button (`commitOption`) applies the previewed option and resolves the offer. Cancel (`cancelChoices`), Escape, dismissing, clearing and disposing restore the original. Sources without `preview` keep "click applies". `AssistantChoiceCards` takes `onpreview`, `oncommit` and `oncancel`; the dock controller gains `previewOption`, `commitOption` and `cancelChoices`. Previews run one at a time in click order: while one is being shown the cards and the commit button wait (`previewPendingId` on the offer), a superseded queued preview never reaches the page, a restore waits for a preview still running, and `commitOption` does nothing until the page shows the option it would apply.
