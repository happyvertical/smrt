# Issue 4615 (converter and Office members) test contract

Risk standard. The untrusted-file boundary is the converter service; in-process
parsing is limited to the bounded zip checks already used for bundles. Design:
[course bundle import](../../packages/education/agents/course-bundle-import.md#word-and-powerpoint-members-smrt-4615).
Manifest version 2 and material roles are out of scope (smrt#4614).

| behavior | positive | failure | level | command |
|---|---|---|---|---|
| OOXML classification | docx/pptx by name and content | wrong extension, wrong main part, legacy binary, zip bomb or traversal inside the package -> unsupported/refused, converter never called | unit | `pnpm --filter @happyvertical/smrt-education test` (`course-bundle-office-classify.test.ts`) |
| render and hand-off | original + rendered PDF + text to `receiveMember`, hash/size evidence, neutral file name, no bytes in views | N/A | integration (SQLite) | `course-bundle-office.test.ts` |
| fail closed | N/A | no converter, each converter failure code, thrown error, oversize output, non-PDF/encrypted/empty output, ignored abort, Office member limit, unauthorized actor | integration | same |
| text reader | slides and notes passed through | reader throws -> member keeps its pages | integration | same |
| proposal | Office text never in lesson bodies | failed member is no lesson | integration | same |
| replay and duplicates | identical documents rendered once; recorded failures not retried; accepted members re-rendered | replay that cannot render throws | integration | same |
| Gotenberg adapter | multipart POST, base path, https | 4xx/5xx mapping, non-PDF, input/response caps (header and stream), network error, timeout, bad config | unit (injected fetch) | `document-converter.test.ts` |
| limits | host may only lower Office limits | raising ignored | unit | `course-bundle-office-classify.test.ts` |
