---
'@happyvertical/smrt-chat': minor
---

Choice offers can be previewed before they are applied. A source that implements `preview` shows a clicked card in place on the page without applying it; another click swaps the preview, the offer's `original` card puts the page back, and only the primary button (`commitOption`) applies the previewed option and resolves the offer. Cancel (`cancelChoices`), Escape, dismissing, clearing and disposing restore the original. Sources without `preview` keep "click applies". `AssistantChoiceCards` takes `onpreview`, `oncommit` and `oncancel`; the dock controller gains `previewOption`, `commitOption` and `cancelChoices`.
