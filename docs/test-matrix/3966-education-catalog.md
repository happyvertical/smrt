# #3966 education catalog test matrix

| Behavior / invariant | Trigger | Positive / negative evidence | Actor / transaction | Dialect / edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| Catalog STI and ordered structure | Save each course and lesson subtype with section order | Hydrates correct subtype; invalid cross-package asset reference is rejected by schema metadata | Authorized package setup; collection executor | SQLite + PostgreSQL; generated model manifest | Integration; package test / test:postgres |
| Asset ownership | Link printable, video, attachment, and answer-key through `LessonAsset` | One relationship row per lesson/asset; no Lesson asset-id field | Catalog author; collection executor | SQLite + PostgreSQL; asset cross-package ref | Integration; package test / test:postgres |
| Authorized catalog generation boundary | Attempt generated model read/write or invoke service | Models expose no generated operations; true authorization enters allowlisted catalog list scope; false/throw denies | Family tenant actor | Node; REST/CLI/MCP/AI contract closed | Unit + integration; package test |
| Family → group → global visibility | Scope family catalog list with ancestors | Self, ancestor, and global rows returned; sibling/descendant rows and get/write/raw access stay denied | Authorized family actor / scoped list only | SQLite + PostgreSQL; tenancy interface | Integration; package test / test:postgres |
| Private materials | personal-use-copy course or answer-key asset | No recipe/public model surface; learner-facing service request cannot enumerate it without host authorizer | Family vs learner actor | Node; serialized/generated boundary | Unit; package test |
