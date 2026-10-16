---
id: TASK-005
type: task
title: "Issue vote eligibility tokens from jurisdiction rules"
status: done
storyId: US-031
priority: high
dependsOn: TASK-004
created: 2026-10-04
---

## Outcome

Voting derives eligible citizens from verified residency, membership, and the
proposal jurisdiction rather than trusting a caller-supplied list.

## Verification

BUG-005 implements the signed, bounded roster source. Real Postgres eligibility
tests exclude pending, unverified, recent, non-member and suspended citizens.
