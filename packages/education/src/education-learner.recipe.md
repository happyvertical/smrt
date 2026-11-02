# Learners

Use `LearnerService` in an authenticated exact-tenant context to read a learner,
plan a curriculum as an authorized guardian, enroll in a visible course, start,
put back or complete a lesson, set an enrollment's weekly pace, and start, pause, resume or drop an enrollment. Recipe
metadata does not expose model CRUD. Hosts authenticate users, provision family
membership, and validate guardian ProfileRelationship types and effective
terms. `TutorContextService` and `TutorSessionService` give a host a bounded
learner-safe tutor context and append-only transcripts. See `agents/learner-service.md`
and `agents/tutor-context.md` for the boundaries.
