---
id: TASK-004
type: task
title: "Add an auditable residency verification decision path"
status: testing
storyId: US-008
priority: high
dependsOn: TASK-001
created: 2026-10-04
---

## Outcome

Verified residency records include a reviewed decision and can be used by the
eligibility rule without direct database seeding.

## Acceptance Criteria

- Only an active reviewer may record a residency decision.
- A decision records the reviewer and timestamp, and is immutable.
- The decision emits an audit event without residency evidence.
