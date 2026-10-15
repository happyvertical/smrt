# Learners

Use `LearnerService` in an authenticated exact-tenant context to read a learner,
plan a curriculum as an authorized guardian, enroll in a visible course, and
start a lesson. Recipe metadata does not expose model CRUD. Hosts authenticate
users, provision family membership, and validate guardian ProfileRelationship
types and effective terms. See `agents/learner-service.md` for the boundary.
