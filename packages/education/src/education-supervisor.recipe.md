# Homeschool groups

Compose `education.supervisor` with the education learner workflow to manage
independent group tenants and parent-approved links to existing family learners.
Recipe discovery supplies models and navigation metadata; it grants no generated
CRUD or family access.

Hosts use the closed group sharing services with a live session authorizer on
the supplied database executor. Supervisors remain group members, never family
guardians. A parent must choose an explicit sharing policy when accepting a
targeted invitation. Work, revisions, source bytes and comment attribution remain
family-owned after leaving a group.

Every roster, work, revision, media, comment and progress request must check
current authority and policy. Serve media through the authorized reader and a
private, non-cacheable host response; never publish storage URLs. Saved parent
comment visibility defaults to parent-only. Supervisor comments cannot grade or
change learning evidence.

See the shipped `agents/group-sharing.md` contract for selectors, facet semantics,
transaction requirements and migration expectations.
